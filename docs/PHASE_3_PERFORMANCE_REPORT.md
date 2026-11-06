# FoodStack — Phase 3 Performance Report

_API request optimization: permission reuse (audit F2), the usage banner (F6), and per-restaurant
time zones for monthly order usage. The architecture is unchanged: hand-written SQL through
`DbContext`, TypeORM for pooling and migrations only, no entities, no new indexes, no caching
layer._

---

## 1. Measured results

**Method.** `integration/request-cost.int-spec.ts`, which both measures and guards against regressions:

- **Statement count:** it wraps the single database entry point (`Db.query`, `Db.setScope`), so every SQL statement a request runs is counted. `BEGIN`/`COMMIT` are included (2 per transaction).
- **Permission-lookup timing:** it times `AccessService.tenantAccess`.
- **Runs:** one owner account in the integration database, 15 sequential requests after a warm-up, end to end through the Nest app.
- **Results files:** `apps/api/perf/results/phase3-request-cost.before.md` (before any Phase 3 change) and `phase3-request-cost.md` (after).
- **Caveat:** latency is from a developer laptop. Statement and lookup counts are exact; timings show direction, not production values.

| Request                                                            | SQL statements before → after | Permission look-ups before → after | Look-up time per request (ms) before → after | Median latency (ms) before → after | p95 (ms) before → after |
| ------------------------------------------------------------------ | ----------------------------- | ---------------------------------- | -------------------------------------------- | ---------------------------------- | ----------------------- |
| `GET /orders` (25 rows)                                            | 13 → **11**                   | 2 → **1**                          | 18.5 → 7.4                                   | 64.3 → 38.7                        | 133.0 → 44.8            |
| `GET /menu`                                                        | 15 → **13**                   | 2 → **1**                          | 22.4 → 7.8                                   | 69.2 → 46.7                        | 261.7 → 52.7            |
| `GET /billing/subscription`                                        | 16 → **14**                   | 2 → **1**                          | 25.4 → 7.6                                   | 91.2 → 50.5                        | 304.9 → 64.1            |
| `GET /billing/addons`                                              | 17 → **15**                   | 2 → **1**                          | 21.6 → 7.0                                   | 71.9 → 47.3                        | 157.8 → 61.7            |
| `GET /billing/entitlement` (no permission check on the route)      | 11 → 11                       | 1 → 1                              | 7.2 → 5.8                                    | 36.2 → 31.1                        | 78.9 → 36.9             |
| **Usage banner** (`/billing/addons` before → new `/billing/usage`) | 17 → **12**                   | 2 → **1**                          | 21.6 → 7.0                                   | 71.9 → **39.7**                    | 157.8 → 70.0            |

**Order-limit reservation** with the per-restaurant counters and the account-wide limit (`pnpm test:perf`): **0.55 ms** median on 200,000 orders. That compares with 263 ms for the original pre-Phase-2 count in the same run, and 0.35–0.58 ms for the Phase 2 single counter.

**Not measured:** Redis hit ratio. No cache was introduced (§4), so there is nothing to measure.

---

## 2. Permission checks (F2)

**Root cause.** For every restaurant route with `@RequirePermission`, `AuthGuard` validated the session, membership and subscription, then computed the caller's full permission set (`AccessService.tenantAccess`: role assignments with their permissions, plus the visible branches; 2 queries). It then discarded the result. The service opened its own transaction and computed the same set again (2 more queries). That was 15 call sites across 11 services and controllers.

**Fix.**

- **Guard:** the computed `TenantAccess` is attached to the request's server-side `AuthContext` (`auth.access`).
- **Services:** they call `AccessService.forRequest(db, auth)`, which returns that set, or performs the lookup when the route had no guard check (`/billing/entitlement`, for example).

**Why this keeps authorization intact.**

