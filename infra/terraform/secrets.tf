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
