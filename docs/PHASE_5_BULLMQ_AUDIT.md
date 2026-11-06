# Phase 5 — BullMQ Audit (before implementation)

_Date: 2026-11-04 · Scope: `apps/api`, Docker, CI · **No code was changed for this audit.** Phase 4 (Redis cache) is implemented and uncommitted; this audit is taken on top of it._

## 1. Existing implementation

### 1.1 Queue infrastructure

| Item                                  | Where                                                       | State                                                                                                                     |
| ------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| BullMQ 6.5.1, `@nestjs/bullmq` 12.0.0 | `apps/api/package.json`                                     | Installed                                                                                                                 |
| Root config                           | `src/queues/queue.module.ts` (global)                       | `BullModule.forRootAsync` with `buildQueueRedisOptions` (`maxRetriesPerRequest: null`), `prefix: QUEUE_PREFIX`            |
| Default job options                   | same                                                        | `attempts: 5`, exponential backoff from 2 s, `removeOnComplete: { age: 24 h, count: 1000 }`, `removeOnFail: { age: 7 d }` |
| Queues registered                     | `src/queues/queue.constants.ts`                             | `default`, `notifications`, `orders`, `inventory`, `reports`                                                              |
| Error logging                         | `QueueModule.onModuleInit`                                  | Once per outage per queue, with "restored" on `ready`                                                                     |
| **Processors / workers**              | —                                                           | **None.** `grep @Processor\|WorkerHost\|InjectQueue` finds nothing outside the queue module. No job is ever added.        |
| Worker entrypoint                     | `docs/system-architecture.md` plans one                     | **Does not exist.** `infrastructure/docker/api.Dockerfile` runs only `dist/main.js`; Compose has only `api`               |
| Outbox                                | Planned in `system-architecture.md` §"Transactional outbox" | **No table, no relay**                                                                                                    |

### 1.2 Work that runs today, and how

| Workflow                                                            | How it runs now                                                                                                                                                                                                                                        | Notes                                                                                                                                                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Email** (`MailService.send`)                                      | Inline SMTP from 4 call sites: password reset (`auth.service.ts:710`), account-locked notice (`auth.service.ts:260`, fire-and-forget `void`), team invitation (`team.service.ts:456`), access-request notifications (`access-requests.service.ts:260`) | Never throws; failures are logged and **lost** (no retry). The request waits on SMTP for reset/invite/access-request mail. Design D5 already says mail should go through the `notifications` queue |
| **Subscription expiry sweep**                                       | `SubscriptionExpiryScheduler`: `setInterval` in every API instance, guarded by `pg_try_advisory_xact_lock`                                                                                                                                             | Correct and idempotent. Access never depends on it (AuthGuard evaluates dates per request)                                                                                                         |
| **Payment webhooks**                                                | Inline in the request, de-duplicated by `payment_webhook_events`                                                                                                                                                                                       | Idempotent today. Phase 1 audit §7: **stays in the request/webhook transaction, not moved to a queue**                                                                                             |
| Orders, payments, refunds, invoices                                 | Inline in one DB transaction each                                                                                                                                                                                                                      | Order-limit counters and advisory locks already prevent double counting                                                                                                                            |
| Inventory                                                           | Manual movements only; **orders do not deduct stock**                                                                                                                                                                                                  | No low-stock alerting exists                                                                                                                                                                       |
| Reports                                                             | `GET /reports/inventory`, synchronous, bounded to 366 days                                                                                                                                                                                             | Measured as fast enough in earlier phases; no export/scheduled report feature exists                                                                                                               |
| Invoice PDFs, sales reports, onboarding emails, order notifications | **Not built** (no PDF library, no sales endpoint, no WebSocket gateway — `src/websocket` is a scaffold)                                                                                                                                                | —                                                                                                                                                                                                  |

### 1.3 Redis connections (live, `CLIENT LIST` on the dev Redis)

Per API process: **1** named `foodstack-api` client (cache, rate limit, MFA, health) + **5** unnamed BullMQ `Queue` connections (one per registered queue, idle; their last command was the `HSET` of queue metadata at start-up). Two API processes were running, so 12 clients in total. Server `maxmemory-policy` is **`noeviction`**, which is what BullMQ requires.

### 1.4 Shutdown, logging, monitoring, tests

- `app.enableShutdownHooks()` in `main.ts`; `@nestjs/bullmq` closes queues on module destroy. Tini is PID 1 in the image, so SIGTERM reaches Node.
- Logging: pino; mail failures log without the address in `MailService`, but `AccessRequestsService.safeSend` logs `message.to` (an email address).
- Health: `GET /health` checks PostgreSQL and the shared Redis client only. No queue metrics anywhere.
- Tests: no queue or worker tests. CI runs integration tests against real PostgreSQL + Redis (`docker compose up -d --wait postgres redis`) and builds all Docker images.

