# FoodStack on AWS (Terraform)

> **Status: written and validated, NOT provisioned.** `terraform fmt`, `terraform validate`
> (all four roots) and a Trivy IaC scan (0 HIGH/CRITICAL) pass. No `plan` or `apply` has been
> run. Applying creates resources that cost money, so it needs the owner's explicit approval
> (see "Cost and approval").

## Architecture

```
                 Route 53 ─► ACM certificate (TLS 1.2/1.3 policy)
                      │
Internet ──HTTPS──► ALB (public subnets, WAF managed rules, HTTP→HTTPS redirect, access logs)
                      │  target group health check: /api/v1/health/live (liveness)
                      ▼
              ECS Fargate: API service (private subnets, autoscaling on CPU, ≥2 tasks in prod)
                 │   + ADOT sidecar: scrapes :9464/metrics → Amazon Managed Prometheus
                 │
                 ├──► PgBouncer service (transaction pooling, Cloud Map DNS) ──TLS──► RDS PostgreSQL 18
                 │                                                    (isolated subnets, Multi-AZ in prod,
                 │                                                     KMS, PITR, AWS Backup + DR copy)
                 └──► ElastiCache Redis (isolated subnets, TLS + AUTH, noeviction, Multi-AZ failover)
                          ▲
              ECS Fargate: worker service (BullMQ email; + ADOT sidecar :9465)

Migrations: a one-off ECS task (schema owner, direct to RDS) run by the deploy workflow.
Secrets:    AWS Secrets Manager (KMS), injected as env vars by ECS; the RDS master password is
            managed by RDS itself. No secret value is in Terraform variables, code or CI logs.
Monitoring: AMP (same alert rules as the local stack) + CloudWatch alarms → SNS (KMS).
```

| Layer         | Resource                                                                                                                        | Why                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network       | VPC with public, private and isolated subnets over 2–3 AZs; NAT; VPC endpoints (S3, ECR, Secrets Manager, Logs, AMP); flow logs | Databases have no internet route. Endpoints keep AWS traffic off the NAT.                                                                                                                                      |
| Edge          | ALB + ACM + WAF (AWS common rules, known bad inputs)                                                                            | TLS termination and basic L7 protection.                                                                                                                                                                       |
| Compute       | ECS Fargate services: `api`, `worker`, `pgbouncer`                                                                              | Same image as `infrastructure/docker/api.Dockerfile`. No servers to patch.                                                                                                                                     |
| Pooling       | PgBouncer, transaction mode                                                                                                     | **Verified locally:** RLS context and `statement_timeout` are transaction-local, so connections can be shared (HA rehearsal). RDS Proxy was not chosen: its session pinning has not been tested with this app. |
| Database      | RDS PostgreSQL 18, gp3, KMS, `rds.force_ssl`, `pg_stat_statements`, slow-query log ≥ 500 ms                                     |                                                                                                                                                                                                                |
| Cache / queue | ElastiCache Redis 7.1, TLS, AUTH, `maxmemory-policy=noeviction`                                                                 | BullMQ shares this Redis, so its keys must never be evicted.                                                                                                                                                   |
| Secrets       | Secrets Manager + KMS                                                                                                           | Values are set out of band (below).                                                                                                                                                                            |
| Backups       | RDS automated backups (PITR) + AWS Backup daily/monthly, cross-region copy and vault lock in prod                               | See `docs/DISASTER_RECOVERY.md`.                                                                                                                                                                               |
| Monitoring    | AMP workspace + rule group (`infrastructure/monitoring/prometheus/alerts.yml`), CloudWatch alarms, SNS                          | Grafana: Amazon Managed Grafana (needs IAM Identity Center). Import `infrastructure/monitoring/grafana/dashboards/foodstack-overview.json`.                                                                    |
| CI/CD         | `bootstrap/`: state bucket and GitHub OIDC deploy roles. `.github/workflows/deploy.yml`: manual deploy                          | No long-lived AWS keys. Prod deploys require approval in the `production` environment.                                                                                                                         |

## Environments

