# FoodStack — Final Phase Completion Report

_Last updated 2026-11-06 (session 3). Nothing has been pushed, merged or provisioned. The earlier report is kept below §12._

## 0. Status by verification level

| Area                                                                                  | Implemented                         | Automated tests passed                       | Browser verified     | Infrastructure provisioned                       | Load tested                                                                       | Production verified     |
| ------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------- | -------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------- | ----------------------- |
| Phases 3, 4, 5, 7 (app)                                                               | ✅                                  | ✅ unit 177, integration 282, e2e 56, web 31 | ❌ (checklist ready) | ❌                                               | ✅ local                                                                          | ❌                      |
| Phase 6 analytics                                                                     | ✅                                  | ✅                                           | ❌                   | ❌                                               | ✅ ≤100k orders                                                                   | ❌                      |
| Phase 2 / 8 large datasets (1M/10M)                                                   | ✅ scripts                          | —                                            | —                    | ❌                                               | ❌ needs ≥16 GB (`run.sh` refuses below 15 GB)                                    | ❌                      |
| Auth fail-closed on Redis outage (decision 2)                                         | ✅                                  | ✅ unit + integration                        | —                    | ❌                                               | ✅ local HA rehearsal: 503 + Retry-After, recovery                                | ❌                      |
| Search without weakening RLS (decision 1)                                             | investigated; trigram stays off     | —                                            | —                    | —                                                | measured: gram table 313→75 ms for digit searches, no gain for names; not adopted | —                       |
| Prometheus metrics (API and worker)                                                   | ✅                                  | ✅                                           | —                    | ❌                                               | ✅ scraped live                                                                   | ❌                      |
| Grafana, Alertmanager, 21 alert rules                                                 | ✅                                  | ✅ promtool                                  | —                    | ❌ (local only)                                  | ✅ `AuthFailingClosed` fired on the real outage                                   | ❌                      |
| HA: replicas, LB, PgBouncer, worker scaling                                           | ✅ (compose rehearsal)              | ✅                                           | —                    | ❌                                               | ✅ 0 errors with a replica stopped; writes p95 592 ms (missed the target)         | ❌                      |
| AWS Terraform (VPC, ALB/TLS/WAF, ECS, RDS, ElastiCache, Secrets, AMP, Backup, 3 envs) | ✅                                  | ✅ fmt + validate ×4, Trivy 0 HIGH/CRITICAL  | —                    | ❌ **not applied** (costs money, needs approval) | ❌                                                                                | ❌                      |
| Deploy and infra CI workflows                                                         | ✅                                  | ✅ actionlint                                | —                    | ❌ (never run)                                   | —                                                                                 | ❌                      |
| Backups and DR                                                                        | documented (`DISASTER_RECOVERY.md`) | local dump/restore ✅                        | —                    | ❌                                               | —                                                                                 | ❌ RDS PITR not drilled |

**Production-ready: NO.** No infrastructure is provisioned; monitoring and backups don't run on AWS; and deployment and recovery have not been tested there.

## 0.1 This session's defects found and fixed

1. PgBouncer rejected `statement_timeout`, so no replica could start. It is now set per transaction (`73e7e5f`).
2. The readiness health check fails on a Redis outage. The ALB now checks `/health/live`, so a Redis outage can't take down every replica.
3. The PgBouncer exporter was silently denied access. Fixed with `STATS_USERS`, plus a `PgBouncerDown` alert.
4. Terraform security: unrestricted egress (now VPC + 443/587 only), an unencrypted log bucket, and an SNS topic without a CMK.

## 0.2 Needs your approval or external resources

1. **AWS:** approve the cost and target account, then `bootstrap` → `envs/staging` plan/apply (`infrastructure/aws/README.md`).
2. **A ≥16 GB machine:** run `tests/load/large-dataset/run.sh all` (1M), then `ORDERS=10000000`.
3. **A browser session:** `docs/BROWSER_VERIFICATION_CHECKLIST.md`.
4. **GitHub:**
   - The branch is 17 commits ahead of `origin/feature/central-authentication` and 26 ahead of `main`.
   - gitleaks: clean (2 reviewed false positives, in `.gitleaksignore`).
   - No accidental files; all 26 migrations are listed and ordered.
   - Ready to push and open a PR **when you approve**. A PR description is in `docs/PR_DESCRIPTION.md`.
