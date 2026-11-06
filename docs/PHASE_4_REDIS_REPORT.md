# Phase 4 — Redis Caching Report

_Date: 2026-11-04 · Precondition: `docs/PHASE_4_REDIS_AUDIT.md` · Status: implemented and tested, **not committed**, awaiting review. Phase 5 has not started._

## 1. Summary

- **One centralized cache** (`CacheService`) on the existing request-path Redis client. No new Redis connections, and no module talks to Redis for caching directly.
- **Four reads are cached**: menu catalogue, menu categories, the inventory summary per branch, and the public plan list/detail.
  - Authorization still runs on every request, before the cache lookup.
  - Per-caller fields (`canManage`, branch lists, permissions) are always computed per request, never cached.
- **Invalidation is versioned and post-commit.** A write bumps a namespace version only after its transaction commits; a rollback bumps nothing.
- **Redis failure falls back to PostgreSQL.** A circuit breaker stops a dead Redis from adding a timeout to every request, and after an outage that lost an invalidation, a global epoch bump on recovery retires stale entries.
- **Measured (3 runs, laptop):**
  - SQL statements per request fall 13 → 10 (`/menu`), 12 → 10 (`/menu/categories`), 11 → 9 (`/inventory/summary`) and 4 → 0 (`/plans`).
  - Under mixed concurrent load, rows read from PostgreSQL per request fall ~81% (472–512 → 93–97) and buffer hits fall ~37%.
  - **Latency did not change consistently.** It varied by up to 2× between runs in both directions. See §9.
- **Unchanged:** rate limiting, TOTP/MFA, BullMQ, the response formats, and the `/billing/usage` browser cache.

## 2. Modified and added files

| File                                                                  | Change                                                                                                                      |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/cache/cache.service.ts`                                   | **New.** Cache-aside, versioned invalidation, single-flight, jitter, circuit breaker, epoch recovery, envelope check, stats |
| `src/shared/cache/cache.keys.ts`                                      | **New.** Namespace and entry builders; segment validation                                                                   |
| `src/shared/cache/cache.metrics.ts`                                   | **New.** Per-entry counters, invalidation counts, Redis latency percentiles                                                 |
| `src/shared/cache/cache.module.ts`                                    | **New.** Global module                                                                                                      |
| `src/app.module.ts`                                                   | Registers `CacheModule`                                                                                                     |
| `src/config/env.validation.ts`                                        | `CACHE_ENABLED`, four `CACHE_TTL_*_SECONDS`, `CACHE_BREAKER_MS`                                                             |
| `src/core/db/db-context.ts`                                           | `Db.afterCommit(key, fn)` (runs only after COMMIT, deduplicated per key); `Db.tenantId()`                                   |
| `src/modules/menu/menu.service.ts`                                    | Caches `get` and `categories`; invalidates from the three manage-path resolvers                                             |
| `src/modules/inventory/inventory.service.ts`                          | Caches `summary`; invalidates on item and movement writes                                                                   |
| `src/modules/account/account.service.ts`                              | Restaurant profile update invalidates the menu and inventory namespaces                                                     |
| `src/modules/billing/platform-billing.service.ts`                     | All six plan writes invalidate `global:plans`                                                                               |
| `src/modules/billing/public-plans.controller.ts`                      | `GET /plans` and `/plans/:slug` read through the cache (the HTTP `Cache-Control` header is kept)                            |
| `src/modules/platform/platform.controller.ts`                         | `GET /platform/cache` (Super Admin, `platform:dashboard_view`)                                                              |
| `integration/cache.int-spec.ts`                                       | **New.** 23 tests                                                                                                           |
| `perf/phase4-cache.perf-spec.ts`, `perf/results/phase4-cache.md`      | **New.** Benchmark and three measured runs                                                                                  |
| `docs/PHASE_4_REDIS_AUDIT.md`, this file, `docs/PERFORMANCE_AUDIT.md` | Docs                                                                                                                        |

## 3. Architecture

```
request → AuthGuard (session, permissions: DB, uncached)
        → service: db.run(tenant scope) {
            access check for this restaurant/branch          ← always
            data = cache.getOrLoad(ns, entry, ttl, () => SQL) ← cached part only
            return { ...data, per-caller fields }             ← always computed
          }
