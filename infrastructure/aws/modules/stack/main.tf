# One complete FoodStack environment: network, data stores, secrets, ECS services (API, worker,
# PgBouncer), a one-off migration task, ALB with TLS, monitoring and backups.
# Request path: ALB → API tasks → PgBouncer (transaction pooling) → RDS PostgreSQL.
# The API and worker also use ElastiCache Redis for rate limits, cache and BullMQ.
# Environments differ only in the sizes and flags passed in (envs/<env>/main.tf).

terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = "~> 6.0"
      configuration_aliases = [aws.dr]
    }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

variable "environment" {
  type = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging or prod"
  }
}
variable "vpc_cidr" { type = string }
variable "az_count" { type = number }
variable "single_nat_gateway" { type = bool }
variable "api_domain" { type = string }
variable "route53_zone_id" {
  type    = string
  default = ""
}
variable "image_tag" {
  description = "Immutable image tag (git SHA) deployed by CI."
  type        = string
}
variable "api" {
  type = object({ cpu = number, memory = number, desired = number, min = number, max = number })
}
variable "worker" {
  type = object({ cpu = number, memory = number, desired = number, min = number, max = number, spot = bool })
}
variable "pgbouncer" {
  type = object({ desired = number, default_pool_size = number, max_db_connections = number })
}
variable "db" {
  type = object({
    instance_class        = string, storage_gb = number, max_storage_gb = number, multi_az = bool,
    backup_retention_days = number, deletion_protection = bool, max_connections = number
  })
}
variable "redis" {
  type = object({ node_type = string, replicas = number, snapshot_retention_days = number })
}
variable "backup" {
  type = object({ daily_days = number, monthly_days = number, copy_to_dr = bool, vault_lock = bool })
}
variable "log_retention_days" { type = number }
variable "alert_emails" {
  type    = list(string)
  default = []
}
variable "smtp" {
  type = object({ host = string, port = number, user = string, from = string })
}
variable "web_origins" {
  description = "Allowed browser origins (CORS), e.g. https://app.foodstack.example"
  type        = list(string)
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  name = "foodstack-${var.environment}"
  tags = { Project = "foodstack", Environment = var.environment, ManagedBy = "terraform" }
  prod = var.environment == "prod"
  # dev and staging run as NODE_ENV=staging, prod as production. Both are "deployed" for the
  # config validation: JWT keys, a non-example MFA key, COOKIE_SECURE and no Swagger are enforced.
  app_env = {
    NODE_ENV            = local.prod ? "production" : "staging"
    PORT                = "4000"
    SWAGGER_ENABLED     = "false"
    TRUST_PROXY         = "true"
    COOKIE_SECURE       = "true"
    CORS_ORIGINS        = join(",", var.web_origins)
    DATABASE_HOST       = "${module.pgbouncer.service_name}.${local.name}.internal"
    DATABASE_PORT       = "6432"
    DATABASE_POOLER     = "pgbouncer"
    DATABASE_NAME       = "foodstack"
    DATABASE_USER       = "foodstack_app"
    DATABASE_SSL        = "false" # PgBouncer is in-VPC; PgBouncer → RDS uses TLS (require)
    DATABASE_POOL_MAX   = "10"
    REDIS_HOST          = module.cache.primary_endpoint
    REDIS_PORT          = "6379"
    REDIS_TLS           = "true"
    QUEUE_PREFIX        = "foodstack"
    METRICS_HOST        = "127.0.0.1" # scraped by the ADOT sidecar on localhost only
    METRICS_PORT        = "9464"
    WORKER_METRICS_PORT = "9465"
    SMTP_HOST           = var.smtp.host
    SMTP_PORT           = tostring(var.smtp.port)
    SMTP_USER           = var.smtp.user
    MAIL_FROM           = var.smtp.from
    LOG_LEVEL           = "info"
  }
  app_secrets = {
    JWT_PRIVATE_KEY         = module.secrets.app_secret_arns["jwt_private_key"]
    JWT_PUBLIC_KEY          = module.secrets.app_secret_arns["jwt_public_key"]
    MFA_ENCRYPTION_KEY      = module.secrets.app_secret_arns["mfa_encryption_key"]
    DATABASE_PASSWORD       = module.secrets.app_secret_arns["database_app_password"]
    SMTP_PASSWORD           = module.secrets.app_secret_arns["smtp_password"]
    RAZORPAY_KEY_SECRET     = module.secrets.app_secret_arns["razorpay_key_secret"]
    RAZORPAY_WEBHOOK_SECRET = module.secrets.app_secret_arns["razorpay_webhook_secret"]
    REDIS_PASSWORD          = module.secrets.redis_auth_secret_arn
  }
  secret_arns = concat(values(module.secrets.app_secret_arns), [module.secrets.redis_auth_secret_arn])
  image       = "${module.platform.ecr_repository_url}:${var.image_tag}"
  metrics = {
    remote_write_url = module.monitoring.amp_remote_write_url
    region           = data.aws_region.current.region
  }
}

