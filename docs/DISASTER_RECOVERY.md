# FoodStack — Backup and Disaster Recovery

_Applies to the AWS design in `infrastructure/aws` (not yet provisioned). Every procedure below is
**untested on AWS** until it is drilled. Record each drill in §6._

## 1. Targets

| Tier                                | RPO (data loss)                             | RTO (downtime) | Covered by                                                                                       |
| ----------------------------------- | ------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------ |
| Single task / AZ failure            | 0                                           | < 2 min        | ECS replaces tasks; ALB health checks; Multi-AZ RDS failover (~1–2 min); Redis Multi-AZ failover |
| Bad deploy                          | 0                                           | < 10 min       | ECS circuit breaker rollback; redeploy the previous image tag                                    |
| Data corruption / bad migration     | ≤ 5 min                                     | < 1 h          | RDS point-in-time restore (PITR)                                                                 |
| Accidental deletion of the database | ≤ 24 h (≤ 5 min if PITR is still available) | < 2 h          | Final snapshot, AWS Backup vault (locked in prod)                                                |
| Region loss                         | ≤ 24 h                                      | < 8 h          | AWS Backup cross-region copy (prod); Terraform for the DR region                                 |

**What is not backed up, by design:**

- **Redis.** It holds rate-limit counters, cache entries and BullMQ jobs. Every email job is
  first written to the PostgreSQL outbox, and outbox recovery republishes pending rows (Phase 5),
  so losing Redis loses no email. Snapshots are taken anyway, for faster warm-up.
- **Application containers.** They are stateless; images are kept in ECR (last 50, immutable tags).

## 2. Backups in place (design)

| Data            | Mechanism                                                   | Retention (prod)                  |
| --------------- | ----------------------------------------------------------- | --------------------------------- |
| PostgreSQL      | RDS automated backups + transaction logs (PITR)             | 35 days                           |
| PostgreSQL      | AWS Backup daily snapshot                                   | 35 days, copied to the DR region  |
| PostgreSQL      | AWS Backup monthly snapshot                                 | 365 days, copied to the DR region |
| PostgreSQL      | Final snapshot on instance deletion; deletion protection on | until deleted by hand             |
| Backup vault    | Vault lock (compliance mode after 3 days)                   | backups can't be deleted early    |
| Redis           | ElastiCache daily snapshot                                  | 7 days                            |
| Terraform state | S3 versioning + KMS                                         | all versions                      |
| Secrets         | Secrets Manager (deletion recovery window 30 days)          | —                                 |

## 3. Runbooks

### 3.1 Restore to a point in time (bad migration, corrupted data)

1. **Freeze writes.** Scale the API and worker to 0, or put the ALB rule on a maintenance response:
   ```bash
   aws ecs update-service --cluster foodstack-prod --service foodstack-prod-api --desired-count 0
   ```
2. **Restore to a new instance**, a minute before the incident (UTC):
   ```bash
   aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier foodstack-prod \
     --target-db-instance-identifier foodstack-prod-pitr --restore-time 2026-11-06T08:41:00Z \
     --db-subnet-group-name foodstack-prod --vpc-security-group-ids <db-sg> --multi-az \
     --db-parameter-group-name foodstack-prod-pg18
   aws rds wait db-instance-available --db-instance-identifier foodstack-prod-pitr
   ```
3. **Verify the restored data** read-only: row counts per tenant, the last orders, and `typeorm_migrations`.
4. **Cut over.** Point PgBouncer `DB_HOST` (Terraform `module.database`, or the task env) at the new endpoint,
   then redeploy PgBouncer. Alternatively, rename instances (`modify-db-instance --new-db-instance-identifier`)
   so the endpoint stays the same.
5. **Scale the API and worker back up.** Watch the error-rate and latency alerts.
6. **Keep the damaged instance** (renamed) until the post-mortem is done, then delete it with a final snapshot.

### 3.2 Restore a deleted database

Run `aws rds restore-db-instance-from-db-snapshot` from the final snapshot, or start an AWS Backup restore job from the vault.
Then follow steps 3–5 of §3.1.

### 3.3 Region loss (prod)

1. Pick the latest recovery point in the DR vault (`foodstack-prod-dr`, `ap-southeast-1`).
2. Apply `envs/prod` against the DR region with a separate state key. Use `-var region=ap-southeast-1` and a new
   `vpc_cidr`. Restore RDS from the copied snapshot, then point `module.database` at it (snapshot identifier).
3. Copy the secrets from the primary region if it is reachable. Otherwise recreate them from the offline escrow copy
   of the JWT and MFA keys.
   **The MFA encryption key must be the original one:** TOTP secrets are encrypted with it, and losing it means every
   Super Admin re-enrols.
4. Push the image to the DR region's ECR (or enable ECR cross-region replication), then deploy.
5. Switch the Route 53 record to the DR ALB.

### 3.4 Redis loss

No restore is needed. Expect the following while Redis is down:

- sign-in, MFA and password reset return **503** (fail closed, by decision);
- cached reads fall back to PostgreSQL;
- email stays in the outbox.

When Redis returns, everything recovers on its own. This behaviour was verified locally (§6).
If the replication group is lost, recreate it with Terraform and update the `REDIS_HOST` env var, then redeploy the API and worker.

### 3.5 Key or secret compromise

| Secret                | Steps                                                                                                  | Effect                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| JWT key               | Rotate `jwt_private_key` / `jwt_public_key` (new `JWT_KEY_ID`), redeploy                               | All access tokens are invalidated within 15 minutes; refresh tokens keep working. |
| Database app password | Change it with `ALTER ROLE`, update the secret, redeploy PgBouncer                                     |                                                                                   |
| Redis AUTH token      | `terraform apply` with a new random value (rotation needs `auth_token_update_strategy`)                |                                                                                   |
| MFA encryption key    | Do **not** rotate casually: it needs re-encryption of stored TOTP secrets (planned tooling, not built) |                                                                                   |

## 4. Key escrow (do before go-live)

Keep an offline, access-controlled copy of `mfa_encryption_key` and the JWT key pair, for
example in a second AWS account's Secrets Manager or a hardware-backed vault. Losing the MFA key is
not recoverable from backups, because database backups contain only ciphertext.

## 5. Drill schedule

- **Quarterly:** PITR restore into staging from a prod snapshot copy; measure RTO; verify data.
- **Twice a year:** DR-region rebuild in a sandbox account.
- **Each release with migrations:** test the migration on a restored copy of prod first.

## 6. Evidence so far (local, not AWS)

| Test                                                                | Result                                    | Where                             |
| ------------------------------------------------------------------- | ----------------------------------------- | --------------------------------- |
| `pg_dump` backup and restore into a scratch DB, row counts compared | Pass (test DB 1.45M orders; dev DB twice) | `docs/PHASE_3_FINAL_REPORT.md` §2 |
| Migrations fully revert and re-apply                                | Pass (`database.int-spec`, every run)     | integration suite                 |
| Redis outage: auth 503, reads continue, automatic recovery          | Pass (HA rehearsal)                       | `docs/HA_MONITORING_REPORT.md`    |
| Worker outage: email kept in the outbox, delivered after restart    | Pass                                      | `docs/PHASE_5_FINAL_REPORT.md`    |
| API replica stop under load: no client errors                       | Pass                                      | `docs/HA_MONITORING_REPORT.md`    |
| RDS PITR, AWS Backup restore, cross-region restore                  | **Not tested** (no AWS environment)       | —                                 |