write   → db.run { access check → registers cache.invalidateAfterCommit(ns) → SQL }
          COMMIT → INCR version(ns)       (rollback: nothing)
```

**Redis keys** (prefix `{QUEUE_PREFIX}:cache`):

- Data: `…:e{epoch}:{namespace}:v{version}:{entry}`, with a TTL.
- Version: `…:ver:{namespace}`, a 7-day TTL refreshed on every bump.
- Epoch: `…:epoch`.

**Lookup:** one `MGET` (epoch and version), then one `GET`. On a miss, the result is loaded and written back with `SET … EX`.

**Values** are stored as `{"k": "<namespace>|<entry>", "d": <payload>}`. An entry whose `k` doesn't match the requested key is discarded and reloaded, so a key bug can never serve another key's data.

## 4. Cache key strategy and tenant isolation

| Namespace                                               | Entries                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| `tenant:{tenantId}:restaurant:{restaurantId}:menu`      | `catalogue`, `categories`                                   |
| `tenant:{tenantId}:restaurant:{restaurantId}:inventory` | `branch:{branchId}:summary`                                 |
| `global:plans`                                          | `public:list`, `public:slug:{slug}` (public catalogue only) |

- **Where the ids come from.** The tenant id comes from the authenticated context. Restaurant and branch ids come from the caller's access list, after the permission check. Nothing comes from raw input.
- **Segment validation.** Every segment must match `^[A-Za-z0-9_-]{1,80}$`, so `:`, `*` or spaces can't change a key's shape.
- **Keys are not authorization.**
  - Another tenant passing a cached restaurant id still gets `403`.
  - A branch manager asking for another branch's summary, already cached by the owner, still gets `403`.
  - Both cases are tested.
- **RLS still applies on misses.** Every load runs inside the caller's tenant-scoped transaction, so a key bug could at worst read the caller's own tenant.
- **No cross-tenant key collisions.** Single-flight is keyed by the full namespace and entry, so concurrent loads from different tenants are never shared.

## 5. TTL strategy

| Entry             | TTL (default) | Env                                   | Why                                                                                 |
| ----------------- | ------------- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| Menu catalogue    | 180 s         | `CACHE_TTL_MENU_SECONDS`              | Invalidated on every write. TTL only bounds out-of-band writes (SQL console, seeds) |
| Menu categories   | 300 s         | `CACHE_TTL_MENU_CATEGORIES_SECONDS`   | Same                                                                                |
| Inventory summary | 30 s          | `CACHE_TTL_INVENTORY_SUMMARY_SECONDS` | Stock moves often; short TTL as a safety net                                        |
| Public plans      | 300 s         | `CACHE_TTL_PLANS_SECONDS`             | Rare writes, all invalidated                                                        |

- Every TTL gets up to +10% jitter.
- `CACHE_ENABLED=false` turns the cache off: every read goes to PostgreSQL.
- These are starting values. The `/platform/cache` hit ratios in production should drive changes.

## 6. Invalidation strategy

The version is read **before** the load. A load that races with a write is stored under the old version and never served after that write's invalidation (tested).

| Event                                                                           | Invalidates                    | Hook                                                                                                                                |
| ------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Menu category create/update/delete, item create/update/delete, import, portions | `menu` of that restaurant      | `restaurant('menu:manage')`, `categoryForManage`, `itemForManage`: every menu write goes through one of them                        |
| Inventory item create/update/delete, stock movement                             | `inventory` of that restaurant | `restaurantForItems` result, `itemForManage`, `recordMovement`                                                                      |
| Restaurant profile update                                                       | `menu` and `inventory`         | `AccountService.updateRestaurant`                                                                                                   |
| Plan create/duplicate/update/restore/archive/delete                             | `global:plans`                 | `PlatformBillingService`                                                                                                            |
| Order created, payment completed, refund                                        | **nothing to invalidate**      | No order, revenue or dashboard data is cached. Orders do not deduct stock and do not change menu availability (it is a manual flag) |
| Subscription change                                                             | **nothing**                    | Subscription status and feature flags are not cached (§7)                                                                           |

- **Post-commit only.** `DbContext.run` runs the `afterCommit` hooks after `dataSource.transaction` resolves. They never run on rollback (tested: thrown error, SQL error, and a `409` duplicate leaving the cached menu as a hit).
- **A failing hook doesn't fail the request**, which has already committed.
- **Cross-instance.** Versions live in Redis, so every API instance sees a bump immediately. No outbox is needed.
- **The one remaining gap** is a bump lost to a Redis outage. That is handled by the epoch (§8).

## 7. Deliberately not cached

- **Authorization:** permissions, access and session checks.
- **Entitlements:** subscription status, feature flags and plan limits. These are enforcement decisions, and revocation must be immediate.
- **Money and live state:** orders, payments, refunds, invoices, kitchen tickets and the add-on purchase state.
- **Credentials and tokens.**
- **Not worth a key:**
  - `GET /menu/items`: unbounded filter and page combinations, so the hit ratio would be low.
  - `GET /branches/:id`: one primary-key row.
- **Dashboard, sales, order statistics, popular items:** these endpoints do not exist yet. They are Phase 6, which will reuse `CacheService` with an order/payment invalidation rule.
- The `/billing/usage` browser cache is unchanged.

## 8. Failure handling and stampede protection

- **Redis down.** The client already fails fast (no offline queue, 1 s command timeout). On any cache error the request is served from PostgreSQL. The breaker then skips Redis for `CACHE_BREAKER_MS` (5 s), so an outage costs one failed command per window, not one per request (tested: 5 requests → 1 Redis attempt).
- **Logging.** One error line when the cache becomes unavailable, one line when it recovers. Values are never logged.
- **Invalidation during an outage.** The namespace bump fails, and the service remembers that one was lost. On the next successful Redis contact it `INCR`s the global epoch before reading, which retires every entry written before the outage (tested end to end).
- **Stampede.**
  - Single-flight per instance: 25 concurrent identical requests → 1 load (tested). If the leader's load fails, followers load on their own.
  - TTL jitter.
  - The breaker prevents a timeout storm while Redis is recovering.
  - **No distributed lock.** Per-instance single-flight bounds a cold key to one query per instance, which is cheap for these payloads.
- **Security controls are untouched:**
  - Rate limiting still fails **open** by design (pre-existing, with account lockout enforced in PostgreSQL).
  - TOTP replay protection and MFA attempt counting still fail **closed**.

## 9. Measurements (real runs, `perf/results/phase4-cache.md`)

**Setup:**

- Intel i5-10310U laptop (8 threads, 8 GiB), PostgreSQL 18 and Redis 8 in Docker on the same host.
- Full Nest app via supertest.
- Data: 224 menu items (75 with portions) and 180 stock items.
- Sequential: 200 requests per endpoint. Concurrent: 20 workers × 20 requests.
- Three runs.

| Metric                                                                            | Database only    | Cache enabled       |
| --------------------------------------------------------------------------------- | ---------------- | ------------------- |
| Statements/request `/menu` · `/menu/categories` · `/inventory/summary` · `/plans` | 13 · 12 · 11 · 4 | 10 · 10 · 9 · 0     |
| Concurrent: PG rows returned / request                                            | 472 – 512        | 93 – 97             |
| Concurrent: PG buffer hits / request                                              | 97 – 106         | 65 – 68             |
| Concurrent: statements / request                                                  | 10.0             | 7.3                 |
| Hit ratio (cache run, warm-up included)                                           | —                | 0.997               |
| Redis memory, all cache keys                                                      | —                | ≈ 108 KiB (29 keys) |

Sequential medians (ms) per run:

| Endpoint             | DB-only (runs 1, 2, 3) | Cache (runs 1, 2, 3) |
| -------------------- | ---------------------- | -------------------- |
| `/menu`              | 56, 65, 76             | 39, 80, 42           |
| `/menu/categories`   | 39, 37, 45             | 48, 43, 37           |
| `/inventory/summary` | 36, 39, 46             | 41, 39, 36           |
| `/plans`             | 15, 17, 16             | 15, 14, 14           |

Concurrent throughput (req/s, DB → cache): run 1: 63 → 42 · run 2: 49 → 67 · run 3: 47 → 37.

**Interpretation:**

- **Database load: a large, consistent reduction.** Statement counts are deterministic. PG row and buffer figures are stable to within ~8% across runs.
- **Latency on this machine: no consistent effect.** Run-to-run variance (up to 2×, in both directions) is larger than any cache effect. That is expected: about 9 statements per request remain uncached on purpose (auth guard, session, permission look-up, the restaurant check, BEGIN/COMMIT), and on a single laptop that work, plus Docker, Node and the load generator competing for 4 cores, dominates.
- **No latency improvement is claimed.**
- **Where the benefit should show:** as freed PostgreSQL capacity when the database, not the app process, is the bottleneck. That needs the Phase 7 k6 setup on separate hosts to confirm.

## 10. Tests

| Suite                                                                                                                                    | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integration/cache.int-spec.ts` (new)                                                                                                    | **23/23 passed**: hit, miss, TTL expiry, namespace invalidation, tenant and branch key isolation, key-segment validation, envelope mismatch, single-flight (25 → 1), failed-leader fallback, version race, Redis outage + breaker, outage → recovery → epoch, post-commit hooks (commit, rollback ×2, failing hook), HTTP invalidation for every rule in §6, rollback (409) keeps the cache, per-caller fields not cached, cross-tenant 403, cross-branch 403, Super Admin-only stats, no values in stats |
| API unit (`pnpm test`)                                                                                                                   | 18 suites, 126 passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| API integration (`pnpm test:integration`, incl. auth, MFA, rate limiting, Redis, subscriptions, billing, tenant isolation, request cost) | 20 suites, **214 passed**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Web (`vitest`)                                                                                                                           | 4 files, 24 passed; web typecheck passes                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Lint (`eslint .` in `apps/api`), `tsc --noEmit` (src)                                                                                    | clean                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

