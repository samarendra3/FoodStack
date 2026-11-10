# Redis (ElastiCache, Valkey/Redis OSS-compatible engine) shared by rate limiting, cache and
# BullMQ. maxmemory-policy MUST stay `noeviction`: BullMQ keys must never be evicted (decision
# kept from Phase 4/5). TLS in transit, AUTH token, encryption at rest, Multi-AZ automatic
# failover when replicas > 0.

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "name" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "allowed_security_group_ids" { type = list(string) }
variable "node_type" { type = string }
variable "replicas" {
  description = "Read replicas per shard; >= 1 enables Multi-AZ automatic failover."
  type        = number
}
variable "auth_token" {
  type      = string
  sensitive = true
}
variable "kms_key_arn" { type = string }
variable "snapshot_retention_days" {
  type    = number
  default = 7
}
variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_elasticache_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
  tags       = var.tags
}

resource "aws_security_group" "redis" {
  name        = "${var.name}-redis"
  description = "Redis: only from API and worker tasks"
  vpc_id      = var.vpc_id
  tags        = var.tags
}

resource "aws_vpc_security_group_ingress_rule" "redis" {
  for_each                     = toset(var.allowed_security_group_ids)
  security_group_id            = aws_security_group.redis.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}

resource "aws_elasticache_parameter_group" "this" {
  name   = "${var.name}-redis7"
  family = "redis7"
  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }
  tags = var.tags
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id       = var.name
  description                = "FoodStack rate limits, cache and BullMQ"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.node_type
  num_cache_clusters         = 1 + var.replicas
  automatic_failover_enabled = var.replicas > 0
  multi_az_enabled           = var.replicas > 0
  port                       = 6379
  parameter_group_name       = aws_elasticache_parameter_group.this.name
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  kms_key_id                 = var.kms_key_arn
  transit_encryption_enabled = true
  auth_token                 = var.auth_token

  snapshot_retention_limit = var.snapshot_retention_days
  snapshot_window          = "19:30-20:30"
  maintenance_window       = "sun:22:30-sun:23:30"
  apply_immediately        = false
  tags                     = var.tags
}

output "primary_endpoint" { value = aws_elasticache_replication_group.this.primary_endpoint_address }
output "replication_group_id" { value = aws_elasticache_replication_group.this.id }
output "security_group_id" { value = aws_security_group.redis.id }
