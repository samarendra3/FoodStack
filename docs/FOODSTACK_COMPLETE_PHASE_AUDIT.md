# FoodStack — Complete 8-Phase Audit

_Audit date: 2026-11-06 · Branch: `feature/central-authentication` (HEAD `2bf71dc`, working tree clean before this file) · Auditor: Claude Code_
_No application code, database data, benchmark records or migrations were changed. Only read-only commands, the API unit tests and the typecheck were run._

---

## 1. Executive summary

FoodStack has real, substantial implementations for Phases 1–6. All of that work is committed in `2bf71dc`. **Phase 7 (cursor pagination) and Phase 8 (large-scale load testing) have not been started.** No cursor or keyset code exists, and the repository has no load-testing tool.

Today the API unit suite passes (**19 suites, 142 tests**) and the typecheck is clean, including the integration and e2e projects. However, the **full integration suite has not been run since the Phase 6 changes**. This was true in the previous session and is still true in this audit. Phase 6 changed `orders.service.ts`, which Phases 2, 3 and 4 depend on. Under the strict definition, Phases 2–6 are therefore **implemented but not fully verified**.

Three environment problems also stand out:

- The test database still holds **1,450,000 `bench6-*` orders across 10 tenants**, so the Phase 6 benchmark cleanup never finished.
- The dev database `foodstack` is **one migration behind**: `AnalyticsIndexes1798000024000` is not applied there.
- No benchmark has reached 1M orders.

| Count                   | Phases                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| **Fully completed**     | **1** (Phase 1)                                                                             |
| **Partially completed** | **5** (Phases 2, 3, 4, 5, 6)                                                                |
| **Pending**             | **2** (Phases 7, 8)                                                                         |
| Blocked                 | 0 as a whole phase. The 1M-order part of Phases 2, 6 and 8 is blocked on this 8 GB machine. |

## 2. Phase-by-phase status

| #   | Phase                    | Implemented                              | Automated tests exist                       | Tests pass (evidence)                                            | Verified at scale                                     | Status                  |
| --- | ------------------------ | ---------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------- | ----------------------- |
| 1   | Performance audit        | Yes (`docs/PERFORMANCE_AUDIT.md`)        | n/a (document)                              | n/a                                                              | n/a                                                   | **COMPLETED**           |
| 2   | PostgreSQL optimization  | Yes                                      | Yes                                         | Unit ✅ today; integration ⚠ last full run before Phase 6        | 200k only; 1M/10M not run                             | **PARTIALLY COMPLETED** |
| 3   | API optimization         | Yes                                      | Yes (`request-cost.int-spec.ts`)            | Unit ✅; integration ⚠ not re-run                                | Request cost measured                                 | **PARTIALLY COMPLETED** |
| 4   | Redis caching            | Yes                                      | Yes (`cache.int-spec.ts`, perf spec)        | Reported 23/23 + 214 at the time; ⚠ not re-run                   | Mixed: concurrent throughput regressed in 2 of 3 runs | **PARTIALLY COMPLETED** |
| 5   | BullMQ / background jobs | Yes                                      | Yes (`email-outbox.int-spec.ts`, perf spec) | Reported 22/22 + 236 at the time; ⚠ not re-run                   | Throughput measured (≈30–43 jobs/s)                   | **PARTIALLY COMPLETED** |
| 6   | Dashboard analytics      | Yes (API + web)                          | Yes (16 unit, 20 integration, perf spec)    | Unit ✅ today (16/16 within 142); full integration **never run** | 1k–100k; 1M failed (memory)                           | **PARTIALLY COMPLETED** |
| 7   | Cursor-based pagination  | **No**                                   | No                                          | —                                                                | —                                                     | **PENDING**             |
| 8   | Large-scale load testing | **No** (only in-process Jest perf specs) | No                                          | —                                                                | —                                                     | **PENDING**             |

## 3. Evidence per phase

### Phase 1: Performance audit (COMPLETED)

- `docs/PERFORMANCE_AUDIT.md` (223 lines, dated 2026-11-04). It ranks findings F1–F10, lists index proposals and contains the Redis design.
- It is an analysis deliverable. It contains no code and claims no benchmark numbers, which this audit confirmed.
- Its findings drove Phases 2–6, and the later work can be traced back to them.

### Phase 2: PostgreSQL optimization (PARTIAL)

