# Phase 2 IaC (Terraform) — Design

Date: 2026-09-17
Status: approved, pending implementation plan

## Purpose

Implement Phase 2 of `docs/aws-deployment.md` — the core AWS infrastructure
(network, database, cache, storage, secrets) — using Terraform, so Phase 3
(ECS services) has something real to deploy onto.

## Scope decisions

- **Single environment.** No staging/prod split yet. Structured so a second
  environment is a small follow-up (promote the root config into a module),
  not a rewrite.
- **Region: `ap-south-1`** — matches the operator's configured AWS CLI
  default.
- **State: local for now.** Single operator, no CI touching this yet. A
  remote S3+DynamoDB backend is a follow-up if/when a second person or CI
  needs access.
- **Sized down from the doc's production numbers**, since nothing is
  validated on AWS yet: `db.t4g.micro` single-AZ RDS (doc specifies
  `db.t4g.medium` Multi-AZ) and `cache.t4g.micro` single-node ElastiCache.
  Bump via tfvars once proven out and real traffic is expected.
- **Single NAT gateway** for private-subnet egress (ECR pulls, OS updates),
  accepting it as a single point of failure for outbound traffic only — not
  for the app itself. Chosen over NAT-free (VPC endpoints only) for
  simplicity in a single-environment, cost-conscious first pass.
- **SES setup is out of scope.** Domain verification is a manual console
  step per the deployment doc; this phase leaves a placeholder secret for
  the shape but does not provision SES resources.
- **Phase 3 (ECS services, ALB) is out of scope.** This phase provisions
  infrastructure only — it does not deploy the application. The app cannot
  be manually tested on AWS until Phase 3 exists.

## Components

### 1. Network

- New VPC, `10.0.0.0/16` (not the account's default VPC).
- 2 AZs. 2 public subnets (ALB, NAT gateway), 2 private subnets (ECS tasks,
  RDS, ElastiCache).
- One NAT gateway in the first public subnet; private route table sends
  `0.0.0.0/0` through it.
- S3 gateway endpoint attached to the private route table (free) so
  transcoding traffic to S3 skips the NAT, per the deployment doc.

### 2. Database (RDS)

- PostgreSQL 16, `db.t4g.micro`, single-AZ.
- DB subnet group across the private subnets. Not publicly accessible.
- Storage encrypted (default KMS key). Automated backups on, 7-day
  retention.
- Credentials: Terraform generates a `random_password`; the resulting
  connection string is stored in Secrets Manager, never in a plaintext
  output or tfvars.
- `deletion_protection = false` for this environment while iterating —
  flagged to flip on before real user data lands.

### 3. Cache (ElastiCache Redis)

- Single `cache.t4g.micro` node, no cluster mode (matches the app's
  `maxRetriesPerRequest: null` BullMQ config).
- Cache subnet group across the private subnets.
- No encryption-in-transit / auth token this phase — the app's `REDIS_URL`
  handling has no TLS support today; adding it is out of scope here.
- Security group allows access only from the ECS tasks' security group.

### 4. Storage (S3)

- One private bucket, SSE-S3 default encryption, versioning off (media
  originals/renditions don't need version history; halves storage cost).
- Lifecycle rule aborting incomplete multipart uploads after 7 days (covers
  abandoned tus uploads).
- CORS for tus `PUT`/`PATCH` and presigned `GET`; allowed origin is a
  placeholder variable until Phase 3 creates the ALB/CloudFront domain.

### 5. Secrets Manager

- `JWT_SECRET`, `CONTEXT_SIGNING_SECRET`: Terraform-generated
  `random_password` (32+ bytes), stored as secrets.
- `DATABASE_URL`: composed from the RDS outputs + generated password,
  stored as a secret.
- SES SMTP credentials: placeholder secret only (shape exists; real values
  are a manual follow-up after domain verification).

### 6. Tooling & layout

- Directory: `infra/terraform/` at repo root.
- `terraform >= 1.9`, `hashicorp/aws ~> 5.0`, committed
  `.terraform.lock.hcl`.
- Files by concern: `network.tf`, `database.tf`, `cache.tf`, `storage.tf`,
  `secrets.tf`, `variables.tf`, `outputs.tf`, `providers.tf`.
- `variables.tf` covers region, project/env name tags, and sizing knobs.
  `terraform.tfvars.example` committed; real `terraform.tfvars` gitignored
  (holds non-secret config only — secrets are Terraform-generated, not
  hand-entered).
- Consistent tags on every resource: `Project=vidforge`,
  `Environment=<env>`, `ManagedBy=terraform`.
- `.tfstate*` and `.terraform/` added to `.gitignore`.

## Validation before apply

`terraform fmt -check`, `terraform validate`, `terraform plan` reviewed by
the operator. **No `terraform apply` runs without explicit confirmation on
the plan output** — this phase creates real, billed AWS resources.

## Out of scope (explicitly)

- Remote state backend (S3 + DynamoDB lock table).
- Staging/prod environment separation.
- SES resource provisioning.
- ECS services, ALB, Cloud Map (Phase 3).
- Encryption-in-transit for Redis.