- **Server-built only:** `auth.access` is built by the guard from the database, after the session, user, membership, tenant and subscription checks passed. It is never read from client input (headers, body, token claims).
- **Per request, never cached:** it lives on the request object for that request alone. Nothing is cached across requests, users or tenants, so a permission change applies from the caller's next request, exactly as before.
- **Same data in both transactions:** the guard and the service compute in the same request under the same tenant RLS scope. Previously the service's second lookup ran milliseconds later; reusing the first removes no protection.
- **Unchanged logic:** branch checks (`allBranches`, `hasPermission(... { branchId })`) and Super Admin checks (`platformRoles`) are unchanged.

---

## 3. Per-restaurant time zones for monthly usage

**Root cause.** Phase 2 kept one counter row per tenant and month. Each order chose its month in its own restaurant's time zone, but all of a tenant's restaurants shared the row, and the usage display read the month of the _first_ restaurant. A restaurant account with restaurants in, say, India and Hawaii mixed their months for the hours around each month boundary.

**Fix** (migration `1798000022000-PerRestaurantUsage`):

- **One row per restaurant:** the key is `(tenant_id, restaurant_id, period)`, and the composite foreign key `(tenant_id, restaurant_id) → restaurants (tenant_id, id)` means a counter can never reference another tenant's restaurant.
- **Exact backfill:** counters were rebuilt from the orders table (non-cancelled orders, each restaurant's local month).
- **Usage this month** = for each restaurant, its counter for the month current _in that restaurant's time zone_, summed (`CURRENT_ORDERS_SQL`).
- **Reservation:** increments the ordering restaurant's current-month row, inserting only while the account-wide total stays within the limit.
  - The limit is account-wide but rows are per restaurant, so limited reservations take a transaction-level advisory lock per tenant.
  - Under READ COMMITTED the reservation's snapshot is taken after the lock, so it sees every committed reservation.
  - Unlimited plans skip the lock.
- **Release on cancel:** decrements the row of the order's own restaurant and the month that restaurant was in when the order was created.

**Unchanged.** The billing rules (what counts, limits, add-ons) did not change.

---

## 4. Usage banner (F6)

**Root cause.** The Restaurant Admin banner, on every page, called `GET /billing/addons`. That builds the whole marketplace: the add-on catalogue, purchase history with per-pack consumption, the pending invoice, and all four usage counts. The banner only needs the monthly order allowance. The client cached it for 15 s, so ordinary navigation refetched it.

**Fix.**

- **New endpoint:** `GET /billing/usage` (`restaurant:read`, same as the marketplace) returns only `{ orders: { planLimit, addonOrders, total, used, remaining, percent, warning } }`. It reads the subscription, live add-on capacity (skipped when the plan is unlimited) and the per-restaurant counters.
  - A test asserts it returns exactly the same `orders` object as `/billing/addons`.
- **Banner:** uses `useOrderUsage()`, cached for 60 s and refreshed on window focus. It shares the `['billing', tenant]` key prefix, so buying an add-on refreshes it straight away.
- **No Redis cache.** Measured at 12 statements and ~40 ms on a laptop, the endpoint does not justify one. A cache would also have to be invalidated by every order created in POS and Kitchen, which the brief's "no speculative caching" rule argues against.

---

## 5. Other request findings

- **Restaurant Admin shell requests per page.** These come from the shell and banners, not page content:
  - `GET /billing/entitlement`: subscription gate and trial banner, deduplicated by the shared query key, 60 s stale time.
  - `GET /billing/usage`: banner, 60 s.
  - `GET /team`: pending-invites badge, 60 s, shared with the Team page.

  After the first page, normal navigation within a minute makes **no** shell requests. Before, the banner refetched the heavy marketplace whenever it was over 15 s old.

- **Two transactions per request remain** (guard + service): about 4 statements of `BEGIN` / `set_config` / `COMMIT` overhead. Merging them would mean running every handler inside the guard's transaction, an architectural change that would also lengthen lock hold times. That is out of scope for this phase (§8).

---

## 6. Security verification

| Requirement                                   | How it is verified                                                                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL RLS intact                         | No policy removed. `tenant_usage_counters` keeps `ENABLE` + `FORCE` RLS with `tenant_isolation` and `platform_access`. Database suite passes.                           |
| Restaurant isolation                          | `order-limits.int-spec.ts`: separate counters per account, the other account's branch refused, and the composite FK rejects a counter for another account's restaurant. |
| Branch isolation                              | A branch-scoped cashier lists only their branch; another branch returns 403. Guard branch checks are unchanged.                                                         |
| Authentication                                | `auth.int-spec.ts` passes unchanged.                                                                                                                                    |
| Super Admin authorization                     | Platform suites (billing, plan management, add-ons, subscriptions) pass; `platformRoles` is untouched.                                                                  |
| No permission caching across users or tenants | `auth.access` exists only on one request object; `request-cost.int-spec.ts` asserts exactly 1 lookup per request, which proves nothing is reused between requests.      |
| Never trust client permissions                | `auth.access` is assigned only in `AuthGuard` from database results.                                                                                                    |

---

## 7. Tests

| Check                                           | Result                                                                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API unit tests                                  | 126 / 126                                                                                                                                                                |
| API integration tests (real PostgreSQL + Redis) | **191 / 191**: auth, authorization, team, tenant isolation, subscriptions, billing, add-ons, orders, plus 4 new time-zone tests and the new request-cost regression test |
| Web tests                                       | 24 / 24                                                                                                                                                                  |
| Lint / typecheck                                | Clean (API and web)                                                                                                                                                      |
| Plan capture (`pnpm test:perf`)                 | Passes                                                                                                                                                                   |
| Docker                                          | `docker build -f infrastructure/docker/api.Dockerfile .` succeeds                                                                                                        |
| Dev database                                    | Migration `1798000022000` applied                                                                                                                                        |

**New time-zone tests** (Asia/Kolkata UTC+5:30 and Pacific/Honolulu UTC−10 in one account):

1. Each restaurant's counter row uses the month current in its own time zone, and the displayed usage is their sum.
2. Account-wide limit across restaurants under concurrency: 8 simultaneous orders split across both restaurants with 2 slots left → exactly **2 created, 6 refused**.
3. Month boundary: orders placed at 23:30 UTC on 31 October and then cancelled release **October** in Honolulu (13:30 local) and **November** in Kolkata (05:00 local).
4. A counter row referencing another account's restaurant is rejected by the foreign key.

---

## 8. Remaining issues

- **Two transactions per request** (§5): an architectural follow-up, needing measurement of lock-hold impact before any change.
- **`tenantAccess` itself** costs about 6–8 ms in these runs (2 queries joining role assignments, roles, role permissions and permissions). A candidate for an `EXPLAIN` review on realistic role data.
- **Pending-invites badge** loads the full team list to count invitations; a count endpoint would be lighter. It is cached for 60 s.
- **Separate follow-ups, as instructed:** cursor pagination (F5), 1M and 10M benchmark data sets, and trigram search indexes (F8).

## 9. Files changed

**API:**

- New:
  - `src/database/migrations/1798000022000-PerRestaurantUsage.ts`
  - `integration/request-cost.int-spec.ts`
  - `perf/results/phase3-request-cost.before.md`, `phase3-request-cost.md`
- Auth and billing:
  - `src/modules/auth/auth.types.ts`: `AuthContext.access`
  - `src/modules/auth/auth.guard.ts`: keeps the computed set
  - `src/modules/auth/access.service.ts`: `forRequest()`
  - `src/modules/billing/subscription-lifecycle.service.ts`: per-restaurant usage, reservation and release
  - `src/modules/billing/addons.service.ts`, `addons.controller.ts`: `GET /billing/usage`
- Call sites switched to `forRequest()`: services in account, billing, customers, inventory, menu, orders, promotions, reports and team, plus `restaurant-overview.controller.ts`.
- Other:
  - `src/database/migration-list.ts`
  - `integration/order-limits.int-spec.ts`: time-zone tests
  - `perf/phase2-plans.perf-spec.ts`: current reservation SQL

**Web:** `src/lib/addons.ts` (`useOrderUsage`), `src/components/subscription/order-usage-banner.tsx`

**Docs:** this report, `docs/PERFORMANCE_AUDIT.md`