5. **Write latency for a busy single tenant:** the per-tenant usage-counter row serializes concurrent orders. This needs a design decision after the ≥16 GB tests.

---

## 12. Previous report (session 2)

_2026-11-06 · branch `feature/central-authentication` · all results were produced in this session on
an i5-10310U, 7.7 GB RAM laptop with ~0.8 GB free. Nothing was pushed or merged._

## 1. Phase status

| Phase                     | Status                           | Implementation                                                                                                                                                                    | Tests                                                                                               | Remaining blockers                                                                                                     |
| ------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **2 · DB optimization**   | **Partial** (1M/10M **blocked**) | F1/F3/F4/F7/F10 re-verified. Trigram measured: **unusable under forced RLS** (ILIKE is not leakproof), so no index added. Pool/config reviewed.                                   | Integration 277/277 on HEAD. Trigram EXPLAIN as the app role (rolled back).                         | 1M/10M runs need ≥16 GB RAM. Making trigram usable needs a security decision (LEAKPROOF or a SECURITY DEFINER search). |
| **3 · Integration / E2E** | **Completed**                    | Test DB identity checked. Backups verified **by restore**. bench6 removed (1.45M orders, 100k customers…), scoped and guarded. 3 genuine failures fixed.                          | **Integration 24/24 suites, 277/277** · **E2E 2/2, 56/56** · unit and web green                     | —                                                                                                                      |
| **4 · Throughput / MFA**  | **Completed**                    | Interleaved A/B/B/A benchmark: **no regression** (median 61.4 vs 64.5 req/s, within noise). MFA counter made atomic (Lua).                                                        | MFA 6/6 (Redis, concurrency 50) + HTTP lockout test; auth 27/27                                     | —                                                                                                                      |
| **5 · Worker**            | **Completed**                    | Production image built and started via Compose. Delivery, backoff, dead letter, recovery, outage, graceful drain, health and logs all verified. Found and fixed an IP→`inet` 500. | Container checks 1–9 pass; `email-outbox` 22/22 in the full run                                     | —                                                                                                                      |
| **6 · Analytics**         | **Partial**                      | Analytics complete. `/analytics/customers` needs `order:read`. Concurrency limiter + 503/Retry-After. Sales CSV export. Dev migration applied after a verified backup.            | analytics 21 (incl. new role test) · limiter/filter unit · web CSV unit                             | Visual browser check (no browser tool). 1M benchmark (≥16 GB). Limiter benchmark at 100k not rerun.                    |
| **7 · Cursor pagination** | **Completed**                    | Keyset API (orders, payments, movements, platform invoices): microsecond-safe, fingerprinted, scope-bound cursors. Web Previous/Next on 4 tables.                                 | cursor 14/14 · unit +8 · web +6                                                                     | Visual browser check. Timing at 1M.                                                                                    |
| **8 · Load testing**      | **Partial**                      | k6 suite (`tests/load/k6`): normal, spike, soak, seed and monitor. Targets defined. **A, B and C executed** at laptop scale, plus a 150-VU stress run.                            | A ✓ · B ✓ · C (20 min soak) ✓ 16,523 req, 0 % errors, no leaks · stress: 0 errors but p99 3.8–4.5 s | 1M/10M dataset runs and multi-replica runs need bigger infrastructure.                                                 |

**Totals:** 3 phases completed (3, 4, 5) plus Phase 7 for everything except the visual check. 4 partial (2, 6, 7-visual, 8)
with every remaining item blocked by hardware, a browser, or a security decision for you.

## 2. Test results (all executed)

