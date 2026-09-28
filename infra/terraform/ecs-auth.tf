resource "aws_service_discovery_service" "auth_svc" {
  name = "auth"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.internal.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

resource "aws_iam_role" "auth_task" {
  name               = "${local.name_prefix}-auth-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

# auth-svc has no other task-role permissions of its own (unlike
# gateway/video, it never touches S3) — this role exists solely to carry the
# ADOT sidecar's X-Ray permissions.
resource "aws_iam_role_policy" "auth_task_xray" {
  name   = "${local.name_prefix}-auth-task-xray"
  role   = aws_iam_role.auth_task.id
  policy = data.aws_iam_policy_document.xray_write.json
}

resource "aws_ecs_task_definition" "auth_svc" {
  family                   = "${local.name_prefix}-auth-svc"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.auth_task_cpu
  memory                   = var.auth_task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.auth_task.arn

  container_definitions = jsonencode([
    {
      name        = "auth-svc"
      image       = "${aws_ecr_repository.auth_svc.repository_url}:${var.auth_svc_image_tag}"
      essential   = true
      stopTimeout = 30
      portMappings = [
        { containerPort = 50053, protocol = "tcp" },
      ]
      environment = [
        { name = "MAIL_FROM", value = "VidForge <no-reply@${var.domain_name}>" },
        { name = "WEB_ORIGIN", value = "https://${var.domain_name}" },
        # The viewer portal's own subdomain — used to build viewer invite
        # activation links, which must not point at the staff app.
        { name = "VIEWER_ORIGIN", value = "https://viewer.${var.domain_name}" },
        # ADOT sidecar, same task — see the container definition below.
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "http://localhost:4318" },
      ]
      secrets = [
        { name = "JWT_SECRET", valueFrom = aws_secretsmanager_secret.jwt_secret.arn },
        { name = "JWT_SECRET_PREVIOUS", valueFrom = aws_secretsmanager_secret.jwt_secret_previous.arn },
        { name = "CONTEXT_SIGNING_SECRET", valueFrom = aws_secretsmanager_secret.context_signing_secret.arn },
        { name = "CONTEXT_SIGNING_SECRET_PREVIOUS", valueFrom = aws_secretsmanager_secret.context_signing_secret_previous.arn },
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
        { name = "SMTP_URL", valueFrom = aws_secretsmanager_secret.smtp_url.arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.auth_svc.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "auth-svc"
        }
      }
    },
    {
      name      = "aws-otel-collector"
      image     = local.adot_collector_image
      essential = false # telemetry is best-effort; a sidecar crash shouldn't take auth-svc down with it.
      environment = [
        { name = "AOT_CONFIG_CONTENT", value = local.adot_collector_config },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.auth_svc.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "adot"
        }
      }
    }
  ])

  tags = {
    Name = "${local.name_prefix}-auth-svc"
  }
}

resource "aws_ecs_service" "auth_svc" {
  name            = "${local.name_prefix}-auth-svc"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.auth_svc.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.auth_svc.arn
  }

  depends_on = [aws_iam_role_policy.execution]

  # See ecs-web.tf's identical lifecycle block for why.
  lifecycle {
    ignore_changes = [task_definition]
  }

  tags = {
    Name = "${local.name_prefix}-auth-svc"
  }
}