## 2. What is working correctly

1. **Connection split is right:** request-path client fails fast; BullMQ connections retry forever (required for blocking worker commands). Covered by `redis.options.spec.ts`.
2. **Defaults are sensible:** exponential backoff, bounded retention of completed jobs, a week of failed jobs for inspection.
3. **`noeviction`** on Redis, so queue data is never silently evicted. (Phase 4 report recommended `volatile-lru`; **that recommendation is withdrawn**: with BullMQ on the same Redis it must stay `noeviction`. Cache keys all carry TTLs, so they expire on their own.)
4. **The money paths are already idempotent and transactional** (advisory locks, webhook de-duplication, order counters). Nothing there needs a queue to be correct.
5. **The sweep is multi-instance safe** via advisory lock.
6. Outage logging for queues is already rate-limited (once per outage).

## 3. Missing functionality

| Gap                                                              | Impact                                                                                                                           | Needed now?                                                                                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| No worker/processor at all                                       | Queues are registered but unused                                                                                                 | Yes, for email (below)                                                                                                                      |
| Email has **no retry** and blocks the request on SMTP            | A brief SMTP outage loses reset/invite/access-request mail; slow SMTP adds its latency to those requests                         | **Yes** — the one real background job today (design D5)                                                                                     |
| No outbox                                                        | A job added after commit can be lost if Redis is down at that moment; a job added before commit can run for a rolled-back change | **Yes, for email**: password-reset and invitation mail must not be lost when Redis blips, and must not be sent for rolled-back transactions |
| No queue monitoring                                              | Failed jobs invisible                                                                                                            | Yes (Super Admin endpoint, same pattern as `/platform/cache`)                                                                               |
| No graceful worker drain / per-job timeout                       | A deploy could cut an SMTP send mid-way (BullMQ then retries the job after its lock expires → possible duplicate mail)           | Yes, with the worker                                                                                                                        |
| No worker concurrency / role config                              | Workers would run in every API container with defaults                                                                           | Yes (`WORKER_ENABLED`, concurrency env)                                                                                                     |
| Low-stock alerts                                                 | Nobody is told when stock goes low                                                                                               | **Product decision** (who gets it, how often). Can be built on the same outbox; not built speculatively                                     |
| Invoice PDF, sales reports, onboarding mail, order notifications | Features do not exist                                                                                                            | **No** — nothing to move to a queue (rule: no speculative features). Hooks are documented for later phases                                  |
| Sweep as a BullMQ repeatable job                                 | Visibility only; current advisory-lock timer is correct                                                                          | Optional (Phase 1 audit §7 listed it)                                                                                                       |

## 4. Potential performance bottlenecks