| Suite                                        | Result                                                                                                                                                                                 | When                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| API unit                                     | **22 suites, 172 tests passed** (incl. Db serialization 3)                                                                                                                             | after the final commit |
| API integration                              | **24 suites, 278 / 278** on the final code (incl. the lockout test); pg overlap warnings 0                                                                                             | 12:4x                  |
| API e2e (RLS coverage, tenant isolation)     | **2 suites, 56 / 56**                                                                                                                                                                  | final code             |
| Web (vitest)                                 | **5 files, 31 / 31**                                                                                                                                                                   | after `9e37ded`        |
| Typecheck (API src + integration + e2e, web) | clean                                                                                                                                                                                  | each commit            |
| Lint (API, web)                              | clean                                                                                                                                                                                  | each commit            |
| Full `pnpm build`                            | **Production Docker image build** (`turbo build` of the API inside the image) succeeded twice. The local full `pnpm build` was not run: it crashes the dev API on :4000 (known issue). | —                      |

## 3. Genuine defects found and fixed this session

| #   | Defect                                                                                    | Severity                                                     | Fix                                                             |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------- |
| 1   | MFA failure counter could exist without TTL (`INCR` + separate `EXPIRE`)                  | Medium (security reliability)                                | `231eb68`: atomic Lua; self-repairs old keys                    |
| 2   | Malformed client IP (with `TRUST_PROXY`) → **500 on every audited request** (`inet` cast) | High (availability, reachable through a misconfigured proxy) | `a1ef788`: `clientIp()` validation; 4 duplicated helpers merged |
| 3   | Uncached analytics could exhaust the DB pool → 500s for everyone                          | High (at scale)                                              | `8279d4d`: limiter + 503 Retry-After                            |
| 4   | `/analytics/customers` lacked the customer-data permission from the approved design       | Low–medium                                                   | `8279d4d`: requires `order:read` on all branches in scope       |
| 5   | `database.int-spec` failed (analytics suite leaked a Super Admin assignment)              | Test infrastructure                                          | `8279d4d`                                                       |
| 6   | RLS guard failing since `2e019af` (`plans`, `addon_packages` not allow-listed)            | Guard drift                                                  | `2439006`: justified allow-list                                 |
| 7   | Concurrent queries on one pg client (deprecated, **breaks in pg 9**)                      | Medium (upgrade blocker)                                     | Final commit: `Db` serializes per transaction                   |
| 8   | My own regression: unit `paged.spec` after Phase 7                                        | —                                                            | `9671c89`                                                       |

## 4. Security audit summary

