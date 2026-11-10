# staging: sizes and safety flags only; everything else lives in modules/stack.
# NOT APPLIED. Applying creates billable AWS resources: see ../../README.md ("Cost and approval").

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # Partial configuration: terraform init -backend-config=backend.hcl (see backend.hcl.example).
  backend "s3" {}
}

variable "region" {
  type    = string
  default = "ap-south-1"
}
variable "dr_region" {
  type    = string
  default = "ap-southeast-1"
}
variable "image_tag" {
  description = "Git SHA of the image to deploy (set by CI)."
  type        = string
}
variable "route53_zone_id" {
  type    = string
  default = ""
}
variable "alert_emails" {
  type    = list(string)
  default = []
}

provider "aws" {
  region = var.region
  default_tags { tags = { Project = "foodstack", Environment = "staging" } }
}

provider "aws" {
  alias  = "dr"
  region = var.dr_region
  default_tags { tags = { Project = "foodstack", Environment = "staging" } }
}

module "stack" {
  source    = "../../modules/stack"
  providers = { aws = aws, aws.dr = aws.dr }

  environment        = "staging"
  vpc_cidr           = "10.20.0.0/16"
  az_count           = 2
  single_nat_gateway = true
  api_domain         = "api.staging.foodstack.example"
  route53_zone_id    = var.route53_zone_id
  image_tag          = var.image_tag
  alert_emails       = var.alert_emails
  web_origins        = ["https://app.staging.foodstack.example"]

  api       = { cpu = 512, memory = 1024, desired = 2, min = 2, max = 4 }
  worker    = { cpu = 256, memory = 512, desired = 1, min = 1, max = 2, spot = true }
  pgbouncer = { desired = 2, default_pool_size = 15, max_db_connections = 40 }

  db = {
    instance_class        = "db.t4g.medium"
    storage_gb            = 50
    max_storage_gb        = 200
    multi_az              = false
    backup_retention_days = 14
    deletion_protection   = true
    max_connections       = 200
  }
  redis  = { node_type = "cache.t4g.small", replicas = 1, snapshot_retention_days = 3 }
  backup = { daily_days = 14, monthly_days = 90, copy_to_dr = false, vault_lock = false }

  log_retention_days = 30
  smtp               = { host = "email-smtp.ap-south-1.amazonaws.com", port = 587, user = "set-in-tfvars", from = "FoodStack <no-reply@staging.foodstack.example>" }
}

output "alb_dns_name" { value = module.stack.alb_dns_name }
output "ecr_repository_url" { value = module.stack.ecr_repository_url }
output "cluster_name" { value = module.stack.cluster_name }
output "api_service" { value = module.stack.api_service }
output "worker_service" { value = module.stack.worker_service }
output "migrate_task_definition" { value = module.stack.migrate_task_definition }
output "migrate_security_group_id" { value = module.stack.migrate_security_group_id }
output "private_subnet_ids" { value = module.stack.private_subnet_ids }
