terraform {
  # 1.10+ for the S3 backend's native state locking (use_lockfile below) —
  # no DynamoDB table needed.
  required_version = ">= 1.10"

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

  # Bucket is itself a Terraform-managed resource (state-backend.tf) —
  # bootstrapped by one `apply` while state was still local, before this
  # block existed. Backend config can't reference variables/locals, so the
  # bucket name and region are repeated here as literals; they must match
  # local.name_prefix and var.aws_region's defaults.
  backend "s3" {
    bucket       = "vidforge-prod-terraform-state"
    key          = "terraform.tfstate"
    region       = "ap-south-1"
    encrypt      = true
    use_lockfile = true
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
