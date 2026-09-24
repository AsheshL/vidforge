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

resource "aws_ecs_task_definition" "auth_svc" {
  family                   = "${local.name_prefix}-auth-svc"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.auth_task_cpu
  memory                   = var.auth_task_memory
  execution_role_arn       = aws_iam_role.execution.arn

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
      ]
      secrets = [
        { name = "JWT_SECRET", valueFrom = aws_secretsmanager_secret.jwt_secret.arn },
        { name = "CONTEXT_SIGNING_SECRET", valueFrom = aws_secretsmanager_secret.context_signing_secret.arn },
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

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.auth_svc.arn
  }

  depends_on = [aws_iam_role_policy.execution]

  tags = {
    Name = "${local.name_prefix}-auth-svc"
  }
}
