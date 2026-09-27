resource "random_password" "jwt_secret" {
  length  = 48
  special = false
}

resource "random_password" "context_signing_secret" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "jwt_secret" {
  name = "${local.name_prefix}/jwt-secret"
}

resource "aws_secretsmanager_secret_version" "jwt_secret" {
  secret_id     = aws_secretsmanager_secret.jwt_secret.id
  secret_string = random_password.jwt_secret.result
}

resource "aws_secretsmanager_secret" "context_signing_secret" {
  name = "${local.name_prefix}/context-signing-secret"
}

resource "aws_secretsmanager_secret_version" "context_signing_secret" {
  secret_id     = aws_secretsmanager_secret.context_signing_secret.id
  secret_string = random_password.context_signing_secret.result
}

# --- Secret rotation support -------------------------------------------------
#
# jwt_secret and context_signing_secret above are generated once and have no
# rotation path: replacing either value in place would immediately invalidate
# every session token / RequestContext signature already in flight, since a
# new value doesn't land on every ECS task at the same instant.
#
# The `*_previous` secrets below hold the prior value of each secret during a
# rotation window. Both the app code (packages/svc-auth's verifyContext,
# apps/auth-svc's verifyJwt) and every ECS task definition that injects these
# secrets (ecs-auth.tf, ecs-gateway.tf, ecs-video.tf) read a "current" and an
# optional "previous" env var, trying current first and falling back to
# previous. Signing/issuing always uses only the current value.
#
# Terraform never populates the `_previous` value itself — each starts as an
# empty string (the verifiers treat empty as "not set" and skip the fallback)
# and is only ever written out-of-band via the AWS CLI. `ignore_changes`
# below stops a routine `terraform apply` from clobbering whatever a human
# put there back to empty mid-rotation.
#
# Manual rotation procedure (see infra/terraform/README-secret-rotation.md
# for the full write-up):
#   1. Copy the CURRENT secret value into the matching `*-previous` secret
#      (`aws secretsmanager get-secret-value` + `put-secret-value`).
#   2. Generate a new value and write it into the current secret
#      (`put-secret-value`, or `terraform apply -replace=random_password.<x>`).
#   3. Redeploy every service that consumes the secret so they all pick up
#      the new current value and start accepting both old and new.
#   4. Once the rollout window has passed (5 minutes for RequestContext, up
#      to the 8h JWT TTL for session tokens), clear the `*-previous` secret
#      back to an empty string.

resource "aws_secretsmanager_secret" "jwt_secret_previous" {
  name = "${local.name_prefix}/jwt-secret-previous"
}

resource "aws_secretsmanager_secret_version" "jwt_secret_previous" {
  secret_id     = aws_secretsmanager_secret.jwt_secret_previous.id
  secret_string = ""

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "context_signing_secret_previous" {
  name = "${local.name_prefix}/context-signing-secret-previous"
}

resource "aws_secretsmanager_secret_version" "context_signing_secret_previous" {
  secret_id     = aws_secretsmanager_secret.context_signing_secret_previous.id
  secret_string = ""

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "database_url" {
  name = "${local.name_prefix}/database-url"
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = "postgresql://${var.db_username}:${random_password.db.result}@${aws_db_instance.main.address}:5432/${var.db_name}"
}

# SMTP credential creation is a manual, out-of-band step (see ses.tf) — an
# IAM access key shouldn't live in local tfstate. This gives the secret a
# stable ARN for Phase 3 to reference; ignore_changes keeps a later
# terraform apply from overwriting the real value the script writes with
# this placeholder again.
resource "aws_secretsmanager_secret" "smtp_url" {
  name = "${local.name_prefix}/smtp-url"
}

resource "aws_secretsmanager_secret_version" "smtp_url" {
  secret_id     = aws_secretsmanager_secret.smtp_url.id
  secret_string = "REPLACE_ME_AFTER_SES_DOMAIN_VERIFICATION"

  lifecycle {
    ignore_changes = [secret_string]
  }
}