**Pre-existing, unrelated:** `tsc -p integration/tsconfig.json` reports two type errors in `addons.int-spec.ts:212` and `plan-management.int-spec.ts:154` (`seedOrderPacks(DataSource)` typing). Neither file was touched in this phase, and both suites pass at runtime.

## 11. Monitoring

`GET /api/v1/platform/cache` (Super Admin) returns, for this instance:

- Per entry: hits, misses, hit ratio, fallbacks to PostgreSQL, coalesced loads and errors.
- Invalidation counts per area, and invalidation errors.
- Redis round-trip p50/p95/p99 over the last 1,024 commands.
- From Redis `INFO`: `used_memory`, `maxmemory`, `maxmemory_policy`, `evicted_keys`, `expired_keys`, `keyspace_hits` and `keyspace_misses`.

Metric labels have ids removed (bounded cardinality). No keys or values are returned.

## 12. Remaining issues and recommendations

1. **Redis eviction: keep `noeviction`.** _(Corrected in Phase 5: the earlier `volatile-lru` suggestion is withdrawn because BullMQ requires `noeviction`; see docs/PHASE_5_BULLMQ_AUDIT.md §2.)_ Cache keys all carry TTLs, so they expire without eviction.
2. **Metrics are per instance and in memory.** Export them to the monitoring stack (Prometheus/CloudWatch) when one exists.
3. **Latency benefit is unproven on this hardware** (§9). Re-measure with k6 against a deployed stack in Phase 7.
4. **Out-of-band writes** (seeds, manual SQL) are only bounded by TTL. Run `CacheService.invalidate` from any future admin CLI that writes these tables.
5. **Pre-existing:** `MfaService.registerFailure` uses `INCR` then `EXPIRE` as two commands. If the second fails, the counter has no TTL. Suggest a `SET NX EX` + `INCR` or a Lua script, as a separate security-reviewed change.
6. **Phase 6 dashboard.** Add namespace `tenant:{t}:restaurant:{r}:sales` and invalidate it from order completion, payment and refund via `invalidateAfterCommit`. Label figures with an "as of" time.
