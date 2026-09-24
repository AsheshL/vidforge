output "vpc_id" {
  value = aws_vpc.main.id
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "app_security_group_id" {
  description = "Attach this to ECS tasks in Phase 3 so they can reach the database and cache."
  value       = aws_security_group.app.id
}

output "db_endpoint" {
  value = aws_db_instance.main.address
}

output "redis_endpoint" {
  value = aws_elasticache_cluster.main.cache_nodes[0].address
}

output "media_bucket_name" {
  value = aws_s3_bucket.media.bucket
}

output "jwt_secret_arn" {
  value = aws_secretsmanager_secret.jwt_secret.arn
}

output "context_signing_secret_arn" {
  value = aws_secretsmanager_secret.context_signing_secret.arn
}

output "database_url_secret_arn" {
  value = aws_secretsmanager_secret.database_url.arn
}

output "smtp_url_secret_arn" {
  value = aws_secretsmanager_secret.smtp_url.arn
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "migration_task_definition_arn" {
  value = aws_ecs_task_definition.migrate.arn
}

output "alb_dns_name" {
  description = "Raw ALB hostname — HTTP here redirects to the real domain below."
  value       = aws_lb.main.dns_name
}

output "app_url" {
  description = "Public HTTPS entrypoint for the app."
  value       = "https://${var.domain_name}"
}