|                     | dev                               | staging                        | prod                                                       |
| ------------------- | --------------------------------- | ------------------------------ | ---------------------------------------------------------- |
| AZs / NAT           | 2 / one shared                    | 2 / one shared                 | 3 / one per AZ                                             |
| API tasks (min–max) | 1–2 (0.5 vCPU)                    | 2–4 (0.5 vCPU)                 | 3–12 (1 vCPU)                                              |
| Workers             | 1 (Spot)                          | 1–2 (Spot)                     | 2–6                                                        |
| PgBouncer tasks     | 1                                 | 2                              | 2                                                          |
| RDS                 | db.t4g.micro, single-AZ, 7 d PITR | db.t4g.medium, single-AZ, 14 d | db.m7g.large, **Multi-AZ**, 35 d, deletion protection      |
| Redis               | 1 node                            | primary + 1 replica            | primary + 2 replicas, Multi-AZ                             |
| AWS Backup          | 7 d daily                         | 14 d daily, 90 d monthly       | 35 d daily, 1 y monthly, **cross-region copy, vault lock** |
| `NODE_ENV`          | staging                           | staging                        | production                                                 |

Each environment has its own state file and, preferably, its own AWS account (AWS Organizations).
Sizes are starting points. Adjust them after the ≥16 GB load tests (`tests/load/large-dataset/run.sh`).

## Cost and approval

**Nothing here has been applied.** Applying any environment creates billable resources:

- NAT gateways (hourly + data);
- the ALB;
- Fargate tasks;
- RDS (instance, storage, backups, Performance Insights);
- ElastiCache;
- interface VPC endpoints (hourly per AZ);
- AMP (samples ingested);
- WAF (rules + requests);
- Secrets Manager (per secret);
- KMS keys;
- CloudWatch Logs;
- AWS Backup storage and cross-region copies.

Estimate with the AWS Pricing Calculator for the chosen region before approval. No figures are
given here because none were computed from real pricing data.

## Applying (only after approval)

```bash
# 0. Tools: Terraform >= 1.10, AWS CLI with an administrator profile for the target account.
# 1. One-time bootstrap (state bucket + GitHub OIDC roles):
cd infrastructure/aws/bootstrap && terraform init && terraform apply
# 2. Per environment:
cd ../envs/staging
cp backend.hcl.example backend.hcl            # fill in the account id
terraform init -backend-config=backend.hcl
terraform plan -var image_tag=<git-sha> -var route53_zone_id=<zone> -out plan.tfplan
#    review the plan with the owner, then:
terraform apply plan.tfplan
# 3. Set secret values (never in Terraform):
aws secretsmanager put-secret-value --secret-id foodstack-staging/jwt_private_key --secret-string "$(...)"
#    ...jwt_public_key, mfa_encryption_key (openssl rand -base64 32), database_app_password,
#    smtp_password, razorpay_key_secret, razorpay_webhook_secret
# 4. Create the restricted app role once (the migration does not create login roles):
#    connect as foodstack_owner (password: RDS-managed secret) and run
#    infrastructure/docker/postgres/init/02-app-role.sh logic with the database_app_password value.
# 5. First deploy: GitHub → Actions → Deploy → environment=staging (builds, migrates, rolls out).
```

## Security notes

- **Ingress:** only the ALB is public. The API accepts traffic only from the ALB security group, PgBouncer only from API and worker,
  RDS only from PgBouncer and the migration task, Redis only from API and worker.
- **Egress:** tasks may reach the VPC plus TCP 443/587 only. The migration task may reach the VPC only.
- **Metrics:** `/metrics` binds to 127.0.0.1 inside each task, and only the ADOT sidecar reads it.
- **TLS everywhere outside the task:** client→ALB (TLS 1.2+), PgBouncer→RDS (`require`), app→Redis (TLS).
  API→PgBouncer stays inside the private subnet without TLS. If policy requires encryption on
  every hop, add PgBouncer client TLS (`CLIENT_TLS_*`) and set `DATABASE_SSL=true`.
- **Startup checks:** production config validation refuses unsafe settings at start, so a misconfigured task fails its deployment
  and the circuit breaker rolls it back.
