# Phase 2 IaC (Terraform) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision the AWS core infrastructure (network, database, cache, storage, secrets) for VidForge via Terraform, matching Phase 2 of `docs/aws-deployment.md`, sized down and scoped for a single first environment.

**Architecture:** One Terraform root config at `infra/terraform/`, organized into files by concern (no reusable modules yet — single environment, no second consumer). A new VPC with 2 public / 2 private subnets across 2 AZs, one NAT gateway, an S3 gateway endpoint for private-subnet traffic to the media bucket, RDS PostgreSQL and ElastiCache Redis in the private subnets guarded by security groups scoped to a shared "app" security group (which Phase 3's ECS tasks will attach to), one private S3 bucket, and Secrets Manager entries for the values the application already reads from its environment.

**Tech Stack:** Terraform >= 1.9, `hashicorp/aws` ~> 5.0, `hashicorp/random` ~> 3.6.

**Spec:** `docs/superpowers/specs/2026-09-17-terraform-phase2-iac-design.md`

## Global Constraints

- Region: `ap-south-1` (matches the operator's AWS CLI default).
- Single environment, no staging/prod split.
- Terraform state stays local (`terraform.tfstate`, gitignored) — no remote backend this phase.
- `terraform >= 1.9`; `hashicorp/aws ~> 5.0`; `hashicorp/random ~> 3.6`; commit `.terraform.lock.hcl`.
- RDS: PostgreSQL 16, `db.t4g.micro`, single-AZ (not the doc's production `db.t4g.medium` Multi-AZ — sized down since nothing is validated on AWS yet).
- ElastiCache: `cache.t4g.micro`, single node, no cluster mode (matches the app's `maxRetriesPerRequest: null` BullMQ config).
- One NAT gateway (not one per AZ).
- Out of scope this phase: remote state backend, staging/prod split, SES resource provisioning, ECS services/ALB (Phase 3), Redis encryption-in-transit.
- `deletion_protection = false` on RDS for now (iterating; flip before real user data lands).
- **No `terraform apply` runs without the operator reviewing the `terraform plan` output and explicitly confirming.** This is a hard stop in Task 8 — do not skip it, do not run apply as part of a batch of otherwise-automated steps.
- All resources tagged `Project=vidforge`, `Environment=prod`, `ManagedBy=terraform` via the provider's `default_tags`.

---

## File Structure

```
infra/terraform/
  providers.tf              # terraform + provider blocks
  variables.tf               # all input variables
  network.tf                 # VPC, subnets, IGW, NAT, route tables, S3 endpoint, app SG
  database.tf                 # RDS instance, subnet group, SG, generated password
  cache.tf                    # ElastiCache cluster, subnet group, SG
  storage.tf                  # S3 media bucket + encryption/lifecycle/CORS
  secrets.tf                   # Secrets Manager entries
  outputs.tf                   # outputs consumed by Phase 3 / operator
  terraform.tfvars.example     # committed; real terraform.tfvars is gitignored
```

Root `.gitignore` gets entries for `infra/terraform/.terraform/`, `infra/terraform/*.tfstate*`, and `infra/terraform/terraform.tfvars` (but not the `.example` file).

---

### Task 1: Bootstrap the Terraform project

**Files:**
- Create: `infra/terraform/providers.tf`
- Create: `infra/terraform/variables.tf`
- Create: `infra/terraform/terraform.tfvars.example`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `var.aws_region`, `var.project_name`, `var.environment`, `var.vpc_cidr`, `var.public_subnet_cidrs`, `var.private_subnet_cidrs`, `var.db_instance_class`, `var.db_allocated_storage`, `var.db_name`, `var.db_username`, `var.redis_node_type`, `var.s3_cors_allowed_origin` — all later tasks consume these.

- [ ] **Step 1: Write `providers.tf`**

```hcl
terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
```

- [ ] **Step 2: Write `variables.tf`**

```hcl
variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "ap-south-1"
}

variable "project_name" {
  description = "Short name used in resource names and tags."
  type        = string
  default     = "vidforge"
}

variable "environment" {
  description = "Environment name used in resource names and tags."
  type        = string
  default     = "prod"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for the public subnets (one per AZ)."
  type        = list(string)
  default     = ["10.0.0.0/24", "10.0.1.0/24"]
}

variable "private_subnet_cidrs" {
  description = "CIDR blocks for the private subnets (one per AZ)."
  type        = list(string)
  default     = ["10.0.10.0/24", "10.0.11.0/24"]
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "RDS allocated storage in GB."
  type        = number
  default     = 20
}

variable "db_name" {
  description = "Default database name."
  type        = string
  default     = "vidforge"
}

variable "db_username" {
  description = "Master username for RDS."
  type        = string
  default     = "vidforge"
}

variable "redis_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.micro"
}

variable "s3_cors_allowed_origin" {
  description = "Origin allowed to make CORS requests against the media bucket (the web app's URL). Placeholder until Phase 3 creates the ALB/CloudFront domain."
  type        = string
  default     = "http://localhost:3100"
}
```

- [ ] **Step 3: Write `terraform.tfvars.example`**

```hcl
aws_region   = "ap-south-1"
project_name = "vidforge"
environment  = "prod"

# db_instance_class    = "db.t4g.micro"
# db_allocated_storage = 20
# redis_node_type      = "cache.t4g.micro"

# Update once Phase 3 creates the ALB/CloudFront domain.
# s3_cors_allowed_origin = "https://app.example.com"
```

- [ ] **Step 4: Add Terraform ignores to `.gitignore`**

Append to the existing root `.gitignore`:

```
# Terraform
infra/terraform/.terraform/
infra/terraform/*.tfstate
infra/terraform/*.tfstate.*
infra/terraform/terraform.tfvars
infra/terraform/*.tfplan
```

- [ ] **Step 5: Initialize and validate**

Run: `cd infra/terraform && terraform init && terraform validate`
Expected: `Terraform has been successfully initialized!` then `Success! The configuration is valid.`

- [ ] **Step 6: Commit**

```bash
git add infra/terraform/providers.tf infra/terraform/variables.tf infra/terraform/terraform.tfvars.example infra/terraform/.terraform.lock.hcl .gitignore
git commit -m "infra: bootstrap Terraform project for Phase 2 IaC"
```

---

### Task 2: Network

**Files:**
- Create: `infra/terraform/network.tf`

**Interfaces:**
- Consumes: `var.vpc_cidr`, `var.public_subnet_cidrs`, `var.private_subnet_cidrs`, `var.aws_region`, `var.project_name`, `var.environment` (Task 1).
- Produces: `aws_vpc.main`, `aws_subnet.public[*]`, `aws_subnet.private[*]`, `aws_route_table.private`, `aws_security_group.app` (id consumed by Task 3 and Task 4), `local.name_prefix`, `local.azs` — later tasks and `outputs.tf` reference these by name.

- [ ] **Step 1: Write `network.tf`**

```hcl
data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs         = slice(data.aws_availability_zones.available.names, 0, 2)
  name_prefix = "${var.project_name}-${var.environment}"
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${local.name_prefix}-vpc"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-igw"
  }
}

resource "aws_subnet" "public" {
  count                   = length(var.public_subnet_cidrs)
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "${local.name_prefix}-public-${local.azs[count.index]}"
  }
}

resource "aws_subnet" "private" {
  count             = length(var.private_subnet_cidrs)
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = local.azs[count.index]

  tags = {
    Name = "${local.name_prefix}-private-${local.azs[count.index]}"
  }
}

resource "aws_eip" "nat" {
  domain = "vpc"

  tags = {
    Name = "${local.name_prefix}-nat-eip"
  }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id

  tags = {
    Name = "${local.name_prefix}-nat"
  }

  depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${local.name_prefix}-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }

  tags = {
    Name = "${local.name_prefix}-private-rt"
  }
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]

  tags = {
    Name = "${local.name_prefix}-s3-endpoint"
  }
}

# Attached to ECS tasks in Phase 3. Created here so the database and cache
# security groups (Tasks 3-4) have something to scope ingress to.
resource "aws_security_group" "app" {
  name        = "${local.name_prefix}-app"
  description = "Security group for application services (ECS tasks, Phase 3)."
  vpc_id      = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.name_prefix}-app-sg"
  }
}
```

- [ ] **Step 2: Validate**

Run: `terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Plan and check resource count**

Run: `terraform plan -out=/tmp/vidforge-phase2.tfplan`
Expected: plan succeeds with no errors, showing 15 resources to add (VPC, IGW, 2 public subnets, 2 private subnets, EIP, NAT gateway, public route table + 2 associations, private route table + 2 associations, S3 endpoint, app security group). No changes to apply yet — this is a dry run.

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/network.tf
git commit -m "infra: add VPC, subnets, NAT, and S3 endpoint"
```

---

### Task 3: Database (RDS)

**Files:**
- Create: `infra/terraform/database.tf`

**Interfaces:**
- Consumes: `aws_vpc.main`, `aws_subnet.private[*]`, `aws_security_group.app` (Task 2); `var.db_instance_class`, `var.db_allocated_storage`, `var.db_name`, `var.db_username` (Task 1); `local.name_prefix` (Task 2).
- Produces: `random_password.db` (consumed by Task 6's `database_url` secret), `aws_db_instance.main` (its `.address` consumed by Task 6 and `outputs.tf`).

- [ ] **Step 1: Write `database.tf`**

```hcl
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-db"
  subnet_ids = aws_subnet.private[*].id

  tags = {
    Name = "${local.name_prefix}-db-subnet-group"
  }
}

resource "aws_security_group" "db" {
  name        = "${local.name_prefix}-db"
  description = "Allow Postgres from the application security group only."
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.name_prefix}-db-sg"
  }
}

resource "aws_db_instance" "main" {
  identifier              = "${local.name_prefix}-db"
  engine                  = "postgres"
  engine_version          = "16"
  instance_class          = var.db_instance_class
  allocated_storage       = var.db_allocated_storage
  storage_type            = "gp3"
  storage_encrypted       = true
  db_name                 = var.db_name
  username                = var.db_username
  password                = random_password.db.result
  db_subnet_group_name    = aws_db_subnet_group.main.name
  vpc_security_group_ids  = [aws_security_group.db.id]
  multi_az                = false
  publicly_accessible     = false
  backup_retention_period = 7
  skip_final_snapshot     = true
  deletion_protection     = false

  tags = {
    Name = "${local.name_prefix}-db"
  }
}
```

- [ ] **Step 2: Validate**

Run: `terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Plan and check resource count**

Run: `terraform plan -out=/tmp/vidforge-phase2.tfplan`
Expected: plan succeeds, now showing 18 resources to add total (the 15 from Task 2 plus `random_password.db`, `aws_db_subnet_group.main`, `aws_security_group.db`, `aws_db_instance.main` — 4 new, so 19 total; confirm the count matches what's new since the last plan rather than memorizing an absolute number).

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/database.tf
git commit -m "infra: add RDS PostgreSQL instance"
```

---

### Task 4: Cache (ElastiCache)

**Files:**
- Create: `infra/terraform/cache.tf`

**Interfaces:**
- Consumes: `aws_vpc.main`, `aws_subnet.private[*]`, `aws_security_group.app` (Task 2); `var.redis_node_type` (Task 1); `local.name_prefix` (Task 2).
- Produces: `aws_elasticache_cluster.main` (its `.cache_nodes[0].address` consumed by `outputs.tf`).

- [ ] **Step 1: Write `cache.tf`**

```hcl
resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name_prefix}-redis"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_security_group" "redis" {
  name        = "${local.name_prefix}-redis"
  description = "Allow Redis from the application security group only."
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.name_prefix}-redis-sg"
  }
}

resource "aws_elasticache_cluster" "main" {
  cluster_id         = "${local.name_prefix}-redis"
  engine             = "redis"
  node_type          = var.redis_node_type
  num_cache_nodes    = 1
  port               = 6379
  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  tags = {
    Name = "${local.name_prefix}-redis"
  }
}
```

- [ ] **Step 2: Validate**

Run: `terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Plan**

Run: `terraform plan -out=/tmp/vidforge-phase2.tfplan`
Expected: plan succeeds, adding `aws_elasticache_subnet_group.main`, `aws_security_group.redis`, `aws_elasticache_cluster.main` (3 new resources) on top of the previous total.

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/cache.tf
git commit -m "infra: add ElastiCache Redis cluster"
```

---

### Task 5: Storage (S3)

**Files:**
- Create: `infra/terraform/storage.tf`

**Interfaces:**
- Consumes: `local.name_prefix` (Task 2), `var.s3_cors_allowed_origin` (Task 1).
- Produces: `aws_s3_bucket.media` (its `.bucket` consumed by `outputs.tf`).

- [ ] **Step 1: Write `storage.tf`**

```hcl
resource "aws_s3_bucket" "media" {
  bucket = "${local.name_prefix}-media"

  tags = {
    Name = "${local.name_prefix}-media"
  }
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket = aws_s3_bucket.media.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  cors_rule {
    allowed_methods = ["PUT", "PATCH", "GET"]
    allowed_origins = [var.s3_cors_allowed_origin]
    allowed_headers = ["*"]
    expose_headers  = ["ETag", "Location", "Upload-Offset", "Upload-Length"]
    max_age_seconds = 3000
  }
}
```

- [ ] **Step 2: Validate**

Run: `terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Plan**

Run: `terraform plan -out=/tmp/vidforge-phase2.tfplan`
Expected: plan succeeds, adding `aws_s3_bucket.media`, `aws_s3_bucket_public_access_block.media`, `aws_s3_bucket_server_side_encryption_configuration.media`, `aws_s3_bucket_lifecycle_configuration.media`, `aws_s3_bucket_cors_configuration.media` (5 new resources).

**Note:** S3 bucket names are globally unique across all AWS accounts. If `terraform plan` or `apply` later fails with `BucketAlreadyExists`, change `var.project_name` or `var.environment` in `terraform.tfvars` to produce a different bucket name and re-plan.

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/storage.tf
git commit -m "infra: add S3 media bucket"
```

---

### Task 6: Secrets Manager

**Files:**
- Create: `infra/terraform/secrets.tf`

**Interfaces:**
- Consumes: `random_password.db`, `aws_db_instance.main.address` (Task 3); `var.db_username`, `var.db_name` (Task 1); `local.name_prefix` (Task 2).
- Produces: `aws_secretsmanager_secret.jwt_secret`, `aws_secretsmanager_secret.context_signing_secret`, `aws_secretsmanager_secret.database_url`, `aws_secretsmanager_secret.smtp_url` — their `.arn` consumed by `outputs.tf`.

- [ ] **Step 1: Write `secrets.tf`**

```hcl
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
```

- [ ] **Step 2: Validate**

Run: `terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Plan**

Run: `terraform plan -out=/tmp/vidforge-phase2.tfplan`
Expected: plan succeeds, adding 2 `random_password` resources and 4 secrets + 4 secret versions (10 new resources).

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/secrets.tf
git commit -m "infra: add Secrets Manager entries for app credentials"
```

---

### Task 7: Outputs and full-plan review

**Files:**
- Create: `infra/terraform/outputs.tf`

**Interfaces:**
- Consumes: every resource produced in Tasks 2-6.
- Produces: the full set of Terraform outputs listed below — Phase 3's Terraform config will consume `vpc_id`, `private_subnet_ids`, `public_subnet_ids`, and `app_security_group_id` as inputs.

- [ ] **Step 1: Write `outputs.tf`**

```hcl
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
```

- [ ] **Step 2: Format check**

Run: `terraform fmt -check -recursive`
Expected: no output (no files need reformatting). If files are listed, run `terraform fmt -recursive` and re-check.

- [ ] **Step 3: Validate**

Run: `terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 4: Full plan**

Run: `terraform plan -out=/tmp/vidforge-phase2.tfplan`
Expected: plan succeeds with 0 errors, showing the complete set of ~32 resources to add and 0 to change/destroy (this is the first apply, so everything is a create). Read through the plan output for anything unexpected (wrong region, wrong CIDR, a resource you don't recognize) before moving to Task 8.

- [ ] **Step 5: Commit**

```bash
git add infra/terraform/outputs.tf
git commit -m "infra: add Terraform outputs for Phase 3 consumption"
```

---

### Task 8: Apply (gated) and post-apply verification

**Files:** none (no new files — this task runs the plan produced in Task 7).

**Interfaces:**
- Consumes: `/tmp/vidforge-phase2.tfplan` (Task 7).
- Produces: real AWS resources; no code artifacts.

- [ ] **Step 1: Present the plan to the operator**

Show the full output of `terraform show /tmp/vidforge-phase2.tfplan` (or re-run `terraform plan` if the saved plan is stale) to the user. Summarize: resource count, that this is the first apply (all creates), and the estimated cost from the spec (~$0.10/hr while running).

- [ ] **Step 2: STOP — get explicit confirmation**

Do not proceed to Step 3 until the operator explicitly confirms they want to apply. This is a hard gate — a plan that "looks fine" is not the same as confirmation. If executing via subagent-driven-development, this step must escalate back to the primary conversation; a subagent must not apply on its own judgment.

- [ ] **Step 3: Apply**

Run: `terraform apply /tmp/vidforge-phase2.tfplan`
Expected: `Apply complete! Resources: <N> added, 0 changed, 0 destroyed.` (RDS creation alone typically takes 5-10 minutes; the command blocks until done.)

- [ ] **Step 4: Verify resources exist**

```bash
terraform output -json > /tmp/vidforge-phase2-outputs.json
aws rds describe-db-instances --db-instance-identifier vidforge-prod-db --query 'DBInstances[0].DBInstanceStatus'
aws elasticache describe-cache-clusters --cache-cluster-id vidforge-prod-redis --query 'CacheClusters[0].CacheClusterStatus'
aws s3api head-bucket --bucket "$(terraform output -raw media_bucket_name)"
aws secretsmanager get-secret-value --secret-id vidforge-prod/jwt-secret --query 'ARN'
```

Expected: RDS status `available`, ElastiCache status `available`, `head-bucket` returns no error, the secret ARN prints.

**Note on connectivity testing:** RDS and Redis sit in private subnets with no public access and no bastion/SSM host exists yet — that's intentionally out of scope for this phase (see spec). Live `psql`/`redis-cli` connectivity from a laptop isn't possible until Phase 3 adds a way into the VPC (or an ECS task that can reach them). This task's verification is "the resources exist and report healthy," not "the app can talk to them" — that comes with Phase 3.

- [ ] **Step 5: Record outputs for Phase 3**

No action needed beyond keeping `terraform.tfstate` — Phase 3's Terraform config will read these via `terraform_remote_state` or by re-running `terraform output` in this directory once it exists. Nothing to commit here (outputs are derived, not source).

---

## Self-Review Notes

- **Spec coverage:** Network (Task 2), Database (Task 3), Cache (Task 4), Storage (Task 5), Secrets (Task 6, including the SES placeholder), tooling/layout (Task 1, file structure), validation-before-apply (Task 7-8) all map to the spec's numbered components. Out-of-scope items (remote state, staging/prod, SES resources, ECS/ALB, Redis TLS) are not implemented anywhere in this plan, matching the spec.
- **Placeholder scan:** No TBD/TODO markers; the one literal placeholder value (`REPLACE_ME_AFTER_SES_DOMAIN_VERIFICATION`) is intentional per the spec's SES-out-of-scope decision, not an unfinished plan step.
- **Type/name consistency:** `aws_security_group.app` (Task 2) is referenced identically in Task 3 and Task 4's ingress rules. `random_password.db` (Task 3) and `aws_db_instance.main.address` (Task 3) are referenced identically in Task 6's `database_url` secret. `local.name_prefix` and `local.azs` (Task 2) are used consistently in Tasks 3-6.
