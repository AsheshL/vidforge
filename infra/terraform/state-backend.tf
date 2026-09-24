# Terraform remote state (docs/backlog.md's "Terraform remote state" item):
# state was local-only, meaning no locking, no history, and — as the CI/CD
# pipeline found out — unusable from anywhere but this one machine.
#
# Bootstrapping note: this bucket is created by an ordinary `apply` while
# state is still local, then providers.tf's `backend "s3"` block points at
# it and `terraform init -migrate-state` copies state in. It stays a
# Terraform-managed resource even after migration — small-team/solo setups
# commonly self-host their backend bucket this way rather than standing up
# a separate bootstrap root module for one bucket.
resource "aws_s3_bucket" "terraform_state" {
  bucket = "${local.name_prefix}-terraform-state"

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name = "${local.name_prefix}-terraform-state"
  }
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
