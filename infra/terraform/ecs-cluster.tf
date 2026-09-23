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