module "network" {
  source             = "../network"
  name               = local.name
  cidr               = var.vpc_cidr
  az_count           = var.az_count
  single_nat_gateway = var.single_nat_gateway
  tags               = local.tags
}

module "secrets" {
  source               = "../secrets"
  name                 = local.name
  recovery_window_days = local.prod ? 30 : 7
  tags                 = local.tags
}

module "platform" {
  source                  = "../platform"
  name                    = local.name
  vpc_id                  = module.network.vpc_id
  vpc_cidr                = module.network.vpc_cidr
  public_subnet_ids       = module.network.public_subnet_ids
  domain_name             = var.api_domain
  route53_zone_id         = var.route53_zone_id
  alb_deletion_protection = local.prod
  log_retention_days      = var.log_retention_days
  tags                    = local.tags
}

resource "aws_service_discovery_private_dns_namespace" "this" {
  name = "${local.name}.internal"
  vpc  = module.network.vpc_id
  tags = local.tags
}

module "database" {
  source                     = "../database"
  name                       = local.name
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.isolated_subnet_ids
  allowed_security_group_ids = [module.pgbouncer.security_group_id, aws_security_group.migrate.id]
  instance_class             = var.db.instance_class
  allocated_storage_gb       = var.db.storage_gb
  max_allocated_storage_gb   = var.db.max_storage_gb
  multi_az                   = var.db.multi_az
  backup_retention_days      = var.db.backup_retention_days
  deletion_protection        = var.db.deletion_protection
  max_connections            = var.db.max_connections
  kms_key_arn                = module.secrets.kms_key_arn
  tags                       = local.tags
}

module "cache" {
  source                     = "../cache"
  name                       = local.name
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.isolated_subnet_ids
  allowed_security_group_ids = [module.api.security_group_id, module.worker.security_group_id]
  node_type                  = var.redis.node_type
  replicas                   = var.redis.replicas
  snapshot_retention_days    = var.redis.snapshot_retention_days
  auth_token                 = module.secrets.redis_auth_token
  kms_key_arn                = module.secrets.kms_key_arn
  tags                       = local.tags
}

module "pgbouncer" {
  source                     = "../ecs_service"
  name                       = "${local.name}-pgbouncer"
  cluster_arn                = module.platform.cluster_arn
  cluster_name               = module.platform.cluster_name
  vpc_cidr                   = module.network.vpc_cidr
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  image                      = "edoburu/pgbouncer:v1.24.1-p1"
  cpu                        = 256
  memory                     = 512
  desired_count              = var.pgbouncer.desired
  min_count                  = var.pgbouncer.desired
  max_count                  = var.pgbouncer.desired + 2
  container_port             = 6432
  readonly_root_filesystem   = false
  ingress_security_group_ids = [module.api.security_group_id, module.worker.security_group_id]
  discovery_namespace_id     = aws_service_discovery_private_dns_namespace.this.id
  environment = {
    DB_HOST                   = module.database.endpoint
    DB_PORT                   = "5432"
    DB_USER                   = "foodstack_app"
    AUTH_TYPE                 = "scram-sha-256"
    POOL_MODE                 = "transaction"
    MAX_CLIENT_CONN           = "2000"
    DEFAULT_POOL_SIZE         = tostring(var.pgbouncer.default_pool_size)
    MAX_DB_CONNECTIONS        = tostring(var.pgbouncer.max_db_connections)
    SERVER_RESET_QUERY        = "DISCARD ALL"
    SERVER_TLS_SSLMODE        = "require"
    IGNORE_STARTUP_PARAMETERS = "extra_float_digits,options"
    LISTEN_PORT               = "6432"
    STATS_USERS               = "foodstack_app"
  }
  secrets               = { DB_PASSWORD = module.secrets.app_secret_arns["database_app_password"] }
  execution_secret_arns = [module.secrets.app_secret_arns["database_app_password"]]
  kms_key_arns          = [module.secrets.kms_key_arn]
  log_group_name        = module.platform.log_group_names["pgbouncer"]
  tags                  = local.tags
}

