# One ECS Fargate service (API, worker or PgBouncer).
# - Rolling deploys keep 100 % healthy capacity, and the circuit breaker rolls back failed deploys.
# - Graceful shutdown: SIGTERM, then `stop_timeout` seconds to drain. The ALB deregistration delay
#   is shorter than that, so in-flight requests finish before the task stops.
# - Optional ALB target group. Its health check uses the LIVENESS endpoint: the readiness endpoint
#   reports Redis, and a Redis outage must not pull every replica out of rotation (found in the
#   HA rehearsal; sign-in then fails closed on its own, everything else keeps serving).
# - Optional ADOT sidecar: scrapes the container's /metrics on localhost and remote-writes to
#   Amazon Managed Service for Prometheus.

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "name" { type = string }
variable "cluster_arn" { type = string }
variable "cluster_name" { type = string }
variable "vpc_id" { type = string }
variable "vpc_cidr" { type = string }
variable "subnet_ids" { type = list(string) }
variable "image" { type = string }
variable "command" {
  type    = list(string)
  default = null
}
variable "cpu" { type = number }
variable "memory" { type = number }
variable "desired_count" { type = number }
variable "min_count" { type = number }
variable "max_count" { type = number }
variable "cpu_target_percent" {
  type    = number
  default = 60
}
variable "environment" {
  type    = map(string)
  default = {}
}
variable "secrets" {
  description = "Env var name → Secrets Manager ARN (optionally ARN:json-key::)."
  type        = map(string)
  default     = {}
}
variable "container_port" {
  type    = number
  default = null
}
variable "stop_timeout" {
  type    = number
  default = 30
}
variable "health_command" {
  type    = list(string)
  default = null
}
variable "load_balancer" {
  description = "Attach to the ALB: listener, host header, liveness path."
  type = object({
    listener_arn          = string
    host_header           = string
    health_path           = string
    alb_security_group_id = string
    priority              = number
  })
  default = null
}
variable "ingress_security_group_ids" {
  description = "Security groups allowed to reach container_port (e.g. API → PgBouncer)."
  type        = list(string)
  default     = []
}
variable "metrics" {
  description = "Scrape /metrics on this port with an ADOT sidecar → AMP remote write."
  type = object({
    port             = number
    remote_write_url = string
    region           = string
  })
  default = null
}
variable "log_group_name" { type = string }
variable "task_role_policy_json" {
  description = "Extra permissions for the application (task role)."
  type        = string
  default     = null
}
variable "execution_secret_arns" {
  description = "Secrets the execution role may read to inject env vars."
  type        = list(string)
  default     = []
}
variable "kms_key_arns" {
  type    = list(string)
  default = []
}
variable "discovery_namespace_id" {
  description = "Cloud Map private DNS namespace: registers <name>.<namespace> (e.g. PgBouncer for the API)."
  type        = string
  default     = null
}
variable "readonly_root_filesystem" {
  description = "false for images that write config at start-up (PgBouncer)."
  type        = bool
  default     = true
}
variable "use_spot" {
  description = "Run on FARGATE_SPOT (non-production workers)."
  type        = bool
  default     = false
}
variable "tags" {
  type    = map(string)
  default = {}
}

data "aws_region" "current" {}

locals {
  app = merge(
    {
      name                   = "app"
      image                  = var.image
      essential              = true
      stopTimeout            = var.stop_timeout
      environment            = [for k, v in var.environment : { name = k, value = v }]
      secrets                = [for k, v in var.secrets : { name = k, valueFrom = v }]
      readonlyRootFilesystem = var.readonly_root_filesystem
      linuxParameters        = { initProcessEnabled = true }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = var.log_group_name
          awslogs-region        = data.aws_region.current.region
          awslogs-stream-prefix = var.name
        }
      }
    },
    var.command == null ? {} : { command = var.command },
    var.container_port == null ? {} : {
      portMappings = [{ containerPort = var.container_port, protocol = "tcp" }]
    },
    var.health_command == null ? {} : {
      healthCheck = { command = var.health_command, interval = 15, timeout = 5, retries = 3, startPeriod = 30 }
    },
  )
  adot = var.metrics == null ? [] : [{
    name      = "adot"
    image     = "public.ecr.aws/aws-observability/aws-otel-collector:v0.43.3"
    essential = false
    environment = [{
      name = "AOT_CONFIG_CONTENT"
      value = yamlencode({
        receivers = {
          prometheus = {
            config = {
              scrape_configs = [{
                job_name        = var.name
                scrape_interval = "15s"
                static_configs  = [{ targets = ["localhost:${var.metrics.port}"] }]
              }]
            }
          }
        }
        exporters = {
          prometheusremotewrite = {
            endpoint = var.metrics.remote_write_url
            auth     = { authenticator = "sigv4auth" }
          }
        }
        extensions = { sigv4auth = { region = var.metrics.region, service = "aps" } }
        service = {
          extensions = ["sigv4auth"]
          pipelines  = { metrics = { receivers = ["prometheus"], exporters = ["prometheusremotewrite"] } }
        }
      })
    }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = var.log_group_name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "${var.name}-adot"
      }
    }
  }]
}

resource "aws_security_group" "task" {
  name        = var.name
  description = "${var.name} tasks"
  vpc_id      = var.vpc_id
  tags        = var.tags
}

