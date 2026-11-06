# Phase 4 — Redis Audit (before implementation)

_Date: 2026-11-04 · Scope: `apps/api` · No code was changed for this audit._

## 1. Connections

| Connection                                  | Where                                       | Options                                                                                                                                         | Behaviour while Redis is down                                                                               |
| ------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Shared request-path client (`REDIS_CLIENT`) | `src/shared/redis/redis.module.ts` (global) | `buildCacheRedisOptions`: `maxRetriesPerRequest: 1`, `enableOfflineQueue: false`, `commandTimeout: 1000 ms`, ready check, optional TLS/password | Commands reject promptly (covered by `redis.options.spec.ts`); ioredis keeps reconnecting in the background |
| BullMQ queues                               | `src/queues/queue.module.ts`                | `buildQueueRedisOptions`: `maxRetriesPerRequest: null` (BullMQ requirement)                                                                     | Retry forever; jobs wait                                                                                    |

- One shared client for cache, rate limiting, MFA and health. Closed with `quit()` (falling back to `disconnect()`) in `onApplicationShutdown`.
- Errors are logged **once per outage** (`logRedisErrorsOncePerOutage`), with a "restored" line on `ready`.
- Health: `GET /health` pings Redis with a 2 s backstop (`redis.health.ts`).
- Config: `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_TLS`. Redis 8 (alpine) in Docker with AOF (`appendfsync everysec`). **No `maxmemory` / eviction policy is configured**: Redis is unbounded and never evicts. Since rate-limit, MFA and BullMQ keys share the instance, a cache must not depend on eviction; every cache key needs a TTL.

## 2. Existing key usage

All prefixes derive from `QUEUE_PREFIX` (default `foodstack`).

| Use                 | Key                                               | TTL              | Failure policy                                                                                                                                                    |
| ------------------- | ------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rate limit counter  | `{prefix}:throttle:{<throttler>:<tracker>}:hits`  | window (PEXPIRE) | **Fails open** (logged ≤ 1/min); account lockout is enforced in PostgreSQL                                                                                        |
| Rate limit block    | `{prefix}:throttle:{<throttler>:<tracker>}:block` | block duration   | same, atomic Lua script, hash-tagged for Cluster                                                                                                                  |
| TOTP replay guard   | `{prefix}:auth:totp-step:{userId}:{step}`         | 90 s, `SET NX`   | **Fails closed**: a Redis error propagates, sign-in fails (correct for security)                                                                                  |
| MFA attempt counter | `{prefix}:auth:mfa-attempts:{challengeId}`        | 15 min           | Fails closed (error propagates). Note: `INCR` then `EXPIRE` is two commands; if the second fails the key has no TTL (minor, pre-existing, not changed in Phase 4) |
| BullMQ              | `{prefix}:{queue}:…`                              | BullMQ-managed   | retry forever                                                                                                                                                     |

There is **no application cache yet**. The only caching today is HTTP: `Cache-Control: public, max-age=60` on `GET /plans` and `/plans/:slug`, and the web app's browser cache for `/billing/usage` (kept as is).

## 3. Read paths evaluated for caching

Measured cost from `perf/results/phase3-request-cost.md` (statements include BEGIN/COMMIT, and the per-request permission look-up which must stay uncached).

| Candidate in the brief                                             | What exists                                                                                      | Decision                                                                                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard summary, today's sales, order statistics, popular items  | **No endpoint exists** (dashboard shows team counts + trial card; the sales endpoint is Phase 6) | Not implemented: nothing to cache. Key namespace and invalidation hooks reserved for Phase 6                                                         |
| Inventory summary                                                  | `GET /inventory/summary` (per branch)                                                            | **Cache** the aggregate (counts, value, categories), keyed by restaurant + branch. Per-caller fields (`canManageItems`, `branches`) stay computed    |
| Restaurant settings                                                | `restaurants` row read by menu/inventory (name, currency)                                        | Covered inside the menu/inventory payloads and invalidated on `PATCH /account/restaurant`; no separate endpoint is hot enough to justify its own key |
| Branch settings                                                    | `GET /branches/:id` single PK lookup                                                             | Not cached: one indexed row, cheaper than the permission check that must run anyway                                                                  |
| Menu categories                                                    | `GET /menu/categories`                                                                           | **Cache** (restaurant-level)                                                                                                                         |
| Active menu items / availability / details                         | `GET /menu` (full catalogue, POS hot path, 13 statements)                                        | **Cache** the catalogue (categories, items, variants)                                                                                                |
| Paged item search `GET /menu/items`                                | arbitrary filter/sort/page combinations                                                          | Not cached: low hit ratio, high key cardinality                                                                                                      |
| Subscription plan details                                          | `GET /plans`, `GET /plans/:slug` (public)                                                        | **Cache** (global, invalidated on plan writes) in addition to the existing HTTP header                                                               |
| Add-on configuration                                               | `GET /billing/addons` mixes catalogue with the tenant's purchases/requests                       | Not cached in Phase 4: payload includes purchase state (financial)                                                                                   |
| Subscription feature flags                                         | resolved by `SubscriptionLifecycleService` to **enforce** limits and access                      | **Not cached**: these are entitlement/authorization decisions; revocation must be immediate                                                          |
| Orders, payments, kitchen tickets, invoices, entitlement, sessions | —                                                                                                | Not cached (transactional / financial / authorization)                                                                                               |

## 4. Writers of the cached data (invalidation sources)

Found with a grep over `INSERT/UPDATE/DELETE` on the source tables (excluding migrations and tests):

- `menu_categories`, `menu_items`, `menu_item_variants`: only `MenuService` (create/update/delete category and item, import, `syncVariants`).
- `inventory_items`, `inventory_stock`, `inventory_movements`: only `InventoryService` (create/update/delete item, record movement). **Orders do not deduct stock**, so order creation does not touch inventory caches.
- `restaurants`: `AccountService.updateRestaurant` (name/currency affect both payloads) and `provisionTenant` (new restaurant, nothing cached yet).
- `plans`: `PlatformBillingService` (create, duplicate, update, restore, archive, delete) and the seed script (`launch-plans.ts`; run offline, bounded by TTL).

## 5. Transactions

All SQL goes through `DbContext.run(scope, work)` (one `dataSource.transaction`, RLS scope via `set_config(..., true)`). There is no post-commit hook today. Invalidating _inside_ `work` would be wrong (a rollback after the bump is harmless with versioning, but a concurrent reader could repopulate from pre-commit data under the new version). Invalidation must run **after the commit** — a small `afterCommit` hook on `Db` is enough; an outbox is not needed because the version bump is itself in shared Redis and seen by every instance.

## 6. Risks found and how Phase 4 addresses them

1. **Authorization must not move into the cache.** Every cached read keeps `access.forRequest` + the restaurant/branch permission check in front of the cache lookup. Keys use ids that already passed that check.
2. **Redis down.** The request-path client already fails fast. The cache adds a short circuit breaker so a dead Redis costs at most one timed-out command per cool-down window rather than one per request.
3. **Invalidation lost during an outage.** If a version bump fails, the namespace is remembered and a global epoch is bumped on recovery, so no pre-outage entry can be served after Redis returns.
4. **No eviction policy.** All cache keys get a TTL; payloads are small (menu catalogue is the largest).
5. **Rate limiting and MFA.** Untouched: same client, same keys, same failure policy (rate limit fails open by design, TOTP fails closed).
