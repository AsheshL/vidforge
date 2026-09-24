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

# --- Phase 3: image tags (no defaults — always pass explicitly, the full
# git SHA of the commit each image was built from; see
# infra/scripts/build-and-push.sh) ---

variable "web_image_tag" {
  description = "Git SHA tag of the web image to deploy."
  type        = string
}

variable "api_gateway_image_tag" {
  description = "Git SHA tag of the api-gateway image to deploy."
  type        = string
}

variable "auth_svc_image_tag" {
  description = "Git SHA tag of the auth-svc image to deploy."
  type        = string
}

variable "video_svc_api_image_tag" {
  description = "Git SHA tag of the video-svc API image to deploy."
  type        = string
}

variable "video_svc_worker_image_tag" {
  description = "Git SHA tag of the video-svc worker image to deploy."
  type        = string
}

# --- Phase 3: task sizing (Fargate CPU units / MiB memory) ---

variable "web_task_cpu" {
  type    = number
  default = 256
}

variable "web_task_memory" {
  type    = number
  default = 512
}

variable "gateway_task_cpu" {
  type    = number
  default = 256
}

variable "gateway_task_memory" {
  type    = number
  default = 512
}

variable "auth_task_cpu" {
  type    = number
  default = 256
}

variable "auth_task_memory" {
  type    = number
  default = 512
}

variable "video_api_task_cpu" {
  type    = number
  default = 256
}

variable "video_api_task_memory" {
  type    = number
  default = 512
}

variable "worker_task_cpu" {
  description = "ffmpeg is the one CPU-heavy workload in this system."
  type        = number
  default     = 2048
}

variable "worker_task_memory" {
  type    = number
  default = 4096
}

variable "worker_min_count" {
  type    = number
  default = 1
}

variable "worker_max_count" {
  type    = number
  default = 4
}

# --- Phase 3: ALB ---

variable "alb_idle_timeout" {
  description = "ALB idle timeout in seconds. Must exceed the SSE job-progress stream's expected duration."
  type        = number
  default     = 120
}

variable "domain_name" {
  description = "Apex domain registered in Route53 that fronts the ALB (public HTTPS entrypoint)."
  type        = string
  default     = "vidforge.dev"
}
