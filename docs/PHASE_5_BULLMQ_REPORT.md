# Phase 5 — Transactional Email Outbox & BullMQ Worker: Report

_Date: 2026-11-04 · Precondition: `docs/PHASE_5_BULLMQ_AUDIT.md` (approved decisions below) · Status: implemented and tested, **not committed**, awaiting review._

## 1. Summary

**Implemented (approved scope only):**

- A transactional email outbox.
- An encrypted payload, erased after delivery.
- One BullMQ email worker in a separate container, from the same image.
- Post-commit publishing with stable job ids.
- Periodic recovery.
- Super Admin queue monitoring.
- Removal of the four unused queue registrations.

**Not built:** low-stock alerts, invoice PDFs, sales reports, order notifications and onboarding mail.

**Unchanged:**

- The subscription expiry timer.
- Redis `noeviction` (already explicit in Compose).
- Phase 4 caching.
- Rate limiting.
- Two-factor authentication. The only edit there is the missing-key warning text, which now also mentions email.

All 6 email call sites now queue inside the transaction of the change they announce:

| Email                                   | Transaction                                           | Before                                 |
| --------------------------------------- | ----------------------------------------------------- | -------------------------------------- |
| Password reset                          | token issue                                           | Sent after commit                      |
| Account locked                          | lockout                                               | Fire-and-forget                        |
| Team invitation / resend                | membership + token                                    | Sent after commit, failure only logged |
| Owner welcome (access request approved) | tenant provisioning                                   | Sent after commit                      |
| Access request rejected                 | rejection                                             | Sent after commit                      |
| New-request notice to Super Admins      | its own platform transaction (best effort, as before) | Sent after commit                      |

## 2. Files

