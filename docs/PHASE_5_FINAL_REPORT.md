# Phase 5 — Worker Infrastructure: Final Report

_2026-11-06 · Everything below was executed against the production Docker image, not in-process tests._

**Status: COMPLETED.** The worker container was built, started through Compose, and verified for
delivery, retries with exponential backoff, the dead-letter state, recovery, outage tolerance,
graceful shutdown, health, and log hygiene. Tenant-boundary checks for jobs are covered by the
integration suite, which passes (§6).

## 1. Setup (isolated from dev)

- **Image:** `docker compose --profile apps build migrate api worker` built `foodstack-api` and `foodstack-worker` (421 MB each,
  from `infrastructure/docker/api.Dockerfile`). Rebuilt after `a1ef788`.
- **Database:** `foodstack_load`, migrated by the `migrate` container (26 migrations) and seeded by
  `scripts/seed-load.mjs`. The seed refuses any database name that doesn't end in `_load`; this was tested.
- **Queue prefix:** `QUEUE_PREFIX=foodstack-load`, so neither the dev API nor the dev worker can see these jobs.
- **Production mode:** the containers run with `NODE_ENV=production` validation. They need JWT keys, which are a throwaway Ed25519 pair kept in the scratchpad and never in the repo.
  They also need `COOKIE_SECURE=true`: the first migrate attempt was correctly **refused** with
  "COOKIE_SECURE: Must be true in production".
- **Not run against the dev DB:** the worker deletes closed outbox rows after their retention period, so it was kept away from dev data.

## 2. Results

| #   | Test                                       | How                                                                                         | Result                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Connectivity and registration              | Start `worker` via Compose                                                                  | Healthcheck `healthy` within ~10 s. The log shows `Email worker started (concurrency 5)`.                                                                                                                                                                                                         |
| 2   | Successful job                             | `POST /auth/password/forgot` → outbox → BullMQ → SMTP (Mailpit)                             | API `202` in 74 ms. Delivered in **~0.55 s** on attempt 1. The payload was **erased** after sending. Mailpit holds 1 message, "Reset your FoodStack password".                                                                                                                                    |
| 3   | Retries + exponential backoff              | Worker with `SMTP_PORT=1` (unreachable)                                                     | Attempt gaps of **2.09 s, 4.05 s, 8.05 s, 16.09 s** (from 2 s, doubling). 5 attempts in 30.3 s.                                                                                                                                                                                                   |
| 4   | Permanent failure (dead letter)            | Same run, after attempt 5                                                                   | Row became `failed` with `failed_at` set and the payload erased. `last_error = Error:ESOCKET` (sanitized). One job is in BullMQ's `failed` set (kept 7 days per config).                                                                                                                          |
| 5   | Recovery mid-retry                         | 2 failed attempts, then the bad worker was swapped for a good one                           | Still `pending` (payload kept) after 2 attempts, then `sent` on **attempt 3** with the payload erased. Delivered.                                                                                                                                                                                 |
| 6   | Worker outage                              | Worker stopped, then a reset requested                                                      | API still `202` in **32 ms**, and the row stayed `pending`/published. After restart it was delivered in ~4 s.                                                                                                                                                                                     |
| 7   | **Graceful shutdown with sends in flight** | SMTP "blackhole" (a TCP server that never answers), 3 jobs active, then `docker stop -t 45` | No new jobs were taken. The worker **waited 14.8 s** for the active sends (bounded by `EMAIL_SEND_TIMEOUT_MS=15000`, well under the 45 s grace), then recorded all 3 as `pending` with `MailTimeoutError`. **0 active jobs and no stale locks** were left. A healthy worker then delivered all 3. |
| 8   | Health                                     | `docker inspect`                                                                            | `healthy` throughout normal operation (`dist/worker-health.js` heartbeat).                                                                                                                                                                                                                        |
| 9   | Log hygiene                                | Read all worker logs                                                                        | Logs contain job ids, attempt numbers and sanitized codes (`Error:ESOCKET`, `Error:ECONNECTION`, `MailTimeoutError`). **No email addresses or tokens.**                                                                                                                                           |

Final tally in `foodstack_load`: 6 `sent` (attempts 1, 1, 3, 4, 4, 4), 1 `failed` (the deliberate one),
and every payload `NULL`. Mailpit received exactly 6 messages for the load tenant.

**Exit code 143 on stop is expected.** Nest's `enableShutdownHooks()` runs the shutdown hooks
(BullMQ `worker.close()` waits for active jobs) and then re-raises SIGTERM, so the process ends
by that signal. Two facts show the worker exited on its own rather than being killed: the stop
time (0.5–15 s, never the 45 s grace), and the drained state in test 7.

## 3. Defect found during this phase (fixed)

The first burst test sent `X-Forwarded-For` values with invalid octets, such as `10.9.8.25046`.
**Every request returned 500**: `invalid input syntax for type inet`. With `TRUST_PROXY=true`
the client address was written unvalidated to `inet` columns. A correctly configured proxy
writes the rightmost entry itself, but a misconfigured proxy or a directly exposed port makes
this reachable by any client.

**Fix (`a1ef788`):**

- `clientIp()` validates the address with `net.isIP`, and an invalid value is stored as `NULL`.
- The four duplicated `requestMeta` helpers are now one.
- Unit tests cover valid IPv4/IPv6 and malformed values, including SQL-like strings.

## 4. Dead-letter handling

There is no separate dead-letter _queue_. The design keeps permanently failed jobs in two places:

- **PostgreSQL:** the outbox row is `failed`, with `failed_at`, a sanitized `last_error` and the payload erased. It is retained for 30 days (`OUTBOX_FAILED_RETENTION_DAYS`).
- **BullMQ:** the job stays in the `failed` set for 7 days (last 5,000).

Super Admins see failures in `GET /platform/queues`. Re-sending is a new request (for example,
another password reset), because one-time tokens expire.

## 5. Job isolation across tenants, restaurants and branches

Each job names its outbox row and tenant. The worker loads the row **under that tenant's RLS
context and filters on the tenant id**. A forged or mismatched job finds nothing and fails without
retry (`UnrecoverableError`). This is covered by `integration/email-outbox.int-spec.ts` (forged-tenant
and malformed-job cases), which passed as part of the 277/277 run. Email jobs carry no restaurant or
branch scope: the recipient comes from the outbox row, not from the job.

## 6. Automated tests

- `integration/email-outbox.int-spec.ts` (22 tests: in-transaction write, encryption, rollback,
  tampering, duplicate publish, Redis down at publish, recovery, forged tenant, at-least-once).
  Passed in the full run.
- The container checks above are manual but scripted. Commands are listed in `tests/load/k6/README.md` §Run.
  A CI job that boots the Compose stack and repeats tests 2–7 is recommended (see the final report).

## 7. Limitations

- **Delivery is at-least-once.** A crash after SMTP accepted a message but before `sent` was recorded causes one duplicate. This is documented and inherent to SMTP.
- **Only email uses the queue.** Other slow work is still synchronous.
