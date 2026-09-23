resource "aws_service_discovery_service" "video_svc" {
  name = "video"

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

resource "aws_iam_role" "video_api_task" {
  name               = "${local.name_prefix}-video-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "video_api_task" {
  statement {
    sid = "MediaBucketObjects"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:HeadObject",
      "s3:DeleteObject",
    ]
    resources = ["${aws_s3_bucket.media.arn}/*"]
  }

  statement {
    sid       = "MediaBucketList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.media.arn]
  }
}

resource "aws_iam_role_policy" "video_api_task" {
  name   = "${local.name_prefix}-video-api-task"
  role   = aws_iam_role.video_api_task.id
  policy = data.aws_iam_policy_document.video_api_task.json
}

resource "aws_ecs_task_definition" "video_svc_api" {
  family                   = "${local.name_prefix}-video-svc-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.video_api_task_cpu
  memory                   = var.video_api_task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.video_api_task.arn

  container_definitions = jsonencode([
    {
      name        = "video-svc-api"
      image       = "${aws_ecr_repository.video_svc_api.repository_url}:${var.video_svc_api_image_tag}"
      essential   = true
      stopTimeout = 30
      portMappings = [
        { containerPort = 50051, protocol = "tcp" },
      ]
      environment = [
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
          "awslogs-group"         = aws_cloudwatch_log_group.video_svc_api.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "video-svc-api"
        }
      }
    }
  ])

  tags = {
    Name = "${local.name_prefix}-video-svc-api"
  }
}

resource "aws_ecs_service" "video_svc_api" {
  name            = "${local.name_prefix}-video-svc-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.video_svc_api.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.video_svc.arn
  }

  depends_on = [aws_iam_role_policy.execution]

  tags = {
    Name = "${local.name_prefix}-video-svc-api"
  }
}

resource "aws_iam_role" "worker_task" {
  name               = "${local.name_prefix}-worker-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "worker_task" {
  statement {
    sid = "MediaBucketObjects"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:HeadObject",
      "s3:DeleteObject",
    ]
    resources = ["${aws_s3_bucket.media.arn}/*"]
  }

  statement {
    sid       = "MediaBucketList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.media.arn]
  }

  statement {
    sid       = "QueueDepthMetric"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"] # PutMetricData has no resource-level permissions; scoped by the condition below instead.

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["VidForge/Queue"]
    }
  }
}

resource "aws_iam_role_policy" "worker_task" {
  name   = "${local.name_prefix}-worker-task"
  role   = aws_iam_role.worker_task.id
  policy = data.aws_iam_policy_document.worker_task.json
}

resource "aws_ecs_task_definition" "transcode_worker" {
  family                   = "${local.name_prefix}-transcode-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_task_cpu
  memory                   = var.worker_task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.worker_task.arn

  container_definitions = jsonencode([
    {
      name        = "transcode-worker"
      image       = "${aws_ecr_repository.video_svc_worker.repository_url}:${var.video_svc_worker_image_tag}"
      essential   = true
      stopTimeout = 120
      environment = [
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
          "awslogs-group"         = aws_cloudwatch_log_group.transcode_worker.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "worker"
        }
      }
    }
  ])

  tags = {
    Name = "${local.name_prefix}-transcode-worker"
  }
}

resource "aws_ecs_service" "transcode_worker" {
  name            = "${local.name_prefix}-transcode-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.transcode_worker.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  depends_on = [aws_iam_role_policy.execution]

  # Task 11's Application Auto Scaling policy changes desired_count out of
  # band; without this, a later `terraform apply` would fight the scaler
  # and reset it back to 1.
  lifecycle {
    ignore_changes = [desired_count]
  }

  tags = {
    Name = "${local.name_prefix}-transcode-worker"
  }
}