- **SMTP latency in the request path** for reset, invitation and access-request flows (seconds when SMTP is slow; unbounded if the server hangs, since nodemailer's default socket timeouts are long). Moving to a queue removes it.
- **Idle connections:** 5 queue connections per API process today, for queues nobody uses. If workers are added naïvely, each `Worker` adds a blocking connection plus one more per queue. Registering only the queues that have producers/consumers keeps this small.
- **Nothing else measured as slow enough to need a queue** (Phase 2/3 results: order creation, lists, usage all in low tens of ms).

## 5. Reliability and security risks

1. **Secrets in job payloads.** Reset and invitation links contain one-time tokens. A job that stores the rendered mail keeps the token in Redis (and in failed-job retention for 7 days, readable by anyone with Redis access or a queue dashboard). **Mitigation:** encrypt the message body in the outbox/job with the existing AES-256-GCM helper (`core/security/crypto.ts`, key from config), or store only a reference and re-render. Recommendation in §7.
2. **PII in logs:** `AccessRequestsService.safeSend` logs a recipient address. Job logs must log job id, type and tenant only.
3. **Dual-write inconsistency** (DB commit vs queue add). Requires a transactional outbox for anything that must not be lost or must not fire on rollback.
4. **Duplicate sends:** BullMQ is at-least-once. A worker crash after SMTP accepted but before the job is marked complete re-runs the job. Email cannot be made exactly-once over SMTP; the realistic target is **at-most-once per outbox row under normal operation, at-least-once on crash** — documented, with a "sent" marker written after delivery to cover retries.
5. **Tenant context in jobs:** jobs must carry `tenantId` (and branch where relevant) taken from the server-side context, and the worker must re-read the row under that tenant's RLS scope instead of trusting payload fields. Platform (Super Admin) mail has no tenant and runs in the platform scope.
6. **Redis outage:** producers must not fail user requests (the outbox absorbs it); workers just wait (BullMQ retries forever).
7. **Orders/payments/invoices must not be processed twice:** they stay inline and transactional; no job in this phase touches them.

## 6. Redis connection considerations

- Reuse `buildQueueRedisOptions` and `QUEUE_PREFIX`; no new client types.
- BullMQ needs separate connections for `Queue` (producer) and `Worker` (blocking). Budget per API process after Phase 5 if one queue (`notifications`) is used: 1 shared request client + 1 queue + worker connections (BullMQ: 1 blocking + 1 for commands). Unused queues (`default`, `orders`, `inventory`, `reports`) can be left unregistered until they have a job, saving 4 connections per process.
- Keep `noeviction`. Retention limits are the only control on queue memory.
- In production (ElastiCache) the same Redis may be used; queue keys share the `QUEUE_PREFIX` namespace with the cache and rate limiter, so a `FLUSHDB` would drop jobs — the outbox makes that recoverable.

## 7. Recommended implementation plan

Smallest change that removes the real risks; everything else stays as is.

1. **Outbox table** `outbox_messages` (migration, RLS like other tenant tables, platform rows allowed): `id`, `tenant_id` (nullable for platform mail), `kind` (`email`), `payload` (encrypted bytea), `status` (`pending|sent|failed`), `attempts`, `available_at`, `sent_at`, `last_error` (sanitized), timestamps. Written **in the same transaction** as the business change.
2. **`NotificationsService.enqueueEmail(db, message, ctx)`** replaces the four direct `MailService.send` calls. `MailService` stays as the transport.
3. **Relay**: after commit (`Db.afterCommit` from Phase 4) add a BullMQ job with `jobId = outbox id` (BullMQ de-duplicates by id). A periodic relay (every 10–30 s, advisory-locked) re-publishes `pending` rows older than a threshold, covering Redis outages and crashes between commit and publish.
4. **Worker** on the `notifications` queue: loads the outbox row by id (in its tenant/platform scope), skips if already `sent`, decrypts, sends with an SMTP timeout, marks `sent`. Configurable concurrency, job timeout, exponential backoff, attempts; final failure marks the row `failed` (kept for inspection, no payload in logs).
5. **Worker role and shutdown**: `WORKER_ENABLED` (default true for the single-container setup; can be split into a worker container later with the same image), `worker.close()` on shutdown so active jobs finish, and stalled-job recovery left to BullMQ defaults (`stalledInterval`, `maxStalledCount`) with the "sent" check preventing re-sends after a stall.
6. **Monitoring**: `GET /platform/queues` (Super Admin): counts by state, retries, processing/wait time percentiles, worker heartbeat, outbox pending/failed counts. No payloads.
7. **Unregister unused queues** (keep names in constants).
8. **Not in this phase** (no feature exists): invoice PDFs, sales reports, onboarding mail, order notifications. **Needs a product decision:** low-stock alerts. **Optional:** move the subscription sweep to a repeatable job.

### Decisions needed before implementation

1. Scope as above (email via outbox + worker + monitoring), or also build **low-stock alerts** (recipient and frequency to be defined)?
2. Sensitive mail payloads: **encrypt in the outbox** (recommended), or store a reference and re-render at send time?
3. Workers **inside the API process** (`WORKER_ENABLED=true`, simplest, current Compose) or a **separate worker container** from the same image?
4. Move the subscription sweep to a BullMQ repeatable job, or leave the working advisory-lock timer?

---

## 8. Decisions taken and outcome (added after implementation)

| Question (§7)      | Decision                                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope              | Email outbox, worker, recovery, encryption, monitoring, removal of unused queues. **No** low-stock alerts, PDFs, reports, order or onboarding notifications |
| Sensitive payloads | Encrypted in the outbox with the existing AES-256-GCM key; erased on `sent`/`failed`                                                                        |
| Worker placement   | **Separate container** from the same image (`node dist/worker.js`, no HTTP)                                                                                 |
| Subscription sweep | **Unchanged** (advisory-locked timer)                                                                                                                       |
| Redis eviction     | `noeviction` kept                                                                                                                                           |

Finding during implementation: `MailService.send()` swallowed errors, which a retrying worker cannot use; it became `deliver()`, which throws and is bounded by a timeout. Details, tests and measurements: `docs/PHASE_5_BULLMQ_REPORT.md`, `apps/api/perf/results/phase5-bullmq.md`.
