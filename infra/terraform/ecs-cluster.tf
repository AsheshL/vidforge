resource "aws_ecs_cluster" "main" {
  name = local.name_prefix

  setting {
    name  = "containerInsights"
    value = "disabled"
  }

  tags = {
    Name = local.name_prefix
  }
}

resource "aws_service_discovery_private_dns_namespace" "internal" {
  name = "vidforge.local"
  vpc  = aws_vpc.main.id
}

resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/${local.name_prefix}/web"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "api_gateway" {
  name              = "/ecs/${local.name_prefix}/api-gateway"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "auth_svc" {
  name              = "/ecs/${local.name_prefix}/auth-svc"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "video_svc_api" {
  name              = "/ecs/${local.name_prefix}/video-svc-api"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "transcode_worker" {
  name              = "/ecs/${local.name_prefix}/transcode-worker"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "migrate" {
  name              = "/ecs/${local.name_prefix}/migrate"
  retention_in_days = 14
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name_prefix}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "execution" {
  statement {
    sid       = "ECRAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "ECRImagePull"
    actions = [
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [
      aws_ecr_repository.web.arn,
      aws_ecr_repository.api_gateway.arn,
      aws_ecr_repository.auth_svc.arn,
      aws_ecr_repository.video_svc_api.arn,
      aws_ecr_repository.video_svc_worker.arn,
    ]
  }

  statement {
    sid = "Logs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "${aws_cloudwatch_log_group.web.arn}:*",
      "${aws_cloudwatch_log_group.api_gateway.arn}:*",
      "${aws_cloudwatch_log_group.auth_svc.arn}:*",
      "${aws_cloudwatch_log_group.video_svc_api.arn}:*",
      "${aws_cloudwatch_log_group.transcode_worker.arn}:*",
      "${aws_cloudwatch_log_group.migrate.arn}:*",
    ]
  }

  statement {
    sid     = "Secrets"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.jwt_secret.arn,
      aws_secretsmanager_secret.context_signing_secret.arn,
      aws_secretsmanager_secret.database_url.arn,
      aws_secretsmanager_secret.smtp_url.arn,
    ]
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "${local.name_prefix}-ecs-execution"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

# Internal gRPC calls between tasks (gateway -> auth-svc, gateway ->
# video-svc) flow through the shared app SG via Cloud Map — without these,
# tasks could reach the ALB but not each other.
resource "aws_security_group_rule" "app_internal_grpc_video" {
  type                     = "ingress"
  from_port                = 50051
  to_port                  = 50051
  protocol                 = "tcp"
  security_group_id        = aws_security_group.app.id
  source_security_group_id = aws_security_group.app.id
  description              = "Internal gRPC: gateway to video-svc"
}

resource "aws_security_group_rule" "app_internal_grpc_auth" {
  type                     = "ingress"
  from_port                = 50053
  to_port                  = 50053
  protocol                 = "tcp"
  security_group_id        = aws_security_group.app.id
  source_security_group_id = aws_security_group.app.id
  description              = "Internal gRPC: gateway to auth-svc"
}

# --- OpenTelemetry: ADOT collector sidecar ---
#
# Every ECS task in this system (web, api-gateway, auth-svc, video-svc-api,
# transcode-worker) gets a second container running the AWS Distro for
# OpenTelemetry Collector, receiving OTLP from the app container over
# `localhost` — Fargate `awsvpc` mode puts every container in a task on the
# same network namespace, so that's really "the sidecar", not "this
# container" — and exporting to X-Ray. Shared here (like `execution` above)
# rather than duplicated per service file.
#
# xray:PutTraceSegments/PutTelemetryRecords have no resource-level
# permissions (same shape as the worker's CloudWatch PutMetricData grant in
# ecs-video.tf), so this is attached to every task role as its own
# `aws_iam_role_policy`, one per service, rather than folded into each
# service's own policy document.
data "aws_iam_policy_document" "xray_write" {
  statement {
    sid = "XRayWrite"
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
    ]
    resources = ["*"]
  }
}

# Inline collector config, passed to the container via the AOT_CONFIG_CONTENT
# env var (the ADOT collector's supported alternative to mounting a config
# file — there's nowhere to mount one from here). Receives OTLP/HTTP on 4318
# (every VidForge service exports over OTLP/HTTP — see
# packages/otel/src/index.ts and apps/web/instrumentation.ts) and OTLP/gRPC
# on 4317 too, in case that's ever needed without touching this config again.
locals {
  adot_collector_config = <<-YAML
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318
    processors:
      batch:
        timeout: 5s
    exporters:
      awsxray:
        region: ${var.aws_region}
    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [batch]
          exporters: [awsxray]
  YAML

  # v0.50.0 is the newest tag public.ecr.aws/aws-observability/aws-otel-collector
  # published as of writing. Pinned rather than `:latest` so a task
  # definition only changes when this is bumped on purpose; re-check for a
  # newer stable tag before this is ever actually deployed.
  adot_collector_image = "public.ecr.aws/aws-observability/aws-otel-collector:v0.50.0"
}
