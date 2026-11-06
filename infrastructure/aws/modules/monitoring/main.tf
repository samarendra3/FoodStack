# Monitoring:
# - Amazon Managed Service for Prometheus (AMP) receives the app metrics (ADOT sidecars) and evaluates
#   the same alert rules as the local stack (infrastructure/monitoring/prometheus/alerts.yml);
# - CloudWatch alarms cover AWS-managed resources (ALB, ECS, RDS, ElastiCache);
# - every alarm notifies one SNS topic (subscribe email, PagerDuty or chat to it).
# Grafana: Amazon Managed Grafana with the AMP data source, importing
# infrastructure/monitoring/grafana/dashboards/foodstack-overview.json (needs IAM Identity Center,
# so it is created outside this module; see README).

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "name" { type = string }
variable "alert_emails" {
  type    = list(string)
  default = []
}
variable "alerts_rules_file" {
  description = "Path to the Prometheus rule file shared with the local stack."
  type        = string
}
variable "alb_arn_suffix" { type = string }
variable "api_target_group_arn_suffix" { type = string }
variable "cluster_name" { type = string }
variable "ecs_services" {
  description = "service name → minimum running tasks before alarming"
  type        = map(number)
}
variable "db_instance_id" { type = string }
variable "redis_replication_group_id" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}

data "aws_caller_identity" "current" {}

# Customer-managed key: CloudWatch alarms and AMP Alertmanager must be allowed to use it.
resource "aws_kms_key" "alerts" {
  description         = "${var.name} alert topic"
  enable_key_rotation = true
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "Account"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "AlarmPublishers"
        Effect    = "Allow"
        Principal = { Service = ["cloudwatch.amazonaws.com", "aps.amazonaws.com"] }
        Action    = ["kms:Decrypt", "kms:GenerateDataKey*"]
        Resource  = "*"
      },
    ]
  })
  tags = var.tags
}

resource "aws_sns_topic" "alerts" {
  name              = "${var.name}-alerts"
  kms_master_key_id = aws_kms_key.alerts.arn
  tags              = var.tags
}

resource "aws_sns_topic_policy" "alerts" {
  arn = aws_sns_topic.alerts.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AlarmPublishers"
      Effect    = "Allow"
      Principal = { Service = ["cloudwatch.amazonaws.com", "aps.amazonaws.com"] }
      Action    = ["sns:Publish"]
      Resource  = aws_sns_topic.alerts.arn
      Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
    }]
  })
}

resource "aws_sns_topic_subscription" "email" {
  for_each  = toset(var.alert_emails)
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

resource "aws_prometheus_workspace" "this" {
  alias = var.name
  tags  = var.tags
}

resource "aws_prometheus_rule_group_namespace" "foodstack" {
  name         = "foodstack"
  workspace_id = aws_prometheus_workspace.this.id
  data         = file(var.alerts_rules_file)
}

resource "aws_prometheus_alert_manager_definition" "this" {
  workspace_id = aws_prometheus_workspace.this.id
  definition = yamlencode({
    alertmanager_config = yamlencode({
      route = { receiver = "sns", group_by = ["alertname", "severity"], repeat_interval = "4h" }
      receivers = [{
        name        = "sns"
        sns_configs = [{ topic_arn = aws_sns_topic.alerts.arn, sigv4 = { region = data.aws_region.current.region } }]
      }]
    })
  })
}

data "aws_region" "current" {}

locals {
  alarms = {
    alb-5xx = {
      namespace  = "AWS/ApplicationELB", metric = "HTTPCode_Target_5XX_Count", stat = "Sum",
      threshold  = 50, period = 300, comparison = "GreaterThanThreshold",
      dimensions = { LoadBalancer = var.alb_arn_suffix }
    }
    alb-unhealthy-targets = {
      namespace  = "AWS/ApplicationELB", metric = "UnHealthyHostCount", stat = "Maximum",
      threshold  = 0, period = 60, comparison = "GreaterThanThreshold",
      dimensions = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.api_target_group_arn_suffix }
    }
    alb-p95-latency = {
      namespace  = "AWS/ApplicationELB", metric = "TargetResponseTime", stat = "p95",
      threshold  = 0.3, period = 300, comparison = "GreaterThanThreshold",
      dimensions = { LoadBalancer = var.alb_arn_suffix }
    }
    rds-cpu = {
      namespace  = "AWS/RDS", metric = "CPUUtilization", stat = "Average",
      threshold  = 80, period = 300, comparison = "GreaterThanThreshold",
      dimensions = { DBInstanceIdentifier = var.db_instance_id }
    }
    rds-free-storage = {
      namespace  = "AWS/RDS", metric = "FreeStorageSpace", stat = "Minimum",
      threshold  = 10737418240, period = 300, comparison = "LessThanThreshold",
      dimensions = { DBInstanceIdentifier = var.db_instance_id }
    }
    rds-connections = {
      namespace  = "AWS/RDS", metric = "DatabaseConnections", stat = "Maximum",
      threshold  = 160, period = 300, comparison = "GreaterThanThreshold",
      dimensions = { DBInstanceIdentifier = var.db_instance_id }
    }
    rds-replica-lag = {
      namespace  = "AWS/RDS", metric = "ReplicaLag", stat = "Maximum",
      threshold  = 60, period = 300, comparison = "GreaterThanThreshold",
      dimensions = { DBInstanceIdentifier = var.db_instance_id }
    }
    redis-memory = {
      namespace  = "AWS/ElastiCache", metric = "DatabaseMemoryUsagePercentage", stat = "Maximum",
      threshold  = 80, period = 300, comparison = "GreaterThanThreshold",
      dimensions = { ReplicationGroupId = var.redis_replication_group_id }
    }
    redis-cpu = {
      namespace  = "AWS/ElastiCache", metric = "EngineCPUUtilization", stat = "Average",
      threshold  = 80, period = 300, comparison = "GreaterThanThreshold",
      dimensions = { ReplicationGroupId = var.redis_replication_group_id }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "this" {
  for_each            = local.alarms
  alarm_name          = "${var.name}-${each.key}"
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  extended_statistic  = startswith(each.value.stat, "p") ? each.value.stat : null
  statistic           = startswith(each.value.stat, "p") ? null : each.value.stat
  threshold           = each.value.threshold
  period              = each.value.period
  comparison_operator = each.value.comparison
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  dimensions          = each.value.dimensions
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "ecs_running" {
  for_each            = var.ecs_services
  alarm_name          = "${var.name}-${each.key}-running"
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  statistic           = "Minimum"
  threshold           = each.value
  period              = 60
  evaluation_periods  = 3
  comparison_operator = "LessThanThreshold"
  dimensions          = { ClusterName = var.cluster_name, ServiceName = each.key }
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  tags                = var.tags
}

output "amp_workspace_id" { value = aws_prometheus_workspace.this.id }
output "amp_remote_write_url" {
  value = "${aws_prometheus_workspace.this.prometheus_endpoint}api/v1/remote_write"
}
output "alerts_topic_arn" { value = aws_sns_topic.alerts.arn }