| Area                      | Finding                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AuthN / sessions          | Argon2id; lockout after 5 failures (tested); refresh rotation with reuse detection (tested); access 15 min, refresh 30 d / 90 d absolute; Super Admin requires TOTP; recovery codes are one-time. MFA counter fixed (#1). |
| AuthZ / isolation         | RLS forced on every tenant table with a policy (e2e guard); branch scoping on lists, analytics and cursor pages (tests); cursors bound to the caller's scope (replay → 400).                                              |
| Rate limiting             | Redis-backed per-IP: 300/min, login 10/min; fails **open** if Redis is down (account lockout still enforced in PostgreSQL). Accept explicitly, or switch to fail-closed for auth routes.                                  |
| Input validation / errors | Zod `strictObject` everywhere checked; Problem Details; invalid IP fixed (#2); cursor input validated.                                                                                                                    |
| Secrets                   | No secrets tracked (`git grep` for keys and tokens: none). `.env*` ignored. Production validation rejects missing JWT keys, the example MFA key, and `COOKIE_SECURE=false` (observed).                                    |
| Logging                   | Pino structured logs with request ids; authorization, cookies, passwords, tokens and OTPs redacted. **0 bearer tokens** in load-test logs; worker logs carry no addresses.                                                |
| Dependencies              | `pnpm audit --prod`: 0 unignored. 4 ignored advisories (1 high: zod <4.6.6) are **only in `@expo/cli`/`@expo/config` dev tooling**; every app and the API resolve zod 4.6.7. Justified.                                   |
| Containers                | Non-root `node`, tini, healthchecks, ports bound to 127.0.0.1 in Compose.                                                                                                                                                 |

## 5. Benchmarks (executed)

| Benchmark                                  | Result                                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 4 interleaved cache throughput       | database 61.4 / cache 64.5 req/s median (3 samples each); statements 10.0 → 7.3                                                              |
| Trigram (200k customers, 300k orders, RLS) | 485–615 ms with or without trigram (seq scan); owner/no-RLS 3.2 ms with trigram                                                              |
| k6 A normal (≤20 VUs)                      | 2,827 req, **0 % errors**, reads p95 43.7 / p99 79.6 ms, writes p95 92.3 / p99 146.3 ms                                                      |
| k6 B spike (5→40 VUs)                      | 4,355 req, **0 %**, reads p99 73.4 ms, writes p99 231.3 ms                                                                                   |
| k6 stress spike (10→150 VUs)               | 7,185 req, **0 %**, but reads p95 2.18 s / p99 3.78 s; ceiling ~33 req/s; bottleneck one Node process (≈100 % of a core) + PG CPU, pool 9/10 |
| k6 C soak (10 VUs, 20 min)                 | 16,523 req, **0 %**, reads p99 81 ms, writes p99 184 ms; memory, connections, Redis and queue flat                                           |
| Container worker                           | delivery 0.55 s; backoff 2.09 / 4.05 / 8.05 / 16.09 s; drain 14.8 s                                                                          |

## 6. Database migration results

- **Dev `foodstack`:** `AnalyticsIndexes1798000024000` applied after a restore-verified backup. 26 migrations; 3 indexes present; data unchanged; API healthy.
- **Test `foodstack_test`:** at the latest migration. The suites revert and re-apply all 26 migrations (`database.int-spec`) successfully.
- **`foodstack_load`:** created and migrated by the production `migrate` container; used for Phases 5 and 8.

## 7. Docker verification

Built `foodstack-api` / `-worker` / `-migrate` (421 MB) twice. Started via `docker compose --profile apps run`:

- the API reached `healthy` in ~10 s;
- the worker reached `healthy`;
- the migrate container applied migrations and exited 0;
- production validation refused unsafe config.

## 8. Load test details

See `docs/PHASE_8_FINAL_REPORT.md`.

## 9. Git commits (local branch, not pushed)

See `git log --oneline 2bf71dc..HEAD`. Every commit is logically scoped; listed in §11 of the Phase 8 report.

## 10. External requirements and decisions needed from you

1. **A ≥16 GB RAM machine** (or a cloud runner) for the 1M and 10M datasets (Phase 2, 6 and 8 §D). Commands are in `PHASE_2_FINAL_REPORT.md` §5 and `tests/load/k6/README.md`.
2. **A browser session** to visually verify the dashboard and the 4 cursor tables (loading, empty, error, success; mobile width).
3. **Security decision: search under RLS** (`ALTER FUNCTION texticlike LEAKPROOF` versus a `SECURITY DEFINER` search function versus keeping seq scans).
4. **Production infrastructure.** `infrastructure/aws/` and `infrastructure/monitoring/` are empty placeholders:
   - no IaC;
   - no metrics/APM (Prometheus/OpenTelemetry) or error tracking;
   - no alerting;
   - backups are planned on paper (RDS PITR 35 d, cross-region snapshots) but not provisioned or drilled.
5. **Rate-limit failure mode** (open versus closed when Redis is down) for auth routes.
6. **Push and PR approval:** nothing was pushed. `gh` is not installed, so CI status on GitHub was not checked.

## 11. Production readiness

**Not production-ready.** The application is in good shape for a controlled pilot:

- all suites are green;
- isolation is enforced in the database and tested;
- the defects found were fixed;
- it is stable at small-restaurant load.

These block a "production-ready" claim:

1. **No deployable infrastructure, monitoring, alerting or backups exist yet** (Critical for production).
2. **No large-dataset (1M/10M) evidence** of query plans or latency (High).
3. **Single-process ceiling of ~33 req/s on this hardware.** Horizontal scaling (replicas + PgBouncer) is designed for but not load-tested (High).
4. Search latency of 0.5–0.8 s at 200k customers per tenant, with no index usable under RLS (Medium; needs your decision).
5. The UI has not been visually verified in a browser (Medium).
