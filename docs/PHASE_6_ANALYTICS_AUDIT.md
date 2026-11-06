# FoodStack — Phase 6 Analytics Audit

Status: **audit only, no implementation code changed.** Awaiting approval of the decisions in §9.
Date: 2026-11-05. Branch: `feature/central-authentication`.

---

## 1. Existing analytics functionality

| Where                                                        | What exists                                                                                                                                                                                                                                                                                                                    | Data source                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `apps/web/src/app/restaurant/dashboard/page.tsx` (647 lines) | Layout only. KPI cards "Total Revenue", "Total Orders", "Active Tables" render **empty states** ("Starts with your first bill"). "Revenue Overview" range switcher, "Order Status" donut (`center="—"`), "Top Selling Items", "Recent Orders" are placeholders. Only "Team Members" is live (`GET /team`). Trial card is live. | None for sales                                              |
| `apps/web/src/app/restaurant/overview.ts`                    | `GET /restaurant/overview`: restaurants (currency, timezone), branches visible to the caller, member count, roles.                                                                                                                                                                                                             | tenancy tables                                              |
| `apps/api/src/modules/reports`                               | `GET /reports/inventory`: stock in/usage/wastage/valuation per branch and local date range (≤366 days). Pattern worth reusing: `report:view` checked per branch, branch-timezone day bounds computed in SQL, `FILTER` aggregates.                                                                                              | `inventory_movements`, `inventory_items`, `inventory_stock` |
| `apps/web/src/app/restaurant/reports/`                       | Inventory report page + hand-written `bar-chart.tsx` (no chart library in `apps/web/package.json`).                                                                                                                                                                                                                            | `/reports/inventory`                                        |
| `apps/api/src/modules/platform/platform.controller.ts`       | `GET /platform/dashboard`: tenant counts by status, new tenants 7d, users, active sessions, failed logins 24h. `GET /platform/cache`, `GET /platform/queues`.                                                                                                                                                                  | `tenants`, `users`, `sessions`, `login_attempts`            |
| `apps/web/src/app/platform/dashboard/page.tsx`               | Renders the platform counts above. No revenue, subscription or growth charts.                                                                                                                                                                                                                                                  | `/platform/dashboard`                                       |
| Orders / payments lists                                      | `GET /orders`, `GET /payments` (paged, filters by status/channel/method/refunded). Operational lists, not aggregates.                                                                                                                                                                                                          | `orders`, `payments`                                        |

**Conclusion:** no sales/order/menu/customer analytics endpoint exists. Phase 1's audit (`PERFORMANCE_AUDIT.md` §5) planned one; it was never built.

## 2. Available database entities (migrations 1798000002000 → 1798000023000)

All tenant tables have `tenant_id` and **RLS forced** (`tenant_isolation` policy on `app.tenant_id`). Money is integer minor units (paise).

### Sales core (`1798000013000-Orders.ts`)

- **orders**: `restaurant_id, branch_id, order_number, channel ∈ {dine_in, takeaway, delivery, qr}`, `status ∈ {open, completed, cancelled}`, `kitchen_status ∈ {new, accepted, preparing, ready, served}`, `table_label`, `customer_id` (nullable), `subtotal_minor, discount_minor, tax_minor, total_minor, paid_minor, refunded_minor`, `created_at, completed_at, cancelled_at, kitchen_updated_at`. CHECKs: `completed ⇔ completed_at`, `cancelled ⇔ cancelled_at`.
  - Lifecycle facts from `orders.service.ts`: an order becomes `completed` when `paid_minor` reaches `total_minor` (line ~375). It can only be cancelled while `open` **and** with net paid = 0 (line ~324). `status` (billing) and `kitchen_status` (preparation) are **independent axes**: a paid order can still be `preparing`; a `served` order can still be unpaid (`open`).
- **order_items**: snapshot `name, variant_name, unit_price_minor, quantity, line_total_minor, discount_minor`, `menu_item_id, variant_id, category_id`, `status ∈ {active, void}`. Voids keep the row. No `branch_id`/`restaurant_id` (join through `orders`).
- **order_discounts**: per-promotion discount per order.
- **payments**: `order_id, branch_id, method ∈ {cash, card, upi}, amount_minor, refunded_minor, created_at`. Split payments are allowed (several rows per order).
- **refunds**: append-only (`UPDATE/DELETE` revoked), `payment_id, order_id, amount_minor, created_at`. **No `branch_id`.**
- **customers**: `tenant_id, name, phone, email, created_at`. **Tenant-scoped, no `restaurant_id`.**