- **Code:** migrations `1798000014000-ListIndexes.ts`, `1798000021000-OrderUsageCounters.ts` and `1798000022000-PerRestaurantUsage.ts`. These cover the F1 counter table, F3 bulk order writes, F4 index-friendly date filters, the F7 Super Admin list and F10 explicit columns.
- **Tests:** `integration/order-limits.int-spec.ts`, `orders.int-spec.ts`, `lists.int-spec.ts`, `database.int-spec.ts`, and `src/database/database-conventions.spec.ts` (passes today).
- **Benchmark:** `apps/api/perf/results/phase2-plans.md` has EXPLAIN plans before and after at **200,000 orders only**.
- **Gaps:**
  - The report itself says the 1M and 10M runs "have not been run" (`docs/PHASE_2_PERFORMANCE_REPORT.md:188`).
  - F8 trigram search indexes are deferred.
  - Integration tests have not been re-run since the Phase 6 change to `orders.service.ts`.

### Phase 3: API optimization (PARTIAL)

- **Code:** permissions are built once per request in the guard and reused (F2). There is a light usage banner endpoint (F6) and per-restaurant monthly-usage time zones.
- **Tests and measurement:** `integration/request-cost.int-spec.ts` measures and guards the SQL statements per request. Before and after results are in `perf/results/phase3-request-cost{.before,}.md`.
- **Gaps:**
  - Integration has not been re-run since Phase 6.
  - The pending-invites badge still loads the whole team list (`PHASE_3_PERFORMANCE_REPORT.md:137`).

### Phase 4: Redis caching (PARTIAL)

- **Code:** `src/shared/cache/` (`CacheService` with versioned namespaces, post-commit invalidation, single-flight, circuit breaker and PostgreSQL fallback) on the shared `REDIS_CLIENT`.
- **Redis configuration:** `docker-compose.yml:42` sets `--maxmemory-policy noeviction`. This is correct, because BullMQ shares the instance, and it must stay.
- **Tests:** `integration/cache.int-spec.ts` (23 tests), `redis.int-spec.ts`, and `src/shared/redis/redis.options.spec.ts` (passes today).
- **Benchmark:** `perf/results/phase4-cache.md`. Sequential DB latency improved only modestly. **Concurrent throughput got worse with the cache in runs 1 and 3** (63 → 42 and 47 → 37 req/s) and better in run 2 (49 → 67 req/s), according to `PHASE_4_REDIS_REPORT.md:165`. The cache does reduce PostgreSQL tuples and statements, but the latency gain is not demonstrated for these four endpoints.
- **Gaps:**
  - The concurrency regression is unexplained.
  - Known open item: `MfaService.registerFailure` uses `INCR` and then `EXPIRE`, which is not atomic (report item 5).
  - Integration has not been re-run since Phase 6.

### Phase 5: BullMQ / background jobs (PARTIAL)

- **Code:**
  - `src/queues/`, `src/worker/` (`email.processor.ts`, `outbox-recovery.service.ts`, `worker-heartbeat.service.ts`), `src/worker.ts` and `src/worker-health.ts`.
  - Migration `1798000023000-EmailOutbox.ts`, which adds an encrypted payload that is erased when a message is sent or fails.
- **Tests:** `integration/email-outbox.int-spec.ts` (22 tests: rollback, tampering, forged tenant jobs, Redis down at publish, at-least-once behaviour).
- **Benchmark:** `perf/results/phase5-bullmq.md` measured about 30–43 jobs/s, with 0% permanent failure under 10% injected failures.
- **Gaps:**
  - Delivery is at-least-once only. This is documented.
  - Only email uses the queue. Other slow work identified in Phase 1 is still synchronous.
  - Monitoring timings are approximate (last 200 jobs).
  - Integration has not been re-run since Phase 6.

### Phase 6: Dashboard analytics (PARTIAL)

- **Code:**
  - `src/modules/analytics/`: controller, scope, queries, range, service and platform service.
  - Migration `1798000024000-AnalyticsIndexes.ts`.
  - Invalidation in `orders.service.ts:757`.
  - Web dashboard wiring.
- **Tests:**
  - `analytics-range.spec.ts` passes today.
  - `integration/analytics.int-spec.ts` (20 tests) is reported as passing in isolation in the previous session.
  - **The full integration suite was never run after Phase 6** (`PHASE_6_ANALYTICS_REPORT.md:134,188`).
