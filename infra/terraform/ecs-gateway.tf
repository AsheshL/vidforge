resource "aws_security_group_rule" "app_from_alb_gateway" {
  type                     = "ingress"
  from_port                = 4000
  to_port                  = 4000
  protocol                 = "tcp"
  security_group_id        = aws_security_group.app.id
  source_security_group_id = aws_security_group.alb.id
  description               = "ALB - api-gateway"
}

resource "aws_iam_role" "gateway_task" {
  name               = "${local.name_prefix}-gateway-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "gateway_task" {
  statement {
    sid = "MediaBucketObjects"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:HeadObject",
    ]
    resources = ["${aws_s3_bucket.media.arn}/*"]
  }

  statement {
    sid       = "MediaBucketList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.media.arn]
  }
}

resource "aws_iam_role_policy" "gateway_task" {
  name   = "${local.name_prefix}-gateway-task"
  role   = aws_iam_role.gateway_task.id
  policy = data.aws_iam_policy_document.gateway_task.json
}

resource "aws_ecs_task_definition" "api_gateway" {
  family                   = "${local.name_prefix}-api-gateway"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.gateway_task_cpu
  memory                   = var.gateway_task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn             = aws_iam_role.gateway_task.arn

  container_definitions = jsonencode([
    {
      name        = "api-gateway"
      image       = "${aws_ecr_repository.api_gateway.repository_url}:${var.api_gateway_image_tag}"
      essential   = true
      stopTimeout = 30
      portMappings = [
        { containerPort = 4000, protocol = "tcp" },
      ]
      environment = [
        { name = "AUTH_SVC_ADDR", value = "auth.vidforge.local:50053" },
        { name = "VIDEO_SVC_ADDR", value = "video.vidforge.local:50051" },
        { name = "WEB_ORIGIN", value = "http://${aws_lb.main.dns_name}" },
        { name = "TRUST_PROXY", value = "true" },
        { name = "RATE_LIMIT_REDIS_URL", value = "redis://${aws_elasticache_cluster.main.cache_nodes[0].address}:6379" },
        { name = "S3_BUCKET", value = aws_s3_bucket.media.bucket },
        { name = "S3_REGION", value = var.aws_region },
      ]
      secrets = [
        { name = "CONTEXT_SIGNING_SECRET", valueFrom = aws_secretsmanager_secret.context_signing_secret.arn },
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.api_gateway.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "api-gateway"
        }
      }
    }
  ])

  tags = {
    Name = "${local.name_prefix}-api-gateway"
  }
}

resource "aws_ecs_service" "api_gateway" {
  name            = "${local.name_prefix}-api-gateway"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api_gateway.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api_gateway.arn
    container_name    = "api-gateway"
    container_port    = 4000
  }

  depends_on = [aws_lb_listener.http, aws_iam_role_policy.execution]

  tags = {
    Name = "${local.name_prefix}-api-gateway"
  }
}