module "api" {
  source         = "../ecs_service"
  name           = "${local.name}-api"
  cluster_arn    = module.platform.cluster_arn
  cluster_name   = module.platform.cluster_name
  vpc_id         = module.network.vpc_id
  vpc_cidr       = module.network.vpc_cidr
  subnet_ids     = module.network.private_subnet_ids
  image          = local.image
  cpu            = var.api.cpu
  memory         = var.api.memory
  desired_count  = var.api.desired
  min_count      = var.api.min
  max_count      = var.api.max
  container_port = 4000
  stop_timeout   = 30
  environment    = local.app_env
  secrets        = local.app_secrets
  health_command = ["CMD", "node", "-e", "fetch('http://127.0.0.1:4000/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
  load_balancer = {
    listener_arn          = module.platform.https_listener_arn
    host_header           = var.api_domain
    health_path           = "/api/v1/health/live"
    alb_security_group_id = module.platform.alb_security_group_id
    priority              = 10
  }
  metrics               = { port = 9464, remote_write_url = local.metrics.remote_write_url, region = local.metrics.region }
  execution_secret_arns = local.secret_arns
  kms_key_arns          = [module.secrets.kms_key_arn]
  log_group_name        = module.platform.log_group_names["api"]
  tags                  = local.tags
}

module "worker" {
  source                = "../ecs_service"
  name                  = "${local.name}-worker"
  cluster_arn           = module.platform.cluster_arn
  cluster_name          = module.platform.cluster_name
  vpc_id                = module.network.vpc_id
  vpc_cidr              = module.network.vpc_cidr
  subnet_ids            = module.network.private_subnet_ids
  image                 = local.image
  command               = ["node", "dist/worker.js"]
  cpu                   = var.worker.cpu
  memory                = var.worker.memory
  desired_count         = var.worker.desired
  min_count             = var.worker.min
  max_count             = var.worker.max
  use_spot              = var.worker.spot
  stop_timeout          = 45 # finish active sends (EMAIL_SEND_TIMEOUT_MS = 15 s) before SIGKILL
  environment           = local.app_env
  secrets               = local.app_secrets
  health_command        = ["CMD", "node", "dist/worker-health.js"]
  metrics               = { port = 9465, remote_write_url = local.metrics.remote_write_url, region = local.metrics.region }
  execution_secret_arns = local.secret_arns
  kms_key_arns          = [module.secrets.kms_key_arn]
  log_group_name        = module.platform.log_group_names["worker"]
  tags                  = local.tags
}

# One-off migration task, run by the deploy workflow before the new API version.
# It connects directly to RDS as the schema owner, using the RDS-managed master secret,
# and never through PgBouncer: migrations need session state.
resource "aws_security_group" "migrate" {
  name        = "${local.name}-migrate"
  description = "Migration task: RDS and VPC endpoints only"
  vpc_id      = module.network.vpc_id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [module.network.vpc_cidr]
  }
  tags = local.tags
}

resource "aws_iam_role" "migrate_exec" {
  name = "${local.name}-migrate-exec"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "migrate_exec" {
  role       = aws_iam_role.migrate_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "migrate_exec" {
  role = aws_iam_role.migrate_exec.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = concat(local.secret_arns, [module.database.master_secret_arn]) },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = [module.secrets.kms_key_arn] },
    ]
  })
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.migrate_exec.arn
  container_definitions = jsonencode([{
    name      = "migrate"
    image     = local.image
    essential = true
    command   = ["node", "node_modules/typeorm/cli.js", "migration:run", "-d", "dist/database/data-source.js"]
    environment = [for k, v in merge(local.app_env, {
      DATABASE_HOST           = module.database.endpoint
      DATABASE_PORT           = "5432"
      DATABASE_POOLER         = "none"
      DATABASE_SSL            = "true"
      DATABASE_MIGRATION_USER = "foodstack_owner"
    }) : { name = k, value = v }]
    secrets = concat(
      [for k, v in local.app_secrets : { name = k, valueFrom = v }],
      [{ name = "DATABASE_MIGRATION_PASSWORD", valueFrom = "${module.database.master_secret_arn}:password::" }],
    )
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = module.platform.log_group_names["migrate"]
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "migrate"
      }
    }
  }])
  tags = local.tags
}

module "monitoring" {
  source                      = "../monitoring"
  name                        = local.name
  alert_emails                = var.alert_emails
  alerts_rules_file           = "${path.module}/../../../monitoring/prometheus/alerts.yml"
  alb_arn_suffix              = module.platform.alb_arn_suffix
  api_target_group_arn_suffix = module.api.target_group_arn_suffix
  cluster_name                = module.platform.cluster_name
  ecs_services = {
    (module.api.service_name)       = var.api.min
    (module.worker.service_name)    = var.worker.min
    (module.pgbouncer.service_name) = var.pgbouncer.desired
  }
  db_instance_id             = module.database.instance_id
  redis_replication_group_id = module.cache.replication_group_id
  tags                       = local.tags
}

module "backup" {
  source                 = "../backup"
  providers              = { aws = aws, aws.dr = aws.dr }
  name                   = local.name
  resource_arns          = [module.database.instance_arn]
  daily_retention_days   = var.backup.daily_days
  monthly_retention_days = var.backup.monthly_days
  copy_to_dr_region      = var.backup.copy_to_dr
  vault_lock             = var.backup.vault_lock
  tags                   = local.tags
}

output "alb_dns_name" { value = module.platform.alb_dns_name }
output "ecr_repository_url" { value = module.platform.ecr_repository_url }
output "cluster_name" { value = module.platform.cluster_name }
output "api_service" { value = module.api.service_name }
output "worker_service" { value = module.worker.service_name }
output "migrate_task_definition" { value = aws_ecs_task_definition.migrate.family }
output "migrate_security_group_id" { value = aws_security_group.migrate.id }
output "private_subnet_ids" { value = module.network.private_subnet_ids }
output "db_endpoint" { value = module.database.endpoint }
output "alerts_topic_arn" { value = module.monitoring.alerts_topic_arn }