- **Benchmark:** `perf/results/phase6-analytics.md/.json` covers 1k, 10k and 100k orders.
  - At 100k, uncached concurrent load produced **500 errors from pool exhaustion**: 2 of 400 requests, and 31 in an earlier run. The pool is `DATABASE_POOL_MAX` = 10.
  - With the cache on there were 0 failures.
  - **1M was not measured**: the host ran out of memory.
- **Environment state found today (read-only queries):**
  - `foodstack_test` still contains **10 `bench6-*` tenants with 1,450,000 orders**. The cleanup the report describes as "in progress" did not finish. There were no active queries, so it is not still running.
  - Dev database `foodstack` has 25 migrations applied, the latest being `EmailOutbox1798000023000`. **`AnalyticsIndexes1798000024000` is missing.** `foodstack_test` has 26.
  - The dev API on :4000 answers `GET /api/v1/health` with 200.
- **Unverified:** the dashboard has not been checked in a browser.

### Phase 7: Cursor-based pagination (PENDING)

- `src/common/pagination/paged.ts` uses only **offset pagination plus an exact `count(*)` on every page** (lines 107–119), and 9 source files use `runPaged`.
- A search for `cursor` or `keyset` across `apps/api/src` finds only the unrelated `queue-monitor.service.ts`.
- There are no cursor DTOs, no tie-breaker ordering, no tests and no web changes. Audit finding F5 is therefore still open.

### Phase 8: Large-scale load testing (PENDING)

- There is no k6, Artillery or autocannon configuration, and no load-test scripts in `infra/` or `infrastructure/`.
- The perf specs (`apps/api/perf/*.perf-spec.ts`) are in-process Jest benchmarks with at most 20 concurrent workers. They are not external HTTP load tests against a deployed stack.
- No soak, spike or multi-instance tests exist, and nothing has reached 1M orders.

## 4. Missing implementations and failed or unrun tests

**Tests run in this audit**

- `pnpm --filter @foodstack/api test`: **19/19 suites, 142/142 tests passed.**
- `pnpm --filter @foodstack/api typecheck` (src, integration and e2e projects): **passed.**

**Not run, and why**

- `test:integration` and `test:e2e` were not run. Their setup creates and drops tables and reverts migrations in `foodstack_test` (see `integration/setup-env.ts`). That conflicts with this audit's rules against modifying database data or running destructive migrations, and with the leftover 1.45M benchmark rows.
- Lint, web tests and the perf specs were not run either.

**Failures on record**

- Phase 6 benchmark: uncached 100k concurrent load caused 500 errors (pool acquire timeout).
- Phase 6 1M run: three failed attempts (integer overflow, then Jest timeout, then out of memory).

**Missing work**

- All of Phase 7 and all of Phase 8.
- 1M and 10M datasets for Phases 2 and 6.
- F8 trigram search.
- Analytics migration on the dev database.
- Bench6 data cleanup.
- Browser verification of the dashboard.

## 5. Security and tenant isolation

**Positive**

- All tenant tables have RLS forced. `test/database/rls-coverage.e2e-spec.ts` and `tenant-isolation.e2e-spec.ts` exist but were not run in this audit.
- Analytics resolves scope from server-built access (`analytics-scope.ts`). It returns 403 for any restaurant or branch outside the caller's authorised set, and a Branch Manager only sees their assigned branches.
- The cache key includes the tenant namespace and a digest of the authorised branch set. The cache is read only after authorization.
- The Phase 5 worker re-checks the tenant on every job, and forged jobs fail without retry. Outbox payloads are encrypted, then erased.

**Findings**

1. **`GET /analytics/customers` only requires `report:view`.** The Phase 6 audit (§3) specified `report:view` **and** `customer:read`, but the controller has only `@RequirePermission('report:view')` (`analytics.controller.ts:55-56`). It returns aggregates only, so this is low severity, but it does not match the approved design.
2. **MFA failure counter** uses `INCR` then `EXPIRE`, which is not atomic. If the second command fails, the counter has no TTL. This is pre-existing and still open.
3. **Rate limiting fails open** when Redis is down. This is by design, and account lockout is enforced in PostgreSQL. Accept it explicitly before production.
4. **Cross-tenant isolation suites were not re-run after Phase 6.** Isolation is therefore verified by code review only for the current HEAD.