### Other

- **restaurants** (`currency_code`, `timezone`, `tax_rate_bp`), **branches** (`restaurant_id`, `timezone`, `status`).
- **menu_categories**, **menu_items** (+ variants). Order items snapshot names, so analytics should group by `menu_item_id`/`category_id` and display the current name, falling back to the snapshot for deleted items.
- **inventory_movements / items / stock**: already covered by `/reports/inventory`.
- **plans, subscriptions (`active|cancelled`), subscription_invoices (`pending|paid|cancelled`, `amount_minor`, `paid_at`), subscription_events, tenant_usage_counters**: platform-level billing.
- **tables / dining-sessions / payments modules**: `apps/api/src/modules/{tables,dining-sessions,payments}` contain only empty `entities/` and `dto/` folders. **There is no tables table.**

### What can be computed from real data

| Requested metric                                                     | Computable?                             | How / caveat                                                                                                                                                                               |
| -------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Revenue (gross / net / collected)                                    | Yes                                     | See §2.1                                                                                                                                                                                   |
| Total / completed / cancelled orders                                 | Yes                                     | `orders.status`                                                                                                                                                                            |
| Pending / preparing / ready / served                                 | Yes                                     | `kitchen_status` of non-cancelled orders. "Pending" = `kitchen_status IN ('new','accepted')`. These are **current-state** counts, not historical.                                          |
| Average order value                                                  | Yes                                     | net sales ÷ completed orders                                                                                                                                                               |
| Orders by order type                                                 | Yes                                     | `channel`                                                                                                                                                                                  |
| Orders by payment method                                             | Yes, with care                          | An order with split payments has several methods. Report **amount collected by method** (exact) and **orders containing method X** (sums to more than total orders; labelled).             |
| Top / low items, quantity, item revenue, categories                  | Yes                                     | `order_items` where `status='active'`, joined to completed orders. Item revenue = `line_total_minor − discount_minor` (pre-tax).                                                           |
| Total / new / returning customers, repeat rate, avg spend            | Yes, only for orders with `customer_id` | Anonymous orders are excluded and the share of orders with a customer is shown. "New" = customer whose first order **in this restaurant** falls in the period.                             |
| Active tables                                                        | **Only a proxy**                        | No tables entity. We can show "Tables with open dine-in orders" = `count(DISTINCT table_label)` for `status='open' AND channel='dine_in'`. Capacity/occupancy % is not possible.           |
| Branch-wise revenue / orders / AOV                                   | Yes                                     | group by `branch_id`                                                                                                                                                                       |
| Super Admin: restaurants, active subscriptions, growth, distribution | Yes                                     | `tenants`, `restaurants`, `subscriptions ⨝ plans`                                                                                                                                          |
| Super Admin: platform revenue                                        | Yes                                     | Paid `subscription_invoices.amount_minor` by `paid_at`. This is FoodStack's SaaS revenue, **not** restaurants' sales. Summing tenants' sales across the platform is not proposed (see §7). |

### 2.1 Revenue definitions (no double counting)

The billing model stores refunds three ways: `refunds` rows, `payments.refunded_minor`, `orders.refunded_minor`. Only one may be summed per metric.

| Metric                 | Definition                                                                                | Dated by                  |
| ---------------------- | ----------------------------------------------------------------------------------------- | ------------------------- |
| **Gross sales**        | `Σ subtotal_minor` of completed orders (active items, before discounts and tax)           | `completed_at`            |
| Discounts              | `Σ discount_minor`                                                                        | `completed_at`            |
| **Net sales**          | `Σ (subtotal_minor − discount_minor)` (excludes tax)                                      | `completed_at`            |
| Tax                    | `Σ tax_minor`                                                                             | `completed_at`            |
| Billed total           | `Σ total_minor` = net sales + tax                                                         | `completed_at`            |
| **Collected payments** | `Σ payments.amount_minor` (all payments, including partial payments on still-open orders) | `payments.created_at`     |
| Refunds                | `Σ refunds.amount_minor` (from the `refunds` table only)                                  | `refunds.created_at`      |
| **Net collected**      | collected − refunds                                                                       | each by its own timestamp |

