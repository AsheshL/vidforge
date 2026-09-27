resource "aws_security_group_rule" "app_from_alb_web" {
  type                     = "ingress"
  from_port                = 3000
  to_port                  = 3000
  protocol                 = "tcp"
  security_group_id        = aws_security_group.app.id
  source_security_group_id = aws_security_group.alb.id
  description              = "ALB - web."
}

resource "aws_iam_role" "web_task" {
  name               = "${local.name_prefix}-web-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

# web has no other task-role permissions of its own — this role exists
# solely to carry the ADOT sidecar's X-Ray permissions.
resource "aws_iam_role_policy" "web_task_xray" {
  name   = "${local.name_prefix}-web-task-xray"
  role   = aws_iam_role.web_task.id
  policy = data.aws_iam_policy_document.xray_write.json
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name_prefix}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.web_task_cpu
  memory                   = var.web_task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.web_task.arn

  container_definitions = jsonencode([
    {
      name        = "web"
      image       = "${aws_ecr_repository.web.repository_url}:${var.web_image_tag}"
      essential   = true
      stopTimeout = 30
      portMappings = [
        { containerPort = 3000, protocol = "tcp" },
      ]
      environment = [
        # ADOT sidecar, same task — see the container definition below.
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "http://localhost:4318" },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.web.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "web"
        }
      }
    },
    {
      name      = "aws-otel-collector"
      image     = local.adot_collector_image
      essential = false # telemetry is best-effort; a sidecar crash shouldn't take web down with it.
      environment = [
        { name = "AOT_CONFIG_CONTENT", value = local.adot_collector_config },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.web.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "adot"
        }
      }
    }
  ])

  tags = {
    Name = "${local.name_prefix}-web"
  }
}

resource "aws_ecs_service" "web" {
  name            = "${local.name_prefix}-web"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.web.arn
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

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }

  # CI (infra/scripts/ecs-register-revision.sh) registers new revisions and
  # updates the service directly rather than running `terraform apply` (see
  # docs/backlog.md's "Deploy through Terraform" item). Without this, the
  # next `terraform apply` from a workstation would roll a CI-deployed
  # image back to whatever *_image_tag var it was last run with.
  lifecycle {
    ignore_changes = [task_definition]
  }

  depends_on = [aws_lb_listener.http, aws_iam_role_policy.execution]

  tags = {
    Name = "${local.name_prefix}-web"
  }
}