| File                                                                                                     | Change                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/database/migrations/1798000023000-EmailOutbox.ts`, `migration-list.ts`                              | **New** `email_outbox` table, indexes, RLS                                                                                                               |
| `src/modules/notifications/email-outbox.service.ts`                                                      | **New.** Producer: encrypt + insert in the caller's transaction, after-commit publish                                                                    |
| `src/modules/notifications/email-delivery.service.ts`                                                    | **New.** Consumer logic: claim → decrypt → send → mark; error sanitizing                                                                                 |
| `src/modules/notifications/queue-monitor.service.ts`                                                     | **New.** Super Admin metrics                                                                                                                             |
| `src/modules/notifications/mail.service.ts`                                                              | `send()` (never threw) → `deliver()` (throws, bounded by `EMAIL_SEND_TIMEOUT_MS`)                                                                        |
| `src/modules/notifications/notifications.module.ts`                                                      | Provides the services above                                                                                                                              |
| `src/worker.ts`, `src/worker-health.ts`, `src/worker/*`                                                  | **New.** Worker entry point (no HTTP), health check, `EmailProcessor`, `OutboxRecoveryService`, `WorkerHeartbeatService`, `WorkerModule`                 |
| `src/queues/queue.constants.ts`                                                                          | Only `notifications` registered (`default`, `orders`, `inventory`, `reports` removed)                                                                    |
| `src/modules/auth/auth.service.ts`, `team/team.service.ts`, `access-requests/access-requests.service.ts` | Call sites queue inside their transactions. The recipient address is no longer logged (`safeSend` removed)                                               |
| `src/modules/platform/platform.controller.ts`                                                            | `GET /platform/queues`                                                                                                                                   |
| `src/modules/auth/mfa.service.ts`                                                                        | Warning text only                                                                                                                                        |
| `src/config/env.validation.ts`, `.env.example`                                                           | 8 new variables (§6)                                                                                                                                     |
| `apps/api/package.json`                                                                                  | `dev:worker`, `start:worker` scripts                                                                                                                     |
| `docker-compose.yml`                                                                                     | `worker` service                                                                                                                                         |
| `integration/email-outbox.int-spec.ts`                                                                   | **New**, 22 tests                                                                                                                                        |
| `integration/helpers.ts`, `setup-env.ts`, `auth/team/access-requests.int-spec.ts`                        | Tests drain the outbox through the worker's code path before reading mail. Tests use `QUEUE_PREFIX=foodstack-test` so they never feed a local dev worker |
| `perf/phase5-bullmq.perf-spec.ts`, `perf/results/phase5-bullmq.md`                                       | Benchmark and measured results                                                                                                                           |

## 3. Architecture

```
API request  ── db.run(scope) ─────────────────────────────────────────────┐
   business change + INSERT email_outbox(id uuid, tenant_id, kind,          │ one transaction
                                         payload = AES-256-GCM(message))    │ (rollback ⇒ no row)
   COMMIT ──────────────────────────────────────────────────────────────────┘
   afterCommit → queue.add('email', {outboxId, tenantId}, {jobId: outboxId})  (not awaited, 3 s cap)
                 → UPDATE published_at

worker container (node dist/worker.js, no HTTP)
   EmailProcessor (BullMQ, concurrency EMAIL_WORKER_CONCURRENCY)
     1. claim:  UPDATE … SET status='processing', attempts+1, locked_until=now()+claim
                 WHERE id=$1 AND tenant matches AND (pending OR processing with expired claim)
     2. decrypt in memory → MailService.deliver (timeout)
     3. UPDATE status='sent', sent_at, payload=NULL        (failure: back to pending / failed)
   OutboxRecoveryService (every OUTBOX_RECOVERY_INTERVAL_SECONDS, advisory lock)
     - publish unpublished rows; re-publish open rows whose job is gone or finished
     - delete sent/failed rows past retention
   WorkerHeartbeatService → heartbeat file (Docker health) + Redis key (monitoring)
```

**Table `email_outbox`:**

- **States:** `pending | processing | sent | failed`.
- **Check constraints:**
  - the payload is present exactly while the row is open;
  - `sent_at` ⇔ `sent`, `failed_at` ⇔ `failed`;
  - `last_error` ≤ 300 characters.
- **Indexes:**
  - open rows by `available_at` (recovery);
  - closed rows by `(status, updated_at)` (retention);
  - `tenant_id`.
- **Ids** are UUIDs generated in the API (`randomUUID`). The same value is the BullMQ job id.

**Redis connections.** Each API process now has 1 shared client and 1 queue connection, down from 1 + 5. Each worker process has 1 shared client (heartbeat), 1 queue connection (recovery and publish), plus BullMQ's worker connections (blocking + commands).

## 4. Retry and idempotency

| Concern                                  | Mechanism                                                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No duplicate queue insertion             | `jobId = outbox id`. BullMQ ignores an add for an existing id (tested: two publishes → one job)                                                                                                              |
| No duplicate processing                  | Atomic conditional `UPDATE` claim. A `sent` row is never sent again (`already_sent`). A row claimed by another worker raises `EmailBusyError` → retried later (tested: two concurrent deliveries → one send) |
| Retries                                  | `EMAIL_MAX_ATTEMPTS` (5), exponential backoff from 2 s. A retryable failure returns the row to `pending` with a sanitized `last_error`                                                                       |
| Permanent failure                        | Last attempt → `failed`, `failed_at`, **payload erased**. The BullMQ job is kept 7 days (last 5,000) with only the sanitized reason                                                                          |
| Send timeout                             | `EMAIL_SEND_TIMEOUT_MS` (15 s) overall, plus nodemailer connection/greeting/socket timeouts (tested with a hanging transport)                                                                                |
| Worker crash mid-job                     | BullMQ stalled-job recovery (`lockDuration` 60 s, `stalledInterval` 30 s, `maxStalledCount` 2). The outbox claim (`2 × send timeout + 30 s`) expires, and recovery re-publishes if the job is gone           |
| Redis down at commit                     | The request is unaffected (the publish isn't awaited; tested < 1 s). The row stays `published_at IS NULL`; recovery publishes it once Redis is back (tested)                                                 |
| Crash between publish and `published_at` | Recovery finds the live job (`waiting`/`active`/`delayed`) and leaves it alone (tested)                                                                                                                      |

**Known limitation: at-least-once, not exactly-once.** The mail server may accept a message, and then the worker dies or loses PostgreSQL before recording `sent`. In that case the claim expires and the email is sent again (tested and documented: `attempts` = 2, one more delivery). SMTP gives no way to make this exactly-once. The window is one send plus one `UPDATE`.

## 5. Security

- **Encryption.** AES-256-GCM with the existing helper (`core/security/crypto.ts`) and key (`MFA_ENCRYPTION_KEY`, required in staging/production by env validation).
  - The payload covers recipient, subject, text and HTML, including links with one-time tokens.
  - No plaintext column exists; tested: the token and address are not in the stored bytes, and a tampered payload fails to decrypt.
  - Decryption happens only in the worker, just before sending.
- **Payload erasure.** The payload is set to `NULL` on `sent` and on `failed`, enforced by a check constraint. Closed rows are deleted after 7 days (sent) or 30 days (failed). The one-time tokens themselves expire after 30 minutes (reset) or 72 hours (invitation).
- **Job data** is `{ outboxId, tenantId }` only.
- **Logs and job failure reasons** carry the job id, attempt number and a sanitized reason such as `Error:EENVELOPE:550` or `MailTimeoutError`. SMTP server text, which can echo the address, is never kept (tested: no `@` in `last_error`). The access-request log line that printed a recipient was removed.
- **Tenant isolation.**
  - Tenant mail is visible only to its tenant (RLS) and to the platform scope (the worker).
  - A tenant cannot insert mail for another tenant (RLS error, tested).
  - Untenanted mail can be inserted from any scope (password reset runs before sign-in) but read only by the platform scope.
  - The worker loads each row **under the tenant the job names** and also filters on it, so a forged or mismatched job finds nothing and fails without retry (`UnrecoverableError`, tested). Malformed jobs are rejected too.
- **Monitoring** (`GET /api/v1/platform/queues`).
  - Requires a Super Admin platform session (TOTP) with `platform:dashboard_view`; tested 401 and 403.
  - Returns counts, timing distributions, retry ratio, worker heartbeats and outbox counts only.
  - Tested: the response contains no address, `@`, `token=` or job id.

## 6. Configuration

| Variable                                                      | Default                       | Purpose                                                |
| ------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------ |
| `EMAIL_WORKER_CONCURRENCY`                                    | 5                             | Parallel sends per worker process                      |
| `EMAIL_SEND_TIMEOUT_MS`                                       | 15000                         | Bound on one SMTP delivery                             |
| `EMAIL_MAX_ATTEMPTS`                                          | 5                             | Attempts before `failed`                               |
| `OUTBOX_RECOVERY_INTERVAL_SECONDS`                            | 30                            | Recovery and retention pass (0 = off)                  |
| `OUTBOX_STALE_SECONDS`                                        | 60                            | Age after which a published-but-open row is re-checked |
| `OUTBOX_SENT_RETENTION_DAYS` / `OUTBOX_FAILED_RETENTION_DAYS` | 7 / 30                        | Deletion of closed rows                                |
| `WORKER_HEARTBEAT_FILE`                                       | `/tmp/foodstack-worker.alive` | Docker health check                                    |

`MFA_ENCRYPTION_KEY` must be set wherever email is queued, which means the API.

## 7. Deployment

- **Compose `worker` service.**
  - Same build as `api` and `migrate`; command `node dist/worker.js`.
  - Health check: `node dist/worker-health.js` (heartbeat younger than 30 s while the BullMQ worker runs).
  - `stop_grace_period: 45s`.
  - Depends on `migrate`, `postgres` and `redis`.
  - `SMTP_HOST=mailpit` in Compose.
- **Scaling:** `docker compose up -d --scale worker=N`.
- **API and worker are separate.**
  - The API process registers no processor and never sends mail.
  - The worker has no HTTP listener (verified: the only listening socket in the container is Docker's DNS resolver on 127.0.0.11).
- **Local without containers:** `pnpm --filter @foodstack/api dev:worker` next to `pnpm dev`. Without a worker, emails wait in the outbox and are delivered when one starts.

## 8. Tests (all run on 2026-11-04)

| Suite                                        | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integration/email-outbox.int-spec.ts` (new) | **22/22 passed.** Covers: in-transaction write + encryption + after-commit publish; rollback; tampered payload; API forgot-password queues instead of sending; duplicate publish → 1 job; Redis unavailable at publish → request unaffected → recovery publishes → sent; single send + no-op re-delivery; concurrent claim → one send; retry with sanitized error; permanent failure erases payload; SMTP timeout; RLS: other tenant/untenanted scope cannot read, cannot insert for another tenant; forged/malformed job → `UnrecoverableError`; API → outbox → queue → **real worker** team invitation; stopped worker then restart processes waiting jobs; graceful shutdown waits for the active send; crash after send → recovery re-sends (documented duplicate); recovery skips live jobs and applies retention; monitoring 401/403 and no sensitive data |
| API integration, all suites                  | **21 suites, 236 passed** (auth, MFA, rate limiting, Redis, Phase 4 cache, billing, subscriptions, tenant isolation, team, access requests, …)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| API unit                                     | 18 suites, 126 passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Web (vitest)                                 | 24 passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `eslint .` (api)                             | clean                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tsc --noEmit` (src, e2e)                    | clean. `integration/tsconfig.json`: the same 3 pre-existing errors in `addons.int-spec.ts` / `plan-management.int-spec.ts`, untouched files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Docker                                       | `docker compose --profile apps build worker` succeeded (api image)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Compose health and behaviour                 | See below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**Compose health and behaviour (dev database, Mailpit):**

- `worker` reached **healthy**.
- A real `POST /auth/password/forgot` on the dev API reached Mailpit, and the row ended `sent` with its payload `NULL`.
- **Worker stopped:**
  - `docker compose stop` exited in 3 s.
  - Exit code 143 is Nest re-raising SIGTERM after its shutdown hooks drained the worker.
  - The API still answered `202` in 0.2 s, and the row stayed `pending`, published.
- **Worker restarted:** healthy in 12 s, and the pending email was then sent (attempts 1).
- **Scaled to 2:** both instances healthy.

**Caveat:** the standard `--profile apps` stack refuses to start with the local `.env`. It runs `NODE_ENV=production`, which requires JWT keys and `COOKIE_SECURE=true` (pre-existing). Verification used a temporary override file outside the repo that sets `NODE_ENV=development` for `migrate` and `worker`. That run applied the new migration to the local dev database.

## 9. Benchmark (measured, `perf/results/phase5-bullmq.md`)

**Setup:**

- Laptop: i5-10310U, 8 threads, 8 GiB. PostgreSQL and Redis in Docker.
- One process runs the API producer module and one worker. In-process SMTP.
- 3 iterations per scenario.

| Scenario                                    | Jobs/s (3 runs)  | Processing p50 / p95 / p99 (ms, range) | Queue wait avg (ms) | Retry rate | Failure rate                      |
| ------------------------------------------- | ---------------- | -------------------------------------- | ------------------- | ---------- | --------------------------------- |
| Pipeline only, concurrency 5, 1,000 emails  | 62.5, 42.5, 26.7 | 69–169 / 139–331 / 188–408             | 983–2,662           | 0%         | 0%                                |
| 50 ms SMTP, concurrency 5, 300              | 25.5, 35.4, 35.9 | 125–165 / 209–466 / 387–559            | 2,034–2,717         | 0%         | 0%                                |
| 50 ms SMTP, concurrency 20, 300             | 67.8, 53.4, 51.3 | 269–366 / 412–562 / 460–608            | 145–274             | 0%         | 0%                                |
| Same + 10% simulated first-attempt failures | 42.6, 31.6, 34.2 | 303–407 / 431–673 / 469–783            | 379–713             | 8.3–9.7%   | **0%** (all retried successfully) |

**Memory:**

- Process RSS peak growth: ≤ 23 MB in the first run, then ≤ 4 MB.
- Redis `used_memory` peak growth: ≤ 1.4 MB, and ≤ 2.5 MB retained after 1,000 completed jobs (retention keeps the last 1,000).

**Interpretation:**

- **The database dominates processing.** Each job runs 3 short transactions while 20 producer transactions compete on the same laptop, so per-job processing (70–370 ms) is far above the 50 ms send.
- **Higher concurrency cuts waiting much more than it raises throughput.** Raising concurrency from 5 to 20 cut queue wait about 10× (≈2.3 s → ≈0.2 s) and raised throughput about 1.6×.
- **Retries behave as designed:** about 1.08–1.10 attempts per email and no permanent failures.
- **The pipeline-only scenario slowed across its three runs (62 → 27 jobs/s).** Each run deletes and re-inserts 1,000 outbox rows, and dead tuples and autovacuum timing are a plausible cause, but I did not confirm it. Treat these as single-laptop figures, not capacity numbers.
- **For context:** current email volume (password resets, invitations, approvals) is a few per minute at most. Every measured configuration is orders of magnitude above that.

## 10. Remaining risks

1. **Duplicate email** in the crash window after the mail server accepts a message (§4). Inherent to SMTP.
2. **The Super Admin notice is still best effort** in its own transaction after the access request commits, as before. If the API dies between the two transactions, that notice is lost; the request itself is saved.
3. **Heartbeats** use the shared Redis. During a Redis outage the monitoring endpoint shows no healthy workers, even though they are alive and will resume.
4. **Monitoring timings** are computed from the last 200 completed/failed jobs per call, which is cheap but approximate.
5. **Leftover Redis keys** (meta hashes) from the four removed queues may remain under `QUEUE_PREFIX`. They are harmless; remove them with `DEL` on `{prefix}:default:*`, `…:orders:*`, `…:inventory:*` and `…:reports:*` if desired.
6. **The local `--profile apps` stack** needs production secrets in `.env` (pre-existing; see §8).

## 11. Production deployment checklist

- [ ] Run migration `1798000023000-EmailOutbox` (the `migrate` job) **before** deploying the new API: the API now writes to `email_outbox`.
- [ ] Deploy the worker as its own service from the API image with command `node dist/worker.js`. Give it the same database (app role), Redis and SMTP/SES settings, plus `MFA_ENCRYPTION_KEY`.
- [ ] Use the container health check `node dist/worker-health.js` (no HTTP port). Give the worker a stop timeout ≥ `EMAIL_SEND_TIMEOUT_MS` + 15 s (Compose uses 45 s).
- [ ] Run at least 1 worker; ≥ 2 for availability. Recovery is advisory-locked, and claims make multiple workers safe.
- [ ] Keep `maxmemory-policy noeviction` on Redis/ElastiCache (BullMQ requirement).
- [ ] Set `EMAIL_SEND_TIMEOUT_MS` to suit SES SMTP latency, and `EMAIL_WORKER_CONCURRENCY` within the SES send-rate quota.
- [ ] Alert on `GET /platform/queues`: `workers.healthy = 0`, `outbox.failed` increasing, `outbox.oldestOpenAgeSeconds` above a few minutes, `counts.failed` increasing.
- [ ] Deployment order is safe either way. A new API with an old or absent worker leaves mail pending until the worker runs. A new worker with an old API simply has nothing to do.