# Least-privilege egress: HTTPS (AWS APIs not covered by endpoints, payment gateway, AMP),
# SMTP submission, and anything inside the VPC (PgBouncer, RDS, Redis, endpoints).
resource "aws_vpc_security_group_egress_rule" "task_vpc" {
  security_group_id = aws_security_group.task.id
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "-1"
}

#trivy:ignore:AVD-AWS-0104 HTTPS and SMTP submission to external providers only (ports restricted).
resource "aws_vpc_security_group_egress_rule" "task_internet" {
  for_each          = toset(["443", "587"])
  security_group_id = aws_security_group.task.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.key)
  to_port           = tonumber(each.key)
}

resource "aws_vpc_security_group_ingress_rule" "from_alb" {
  count                        = var.load_balancer == null ? 0 : 1
  security_group_id            = aws_security_group.task.id
  referenced_security_group_id = var.load_balancer.alb_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = var.container_port
  to_port                      = var.container_port
}

resource "aws_vpc_security_group_ingress_rule" "from_peers" {
  for_each                     = toset(var.ingress_security_group_ids)
  security_group_id            = aws_security_group.task.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = var.container_port
  to_port                      = var.container_port
}

resource "aws_iam_role" "execution" {
  name = "${var.name}-exec"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  count = length(var.execution_secret_arns) > 0 ? 1 : 0
  role  = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = var.execution_secret_arns }],
      length(var.kms_key_arns) > 0 ? [{ Effect = "Allow", Action = ["kms:Decrypt"], Resource = var.kms_key_arns }] : [],
    )
  })
}

resource "aws_iam_role" "task" {
  name = "${var.name}-task"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags = var.tags
}

resource "aws_iam_role_policy" "task" {
  count  = var.task_role_policy_json == null ? 0 : 1
  role   = aws_iam_role.task.id
  policy = var.task_role_policy_json
}

resource "aws_iam_role_policy" "task_metrics" {
  count = var.metrics == null ? 0 : 1
  role  = aws_iam_role.task.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["aps:RemoteWrite"], Resource = "*" }]
  })
}

resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode(concat([local.app], local.adot))
  tags                  = var.tags
}

resource "aws_lb_target_group" "this" {
  count                = var.load_balancer == null ? 0 : 1
  name                 = substr(var.name, 0, 32)
  port                 = var.container_port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = max(5, var.stop_timeout - 10)
  health_check {
    path                = var.load_balancer.health_path
    matcher             = "200"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  tags = var.tags
}

resource "aws_lb_listener_rule" "this" {
  count        = var.load_balancer == null ? 0 : 1
  listener_arn = var.load_balancer.listener_arn
  priority     = var.load_balancer.priority
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this[0].arn
  }
  condition {
    host_header { values = [var.load_balancer.host_header] }
  }
}

resource "aws_ecs_service" "this" {
  name                               = var.name
  cluster                            = var.cluster_arn
  task_definition                    = aws_ecs_task_definition.this.arn
  desired_count                      = var.desired_count
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  enable_execute_command             = false
  propagate_tags                     = "SERVICE"

  capacity_provider_strategy {
    capacity_provider = var.use_spot ? "FARGATE_SPOT" : "FARGATE"
    weight            = 1
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = false
  }

  dynamic "service_registries" {
    for_each = var.discovery_namespace_id == null ? [] : [1]
    content {
      registry_arn = aws_service_discovery_service.this[0].arn
    }
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  dynamic "load_balancer" {
    for_each = var.load_balancer == null ? [] : [1]
    content {
      target_group_arn = aws_lb_target_group.this[0].arn
      container_name   = "app"
      container_port   = var.container_port
    }
  }

  lifecycle {
    # Deployments update the task definition and count through CI, not Terraform drift.
    ignore_changes = [desired_count]
  }
  tags = var.tags
}

resource "aws_service_discovery_service" "this" {
  count = var.discovery_namespace_id == null ? 0 : 1
  name  = var.name
  dns_config {
    namespace_id   = var.discovery_namespace_id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
  health_check_custom_config {}
  tags = var.tags
}

resource "aws_appautoscaling_target" "this" {
  service_namespace  = "ecs"
  resource_id        = "service/${var.cluster_name}/${aws_ecs_service.this.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.min_count
  max_capacity       = var.max_count
}

# The API is CPU-bound per process (Phase 8: one Node.js event loop saturates a core), so it scales on CPU.
resource "aws_appautoscaling_policy" "cpu" {
  name               = "${var.name}-cpu"
  service_namespace  = aws_appautoscaling_target.this.service_namespace
  resource_id        = aws_appautoscaling_target.this.resource_id
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  policy_type        = "TargetTrackingScaling"
  target_tracking_scaling_policy_configuration {
    target_value       = var.cpu_target_percent
    scale_in_cooldown  = 120
    scale_out_cooldown = 30
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

output "security_group_id" { value = aws_security_group.task.id }
output "service_name" { value = aws_ecs_service.this.name }
output "task_definition_arn" { value = aws_ecs_task_definition.this.arn }
output "task_role_arn" { value = aws_iam_role.task.arn }
output "execution_role_arn" { value = aws_iam_role.execution.arn }
output "target_group_arn_suffix" {
  value = var.load_balancer == null ? null : aws_lb_target_group.this[0].arn_suffix
}
