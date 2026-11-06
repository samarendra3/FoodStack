# One-time, per AWS account: remote state bucket and the GitHub Actions deploy role (OIDC: CI
# never stores long-lived AWS keys). Applied once by an administrator, with local state that is
# kept safe or migrated into the bucket afterwards.
# NOT APPLIED. See ../README.md ("Cost and approval").

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "region" {
  type    = string
  default = "ap-south-1"
}
variable "github_repository" {
  description = "owner/name allowed to assume the deploy role"
  type        = string
  default     = "samarendra3/FoodStack"
}

provider "aws" {
  region = var.region
}

data "aws_caller_identity" "current" {}

resource "aws_kms_key" "state" {
  description         = "Terraform state"
  enable_key_rotation = true
}

resource "aws_s3_bucket" "state" {
  bucket = "foodstack-terraform-state-${data.aws_caller_identity.current.account_id}"
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "state_tls_only" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

# One role per environment; production is restricted to the protected `production` GitHub
# environment (required reviewers), so a deploy needs an explicit approval.
resource "aws_iam_role" "deploy" {
  for_each = toset(["dev", "staging", "prod"])
  name     = "foodstack-deploy-${each.key}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repository}:environment:${each.key == "prod" ? "production" : each.key}"
        }
      }
    }]
  })
}

# Deploy permissions: push images, run the migration task, update services, read outputs.
# Terraform itself (infrastructure changes) is applied by an administrator, not by CI.
resource "aws_iam_role_policy" "deploy" {
  for_each = aws_iam_role.deploy
  role     = each.value.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      {
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:DescribeImages"]
        Resource = "arn:aws:ecr:${var.region}:${data.aws_caller_identity.current.account_id}:repository/foodstack-${each.key}/*"
      },
      {
        Effect    = "Allow"
        Action    = ["ecs:RunTask", "ecs:DescribeTasks", "ecs:DescribeServices", "ecs:UpdateService", "ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:ResourceTag/Environment" = each.key } }
      },
      { Effect = "Allow", Action = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"], Resource = "*" },
      {
        Effect    = "Allow"
        Action    = "iam:PassRole"
        Resource  = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/foodstack-${each.key}-*"
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
      { Effect = "Allow", Action = ["logs:GetLogEvents", "logs:FilterLogEvents"], Resource = "*" },
    ]
  })
}

output "state_bucket" { value = aws_s3_bucket.state.bucket }
output "deploy_role_arns" { value = { for k, r in aws_iam_role.deploy : k => r.arn } }
