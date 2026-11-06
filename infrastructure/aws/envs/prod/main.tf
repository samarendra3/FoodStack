# prod: sizes and safety flags only; everything else lives in modules/stack.
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
  default_tags { tags = { Project = "foodstack", Environment = "prod" } }
}

provider "aws" {
  alias  = "dr"
  region = var.dr_region
  default_tags { tags = { Project = "foodstack", Environment = "prod" } }
}

module "stack" {
  source    = "../../modules/stack"
  providers = { aws = aws, aws.dr = aws.dr }

  environment        = "prod"
  vpc_cidr           = "10.30.0.0/16"
  az_count           = 3
  single_nat_gateway = false
  api_domain         = "api.foodstack.example"
  route53_zone_id    = var.route53_zone_id
  image_tag          = var.image_tag
  alert_emails       = var.alert_emails
  web_origins        = ["https://app.foodstack.example"]

  api       = { cpu = 1024, memory = 2048, desired = 3, min = 3, max = 12 }
  worker    = { cpu = 512, memory = 1024, desired = 2, min = 2, max = 6, spot = false }
  pgbouncer = { desired = 2, default_pool_size = 25, max_db_connections = 80 }

  db = {
    instance_class        = "db.m7g.large"
    storage_gb            = 100
    max_storage_gb        = 1000
    multi_az              = true
    backup_retention_days = 35
    deletion_protection   = true
    max_connections       = 300
  }
  redis  = { node_type = "cache.m7g.large", replicas = 2, snapshot_retention_days = 7 }
  backup = { daily_days = 35, monthly_days = 365, copy_to_dr = true, vault_lock = true }

  log_retention_days = 90
  smtp               = { host = "email-smtp.ap-south-1.amazonaws.com", port = 587, user = "set-in-tfvars", from = "FoodStack <no-reply@foodstack.example>" }
}

output "alb_dns_name" { value = module.stack.alb_dns_name }
output "ecr_repository_url" { value = module.stack.ecr_repository_url }
output "cluster_name" { value = module.stack.cluster_name }
output "api_service" { value = module.stack.api_service }
output "worker_service" { value = module.stack.worker_service }
output "migrate_task_definition" { value = module.stack.migrate_task_definition }
output "migrate_security_group_id" { value = module.stack.migrate_security_group_id }
output "private_subnet_ids" { value = module.stack.private_subnet_ids }