Refunds are cash-flow events. They reduce _collected_ in the period they happen and are shown as a separate line against sales. They do not retroactively rewrite past net sales, because a completed order stays `completed` after a refund. "Net sales after refunds" can be shown as net sales − refunds-in-period, clearly labelled.

## 3. Missing analytics endpoints

Proposed new module `apps/api/src/modules/analytics` (the `reports` module stays unchanged):

| Endpoint                   | Permission                      | Returns                                                                                                                                                  |
| -------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /analytics/summary`   | `report:view` per branch        | KPI cards + previous-period comparison, revenue breakdown (§2.1), status counts, channel and method splits. One round trip for the top of the dashboard. |
| `GET /analytics/trend`     | `report:view`                   | Bucketed (hour / day / week / month, chosen from range length) net sales, collected and order counts in local time, with zero-filled buckets.            |
| `GET /analytics/menu`      | `report:view`                   | Top N and bottom N items (bottom only when ≥ N items sold and the range is ≥ 7 days), categories, paged item table.                                      |
| `GET /analytics/customers` | `report:view` + `customer:read` | Totals, new, returning, repeat rate, avg spend, share of identified orders.                                                                              |
| `GET /analytics/branches`  | `report:view` (≥ 2 branches)    | Per-branch revenue, orders, AOV, ranking.                                                                                                                |
| `GET /platform/analytics`  | `platform:dashboard_view`       | Restaurants and tenants growth by month, subscriptions by plan/status, paid invoice revenue by month.                                                    |

Common query (Zod `strictObject`): `preset ∈ {today, yesterday, last7, last30, thisMonth, lastMonth, thisYear, custom}`, `from/to` (YYYY-MM-DD, custom only, ≤ 366 days), `restaurantId?`, `branchId?`, `channel?`, `method?`. The **server** resolves presets to local-date bounds in the restaurant's timezone, so client clocks are never trusted. "Previous equivalent period" = same length immediately before. "Today" is compared with yesterday up to the same local time, so a partial day is not compared with a full one.

The weekly / monthly / yearly revenue tiles are the same `summary` call with different presets. They are not separate endpoints.

## 4. SQL optimization opportunities

1. **One scan per fact table per request.** Compute every KPI with `count(*) FILTER (…)`, `sum(…) FILTER (…)` and `GROUP BY GROUPING SETS ((), (branch_id), (channel))` in a single statement over `orders`. Compute payments and refunds in one CTE each. This avoids one query per card and duplicate aggregation.
2. **Current period + previous period in the same scan**: range `[prevStart, end)`, with `FILTER (WHERE completed_at >= start)` and its complement.
3. **Range predicates on raw `timestamptz`.** Compute local bounds once (`($date)::timestamp AT TIME ZONE tz`, as in `reports.service.ts`) and never wrap the indexed column in a function in `WHERE`. Bucketing (`date_trunc('day', completed_at AT TIME ZONE tz)`) happens only in `SELECT/GROUP BY`.
4. **Menu analytics**: aggregate `order_items` joined to the already range-filtered orders (`orders` driven, nested loop on `order_items_order_idx`), `GROUP BY menu_item_id`. Join `menu_items` only for the final top-N/page rows.
5. **Customers**: compute "first order per customer" with `min(created_at)` over `orders` grouped by `customer_id`, restricted to customers seen in the period (`WHERE customer_id = ANY(period customers)`). Do not scan all history.
6. **No N+1, no history in memory**: the app only receives aggregated rows (bounded by buckets × series, top N, or page size).
7. **Branch timezone vs restaurant timezone**: a multi-branch view uses the **restaurant** timezone. A single-branch view uses the branch timezone (consistent with `/reports/inventory`).
8. **Later, only if benchmarks demand it**: a `daily_branch_sales` rollup (Phase 1 §5). Not proposed now. Indexed aggregation is expected to suffice up to the 1M benchmark; §10 of the plan measures this before any rollup is added.

## 5. Required indexes (new migration `1798000024000-AnalyticsIndexes`)

Existing and reusable: `orders_branch_created_idx (tenant_id, branch_id, created_at DESC)`, `orders_branch_status_created_idx`, `orders_branch_channel_created_idx`, `payments_branch_created_idx (tenant_id, branch_id, created_at)`, `payments_branch_method_created_idx`, `order_items_order_idx (tenant_id, order_id)`, `orders_customer_idx (tenant_id, customer_id) WHERE customer_id IS NOT NULL`.

Gaps:

| Proposed index                                                                                                                                                  | Serves                                   | Why existing ones don't                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orders (tenant_id, branch_id, completed_at) INCLUDE (subtotal_minor, discount_minor, tax_minor, total_minor, channel, customer_id) WHERE status = 'completed'` | all sales KPIs, trend, branch comparison | Sales are dated by `completed_at`, which is not indexed. The partial + INCLUDE index permits index-only scans.                                                                                                |
| `refunds (tenant_id, created_at) INCLUDE (payment_id, amount_minor)`                                                                                            | refunds in period                        | Only `(tenant_id, order_id)` exists. `refunds` has no `branch_id`, so the branch is reached via `payments` (PK lookup). The alternative, adding `branch_id` to `refunds`, needs a data migration (see §9 Q5). |
| `orders (tenant_id, customer_id, created_at) WHERE customer_id IS NOT NULL` (replaces `orders_customer_idx`)                                                    | first-order / returning computation      | The current index lacks `created_at`, so `min(created_at)` needs heap fetches.                                                                                                                                |
| `order_items (tenant_id, order_id) INCLUDE (menu_item_id, category_id, quantity, line_total_minor, discount_minor) WHERE status = 'active'`                     | menu / category analytics                | Avoids heap fetches per item. **Only if** the benchmark shows benefit, because it adds write cost on the hottest insert path.                                                                                 |

