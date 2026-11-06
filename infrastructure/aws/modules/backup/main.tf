# AWS Backup on top of RDS automated backups (PITR):
# - a daily snapshot kept `daily_retention_days`;
# - a monthly snapshot kept `monthly_retention_days`;
# - each copied to a vault in a second region (regional disaster).
# The vault has a lock (compliance mode in production) so backups cannot be deleted early, even
# by an administrator or a compromised account.

terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = "~> 6.0"
      configuration_aliases = [aws.dr]
    }
  }
}

variable "name" { type = string }
variable "resource_arns" {
  description = "RDS instance ARN(s) to back up."
  type        = list(string)
}
variable "daily_retention_days" { type = number }
variable "monthly_retention_days" { type = number }
variable "copy_to_dr_region" { type = bool }
variable "vault_lock" {
  description = "Enable the vault lock (minimum retention enforced). Compliance mode is irreversible after the grace period."
  type        = bool
}
variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_kms_key" "backup" {
  description         = "${var.name} backup vault"
  enable_key_rotation = true
  tags                = var.tags
}

resource "aws_backup_vault" "primary" {
  name        = var.name
  kms_key_arn = aws_kms_key.backup.arn
  tags        = var.tags
}

resource "aws_backup_vault_lock_configuration" "primary" {
  count               = var.vault_lock ? 1 : 0
  backup_vault_name   = aws_backup_vault.primary.name
  min_retention_days  = 7
  max_retention_days  = 400
  changeable_for_days = 3 # grace period, then compliance mode (cannot be removed)
}

resource "aws_kms_key" "dr" {
  count               = var.copy_to_dr_region ? 1 : 0
  provider            = aws.dr
  description         = "${var.name} DR backup vault"
  enable_key_rotation = true
  tags                = var.tags
}

resource "aws_backup_vault" "dr" {
  count       = var.copy_to_dr_region ? 1 : 0
  provider    = aws.dr
  name        = "${var.name}-dr"
  kms_key_arn = aws_kms_key.dr[0].arn
  tags        = var.tags
}

resource "aws_backup_plan" "this" {
  name = var.name

  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.primary.name
    schedule          = "cron(0 21 * * ? *)" # 02:30 IST, after the RDS backup window
    start_window      = 60
    completion_window = 360
    lifecycle { delete_after = var.daily_retention_days }
    dynamic "copy_action" {
      for_each = var.copy_to_dr_region ? [1] : []
      content {
        destination_vault_arn = aws_backup_vault.dr[0].arn
        lifecycle { delete_after = var.daily_retention_days }
      }
    }
  }

  rule {
    rule_name         = "monthly"
    target_vault_name = aws_backup_vault.primary.name
    schedule          = "cron(0 22 1 * ? *)"
    lifecycle { delete_after = var.monthly_retention_days }
    dynamic "copy_action" {
      for_each = var.copy_to_dr_region ? [1] : []
      content {
        destination_vault_arn = aws_backup_vault.dr[0].arn
        lifecycle { delete_after = var.monthly_retention_days }
      }
    }
  }
  tags = var.tags
}

resource "aws_iam_role" "backup" {
  name = "${var.name}-backup"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "backup.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_iam_role_policy_attachment" "restore" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"
}

resource "aws_backup_selection" "this" {
  name         = var.name
  plan_id      = aws_backup_plan.this.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = var.resource_arns
}

output "vault_name" { value = aws_backup_vault.primary.name }
output "plan_id" { value = aws_backup_plan.this.id }
