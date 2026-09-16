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

# Placeholder: SES domain verification and SMTP credential creation are a
# manual, out-of-band step (docs/aws-deployment.md, Phase 4 item 2). This
# gives the secret a stable ARN for Phase 3 to reference before real
# values exist.
resource "aws_secretsmanager_secret" "smtp_url" {
  name = "${local.name_prefix}/smtp-url"
}

resource "aws_secretsmanager_secret_version" "smtp_url" {
  secret_id     = aws_secretsmanager_secret.smtp_url.id
  secret_string = "REPLACE_ME_AFTER_SES_DOMAIN_VERIFICATION"
}