All indexes lead with `tenant_id` (RLS convention, `database-conventions.spec.ts`). They are created `CONCURRENTLY` in production (document in the deployment checklist; the migration runner currently wraps migrations in transactions, so this must be verified).

## 6. Redis caching opportunities

Reuse `apps/api/src/shared/cache/CacheService` (shared `REDIS_CLIENT`, version-bump invalidation, single-flight, circuit breaker, PostgreSQL fallback). **No new connection.**

- **Namespace**: add `CacheNs.analytics(tenantId, restaurantId)` → `tenant:{t}:restaurant:{r}:analytics`.
- **Entry**: `{endpoint}:b{sha1(sorted authorised branch ids)}:{from}:{to}:{tz}:{channel|all}:{method|all}[:page]`. The branch set is the **post-authorization** set, so an owner's "all branches" and a manager's single branch never share an entry. Raw query params never enter keys unvalidated (`seg()`).
- **TTL**: new `CACHE_TTL_ANALYTICS_SECONDS` (default 60) for ranges that include today. New `CACHE_TTL_ANALYTICS_CLOSED_SECONDS` (default 900) for ranges that ended before today (local). These change only through refunds and late completions, both of which invalidate.
- **Invalidation**: `cache.invalidateAfterCommit(db, CacheNs.analytics(...))` in `orders.service.ts` on order create, payment, refund, cancel, item void and kitchen status change (the last one affects the pending/preparing counts). Rollback = no invalidation. On a busy branch the namespace churns often. That is acceptable: single-flight bounds concurrent dashboards to one query per instance, and the closed-range entries still benefit. The hit ratio is measured, not assumed.
- **Not cached**: permissions / `AccessService.forRequest` (always read from PostgreSQL in the request transaction), subscription state, the "today vs yesterday so far" live tile if measurements show it is cheap.
- **Platform analytics**: `global:platform-analytics`, 300 s TTL, invalidated on subscription/invoice changes. Platform-audience only.

## 7. Tenant isolation risks

| Risk                                                | Mitigation                                                                                                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Client-supplied `restaurantId` / `branchId`         | Intersect them with `accessibleBranches(access)` filtered by `hasPermission(access, 'report:view', {branchId})`. Any id outside the set → 403 (not "empty"), matching `reports.service.ts`. Branch Managers get exactly their assigned branches.       |
| SQL bypassing RLS                                   | All queries run in `db.run({tenantId, userId})` (RLS `FORCE`d). Branch filter `branch_id = ANY($n::uuid[])` is parameterized. No string-built identifiers.                                                                                             |
| `customers` tenant-wide, not restaurant-wide        | Customer metrics are always derived through `orders` filtered to the authorised branches. They never use `SELECT count(*) FROM customers`, which would count customers of other restaurants in the same tenant and of branches the manager cannot see. |
| Cache key collision across tenants/branch sets      | Namespace contains tenant + restaurant. Entry contains a hash of the authorised branch set. Lookup only after the access check (documented contract of `CacheService`).                                                                                |
| Platform queries run with `platform: true` (no RLS) | `/platform/analytics` only aggregates platform-owned data (tenants, subscriptions, invoices). It does not return per-tenant sales. Guarded by the `platform` audience + `platform:dashboard_view`.                                                     |
| Payment-method filter on order metrics              | Implemented as `EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.method = $m)`. Same tenant through RLS.                                                                                                                                 |
| Information leak through empty vs forbidden         | Forbidden branches return 403 with the same code as the existing reports endpoint.                                                                                                                                                                     |