## 6. Performance and scalability

- **Offset pagination with `count(*)`** grows linearly with deep pages and large tenants (F5, still open).
- **The connection pool of 10** is exhausted by 80 simultaneous uncached analytics calls at 100k orders. Production needs pool sizing or PgBouncer, and should cap concurrency for heavy reports.
- **`thisYear` analytics on a large table** fall back to sequential scans, at 0.2–0.8 s per uncached statement at 100k orders. At 1M and above this needs a rollup table such as `daily_branch_sales` or longer cache TTLs. This is unmeasured.
- **Under concurrency, the Phase 4 cache does not consistently improve throughput.** It does reduce database load.
- **Cached analytics latency stays at about 40 ms** from 1k to 100k orders. The remaining time is authentication and permission loading, which are deliberately not cached.
- **Index creation:** no index migration uses `CONCURRENTLY`. Large production tables need a non-transactional migration path.

## 7. Production readiness

**Not production-ready at scale.** The system is functionally rich and well tested at the unit level, and the security design is sound. Before production it needs:

- a full green integration and e2e run on the current HEAD;
- cursor pagination for high-volume lists;
- real load testing;
- connection pool and PgBouncer sizing;
- a 1M+ benchmark on adequate hardware;
- a clean test database and an up-to-date dev database.

For small tenants (≤100k orders) the current build is reasonable once the integration suite is confirmed green.

## 8. Recommended priority order

1. **Clean `foodstack_test`.** Remove the `bench6-*` tenants with a scoped, batched delete, with your approval, because it is a data change. Then run the full `test:integration` and `test:e2e` on HEAD. This one step can move Phases 2–5 to COMPLETED.
2. **Apply `AnalyticsIndexes1798000024000` to the dev database** (`pnpm db:migrate`, with your approval). Then restart and health-check the API on :4000, because builds crash it.
3. **Phase 6 fixes:**
   - Decide on `customer:read` for `/analytics/customers` and add it if confirmed.
   - Raise or tune the pool size, or limit concurrency for uncached analytics.
   - Verify the dashboard in a browser.
4. **Phase 7:**
   - Add keyset pagination (`(created_at, id)` tie-breaker, opaque signed cursor, optional `total`) for orders, payments, inventory movements and platform invoices.
   - Add tests: stable ordering, inserts during paging, tenant and branch scoping, tampered cursor rejected.
   - Make the corresponding web table changes.
5. **Phase 8:**
   - Choose a tool (k6 recommended) and add scripts for POS order creation, the dashboard, lists and auth.
   - Define SLOs (p95 and error rate).
   - Run baseline, spike and soak tests against a built API with the worker.
   - Run the 1M and 10M datasets on a machine with ≥16 GB RAM or in a cloud environment. **Do not retry on this 8 GB machine.**
6. **Follow-ups:**
   - Make the MFA counter atomic.
   - Investigate the Phase 4 concurrent-throughput regression.
   - Add F8 trigram search.
   - Add the pending-invites count endpoint.
   - Document a `CONCURRENTLY` index strategy.

### Exact tasks to close each remaining phase

- **Phase 2:** green integration suite on HEAD; 1M-order EXPLAIN plans for F1 and F4 on adequate hardware; F8 decided (implement or formally descope).
- **Phase 3:** green `request-cost.int-spec.ts` within the full suite on HEAD.
- **Phase 4:** green `cache.int-spec.ts` and `redis.int-spec.ts` on HEAD; explain the throughput regression or accept it in writing; fix the MFA `INCR`/`EXPIRE` issue.
- **Phase 5:** green `email-outbox.int-spec.ts` on HEAD; worker container smoke test (healthy, then sends a queued email).
- **Phase 6:** clean `bench6`; green full integration run; migration applied to dev; `customer:read` decision; browser check; pool fix; 1M benchmark on adequate hardware.
- **Phase 7:** the full implementation and tests described in step 4.
- **Phase 8:** the full implementation and runs described in step 5.

---

## Answer: how many of the 8 phases are genuinely completed today?

**One. Only Phase 1, the performance audit, is genuinely completed.** Phases 2–6 are implemented and committed but lack a full integration run on the current code, and some lack scale verification. Phases 7 and 8 have not been started.
