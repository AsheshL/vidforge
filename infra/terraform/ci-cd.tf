# GitHub Actions -> AWS via OIDC (docs/aws-deployment.md's CI/CD section):
# no long-lived AWS keys in repository secrets. The trust policy restricts
# this role to workflow runs on this exact repo's main branch.
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1", "1c58a3a8518e8759bf075b76b750d4f2df264fcd"]
}

data "aws_iam_policy_document" "github_deploy_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name               = "${local.name_prefix}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_deploy_assume.json
}

# Deliberately does not touch Terraform state or need terraform in CI at
# all: state is local-only (docs/backlog.md's "Terraform remote state"
# item), so this role's permissions cover exactly what
# infra/scripts/ecs-register-revision.sh and the deploy workflow call —
# ECR push, register a new task-definition revision, point a service or
# a one-off migration run-task at it.
data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid       = "ECRAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "ECRPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
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
    sid = "ECSTaskDefinitions"
    actions = [
      "ecs:DescribeTaskDefinition",
      "ecs:RegisterTaskDefinition",
    ]
    # ECS doesn't support resource-level restriction on these two actions.
    resources = ["*"]
  }

  statement {
    sid     = "ECSDeploy"
    actions = ["ecs:UpdateService", "ecs:DescribeServices"]
    resources = [
      aws_ecs_service.web.id,
      aws_ecs_service.api_gateway.id,
      aws_ecs_service.auth_svc.id,
      aws_ecs_service.video_svc_api.id,
      aws_ecs_service.transcode_worker.id,
    ]
  }

  statement {
    sid       = "ECSMigrationRun"
    actions   = ["ecs:RunTask"]
    resources = ["arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name_prefix}-migrate:*"]
  }

  statement {
    sid       = "ECSMigrationWait"
    actions   = ["ecs:DescribeTasks"]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }

  statement {
    sid     = "PassTaskRoles"
    actions = ["iam:PassRole"]
    # RegisterTaskDefinition needs PassRole on both executionRoleArn (every
    # task def) and taskRoleArn (only set on api-gateway/video-svc-api/
    # transcode-worker — web/auth-svc/migrate have none). Found this the
    # hard way: the first real CI deploy run failed on exactly this,
    # having only granted the execution role.
    resources = [
      aws_iam_role.execution.arn,
      aws_iam_role.gateway_task.arn,
      aws_iam_role.video_api_task.arn,
      aws_iam_role.worker_task.arn,
    ]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "${local.name_prefix}-github-deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}

data "aws_caller_identity" "current" {}