## 8. Recommended implementation architecture

```
apps/api/src/modules/analytics/
  analytics.module.ts          imports AuthModule, CacheModule (shared)
  analytics.controller.ts      /analytics/* — @RequirePermission('report:view'), Zod query pipe
  analytics.schemas.ts         preset/custom range, filters (strictObject)
  analytics-scope.ts           resolves auth + filters → {branchIds, restaurant, tz, bounds, prevBounds}
  analytics.queries.ts         pure parameterized SQL builders (unit-testable)
  analytics.service.ts         scope → cache.getOrLoad → queries → DTO mapping
  platform-analytics.service.ts  used by platform.controller (new GET /platform/analytics)
apps/api/src/shared/cache/cache.keys.ts   + CacheNs.analytics, CacheEntry.analytics
apps/api/src/modules/orders/orders.service.ts  + invalidateAfterCommit calls (only addition)
apps/api/src/database/migrations/1798000024000-AnalyticsIndexes.ts
apps/web/src/app/restaurant/dashboard/   wire existing cards/charts to /analytics/*, filter toolbar
apps/web/src/app/restaurant/analytics/   detail page (menu, customers, branches tables) if the
                                         dashboard would otherwise exceed ~6 visual blocks
apps/web/src/app/platform/dashboard/     add growth, subscription distribution, SaaS revenue
```

- Charts: extend the existing hand-written SVG `bar-chart.tsx` into line, bar and donut components (no new dependency, per rule 5), with INR `Intl.NumberFormat('en-IN', {style:'currency', currency})` from the restaurant's `currency_code`, `role="img"`, `aria-label` and a visually hidden data table per chart.
- Dashboard (owner/manager): filter toolbar, then 8 KPI cards, then revenue trend + order status, then top items + payment methods, then branch comparison (only with ≥ 2 branches). Category sales, customers and full tables go on a secondary "Analytics" tab to avoid clutter.
- Tests: unit tests for range/timezone resolution and query builders. Integration tests (`apps/api/integration/analytics.int-spec.ts`, real Postgres + Redis, existing helpers) for revenue/refund math, tenant and branch isolation, roles, cache hit/miss/invalidation, Redis-down fallback, empty data and concurrency.
- Benchmarks: `apps/api/perf/phase6-analytics.perf-spec.ts` with a bulk SQL seeder (`generate_series`) for 1k / 10k / 100k / 1M orders, measuring `EXPLAIN (ANALYZE, BUFFERS)` timings and rows, endpoint p50/p95 cached vs uncached, concurrent users, hit ratio (`CacheService.metrics`), and DB CPU from `pg_stat_statements` / container stats where available. Results that cannot be measured in this environment will be reported as not measured, not estimated.

## 9. Decisions needing approval before implementation

1. **Revenue dating**: sales (gross/net) recognised at `completed_at` (fully paid). Collected and refunds dated by their own timestamps. _Recommended._ Alternative: date sales by order `created_at`.
2. **"Active Tables"**: show "Tables with open dine-in orders" (distinct `table_label`). There is no tables module, so occupancy cannot be shown. _Recommended_, or drop the card.
3. **Charts**: extend the existing custom SVG charts (no new dependency). _Recommended._ Alternative: add `recharts`.
4. **Benchmark output path**: the brief says `perf/results/phase6-analytics.md`, but every previous phase uses `apps/api/perf/results/`. _Recommend_ `apps/api/perf/results/phase6-analytics.md` for consistency.
5. **Refund branch lookup**: join `refunds → payments` (no schema change). _Recommended._ Alternative: denormalise `branch_id` onto `refunds` (migration + backfill).
6. **1M-order benchmark** runs against the local Docker Postgres. A full API build crashes the running dev API on :4000 (known issue). Benchmarks will run against a separate test database, and the dev server will be health-checked and restarted afterwards.
