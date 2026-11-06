# FoodStack — Phase 6 Analytics Report

Implements `docs/PHASE_6_ANALYTICS_AUDIT.md` with the six approved decisions:
(1) sales recognised at `completed_at`; payments and refunds dated by their own timestamps,
(2) "Active tables" = tables with an open dine-in order,
(3) charts extend the existing plain-SVG chart (no new dependency),
(4) benchmark results in `apps/api/perf/results/phase6-analytics.md`,
(5) refund → branch through `payments` (no schema change),
(6) benchmarks on the separate `foodstack_test` database; the dev API on :4000 was health-checked
before and after and kept serving.

## 1. What was built

### Backend: `apps/api/src/modules/analytics/`

| File                                             | Role                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `analytics.schemas.ts`                           | Zod `strictObject` filters: `preset` (today, yesterday, last7, last30, thisMonth, lastMonth, thisYear, custom), `from`/`to` (custom only), `restaurantId`, `branchId`, `channel`, `method`; menu adds `sort`, `page`, `pageSize ≤ 100`. Unknown keys → 400.                                                                            |
| `analytics-range.ts`                             | Pure preset → local-date resolution, previous equivalent period, granularity (hour ≤ 2 days, day ≤ 92, else month), 366-day cap.                                                                                                                                                                                                       |
| `analytics-scope.ts`                             | Authorization + scope. Intersects requested ids with branches holding `report:view` (403 otherwise), picks the timezone (one branch: branch tz, else restaurant tz), and computes absolute bounds in SQL (`AT TIME ZONE`). Partial periods (ending today) compare both periods at the same elapsed time. Also builds the cache digest. |
| `analytics.queries.ts`                           | Parameterized aggregation SQL (one statement per fact table; `GROUPING SETS` give overall, per-branch and per-dimension rows in one scan; current + previous period in one index range).                                                                                                                                               |
| `analytics.service.ts`                           | Request flow: RLS transaction → fresh permissions → scope → cache-aside → DTO. The `core` entry (sales, orders, payments, refunds, active tables) is shared by `/summary` and `/branches`.                                                                                                                                             |
| `platform-analytics.service.ts`                  | Super Admin: tenant growth, tenants by status, active subscriptions by plan, paid SaaS invoice revenue by month (platform RLS context; cannot read restaurant sales).                                                                                                                                                                  |
| `analytics.controller.ts`, `analytics.module.ts` | Routes; `AnalyticsModule` registered in `app.module.ts` and imported by `PlatformModule`.                                                                                                                                                                                                                                              |

### Endpoints (all `GET`, under `/api/v1`)

| Endpoint               | Guard                                         | Returns                                                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/analytics/summary`   | `report:view` (+ per-branch check)            | 8 KPI cards with previous period and % change; revenue breakdown (gross, discounts, net, tax, billed, collected, refunds, net collected); order counts by billing and kitchen status; splits by order type and payment method |
| `/analytics/trend`     | same                                          | zero-filled local-time buckets: net sales, completed orders, orders placed, cancelled, collected, refunds                                                                                                                     |
| `/analytics/menu`      | same                                          | top-selling (qty), best-performing (revenue), low-performing (only with ≥ 10 distinct items and ≥ 7 days), unsold available items, categories with share, paged item table                                                    |
| `/analytics/customers` | same                                          | identified customers, new, returning, repeat customers and rate, average spend, share of orders with a customer                                                                                                               |
| `/analytics/branches`  | same                                          | per-branch net sales (with change), orders, AOV, collected, refunds, rank and share                                                                                                                                           |
| `/platform/analytics`  | platform audience + `platform:dashboard_view` | months[12] (new/total tenants, revenue, paid invoices), tenants by status, active subscriptions by plan, lifetime revenue per currency                                                                                        |

Existing endpoints are unchanged; `/reports/inventory` is untouched.

### Definitions (no double counting)

| Figure                                        | Source                                                                                                                                                                   | Dated by              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| Gross sales                                   | Σ `orders.subtotal_minor`, completed orders                                                                                                                              | `completed_at`        |
| Discounts / Tax / Billed                      | Σ `discount_minor` / `tax_minor` / `total_minor`                                                                                                                         | `completed_at`        |
| Net sales = **Total revenue**                 | gross − discounts (pre-tax)                                                                                                                                              | `completed_at`        |
| Average order value                           | net sales ÷ completed orders                                                                                                                                             | `completed_at`        |
| Collected                                     | Σ `payments.amount_minor` (includes part-payments on open orders)                                                                                                        | `payments.created_at` |
| Refunds                                       | Σ `refunds.amount_minor`, **refunds table only**                                                                                                                         | `refunds.created_at`  |
| Net collected                                 | collected − refunds                                                                                                                                                      | each its own          |
| Orders (total / completed / open / cancelled) | orders placed in the period by current status                                                                                                                            | `created_at`          |
| Pending / preparing / ready / served          | current `kitchen_status` of non-cancelled orders placed in the period; pending = new or accepted                                                                         | `created_at`          |
| Item & category revenue                       | Σ (`line_total_minor` − allocated `discount_minor`), active lines of completed orders                                                                                    | order `completed_at`  |
| Customers                                     | distinct `customer_id` on completed orders; anonymous orders never counted; derived from orders at the authorised branches, never from the tenant-wide `customers` table | `completed_at`        |
| New vs returning                              | first non-cancelled order at the authorised branches inside vs before the period                                                                                         | —                     |
| Active tables                                 | `count(DISTINCT lower(table_label))` of open dine-in orders, now (ignores the date range)                                                                                | —                     |

`payments.refunded_minor` and `orders.refunded_minor` are never summed. The integration test
"dates refunds by refund time and never double-counts them" verifies this.

### Database: migration `1798000024000-AnalyticsIndexes`

| Index                                                                                                                                                      | Serves                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `orders_branch_completed_idx (tenant_id, branch_id, completed_at) INCLUDE (subtotal, discount, tax, total, channel, customer_id) WHERE status='completed'` | sales KPIs, trend, branch comparison, customers, item-sales driver             |
| `refunds_tenant_created_idx (tenant_id, created_at) INCLUDE (payment_id, amount_minor)`                                                                    | refunds in period                                                              |
| `orders_customer_created_idx (tenant_id, customer_id, created_at) INCLUDE (branch_id, status) WHERE customer_id IS NOT NULL`                               | first-order lookups; **replaces** `orders_customer_idx` (same leading columns) |

The audit's candidate covering `order_items` index was measured and **not added**. See §4.
Migrations run in a transaction, so production should pre-create these `CONCURRENTLY` with the
same names (`IF NOT EXISTS` makes the migration a no-op afterwards).

### Caching (shared `CacheService`, no new Redis connection)

- Namespace `tenant:{tenantId}:analytics`. It is tenant-wide, not per restaurant as the audit
  sketched, so the single hook in `OrdersService.audit()` (every order write: create, void,
  cancel, payment, refund, kitchen status) can invalidate it from the tenant id with no extra
  query. Invalidation runs **after COMMIT** (`invalidateAfterCommit`), never on rollback.
- Entry `{core|trend|menu|customers}:h{digest}`. The digest is a SHA-256 (32 hex) of restaurant
  id, **authorised** branch set, timezone, resolved current/previous dates, channel and method.
  An owner's "all branches" and a manager's branch never share an entry. Metric labels drop the
  digest (`analytics:core:scope`), so cardinality is bounded.
- TTL: `CACHE_TTL_ANALYTICS_SECONDS` (60) when the range includes today,
  `CACHE_TTL_ANALYTICS_CLOSED_SECONDS` (900) otherwise,
  `CACHE_TTL_PLATFORM_ANALYTICS_SECONDS` (300). Platform analytics is TTL-only: billing writes
  were not modified (rule 13).
- Not cached: permissions (`AccessService.forRequest` runs every request), scope resolution,
  subscription state. Redis failure → PostgreSQL (existing breaker), tested.

### Frontend

- `apps/web/src/lib/analytics.ts`: typed client and `useAnalytics` hook (React Query,
  `keepPreviousData`, 30 s stale time).
- `apps/web/src/app/restaurant/dashboard/charts.tsx`: `LineChart` (crosshair tooltip, keyboard
  focus, "View as table"), `Donut` (≤ 3 parts, values in the legend), `RankedBars`. Colors are
  the validated categorical slots in fixed order with separate light and dark steps. The palette
  validator passed; light slots 3–4 are under 3:1, so every chart prints its values as text.
- `reports/bar-chart.tsx`: one backwards-compatible prop (`ariaLabel`) so it can be reused.
- `restaurant/dashboard/page.tsx`:
  - The placeholder cards are replaced by a filter toolbar (date presets + custom, restaurant
    and branch when there is more than one, order type, payment method) and a line naming the
    range, timezone and comparison period.
  - **Overview** tab: 8 KPI cards with change, revenue/order trend, order status donut +
    kitchen pipeline, revenue breakdown, payment methods and order types, quick actions, branch
    comparison (only with 2+ branches).
  - **Menu & customers** tab: customer tiles, top items, category sales, low/unsold items,
    paged item table.
  - Roles without `report:view` see the team card and a short note instead.
- `platform/dashboard/platform-analytics.tsx`: restaurant growth, active subscriptions by plan,
  subscription revenue. Added above the existing restaurants panel.

## 2. Security decisions

1. Ids from the client are never trusted. Each is checked against `report:view` per branch;
   anything else is 403 `REPORT_FORBIDDEN` (same as `/reports/inventory`).
2. Every query runs inside the caller's RLS transaction and filters by the authorised branch
   array. All values are bound parameters. The only interpolated SQL fragments are fixed
   strings chosen by code.
3. The cache is consulted only after authorization, under a tenant namespace, with a digest of
   the authorised scope. Permissions and subscription state are never cached.
4. Platform analytics reads platform-owned tables only (`tenants`, `subscriptions`, `plans`,
   `subscription_invoices`). The platform RLS context cannot read `orders`, which the test
   asserts indirectly: no tenant sales figure appears in the response.
5. Customer metrics never read the tenant-wide `customers` table, so a manager or
   single-restaurant view cannot count customers of other branches or restaurants.

## 3. Tests

Run on 2026-11-05 against PostgreSQL 18 / Redis 8 (Docker), database `foodstack_test`.

| Suite                                                       | Result                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API unit (`npm test`)                                       | **19 suites, 142 tests passed**, including the new `analytics-range.spec.ts` (16): presets, month and leap-year edges, custom clamps and limits, timezone date, growth %, schema strictness, cache keys                                                                                               |
| Analytics integration (`integration/analytics.int-spec.ts`) | **20 passed** (see list below)                                                                                                                                                                                                                                                                        |
| Full integration suite                                      | **not run** in this session: it shares `foodstack_test` with the benchmark, and the host later ran low on memory. Run `pnpm --filter @foodstack/api test:integration` before merging.                                                                                                                 |
| Type-check                                                  | API `tsc --noEmit` clean; web `tsc --noEmit` clean. `tsc -p integration/tsconfig.json` reports 3 errors in `addons.int-spec.ts` and `plan-management.int-spec.ts`. These are pre-existing, caused by the uncommitted billing changes already in the working tree; Phase 6 does not touch those files. |
| Lint                                                        | eslint clean on all new and changed API and web files                                                                                                                                                                                                                                                 |

Integration coverage: gross/net/tax/billed/collected for a local day with hand-computed
fixtures; refunds dated by refund time and counted once; billing and kitchen status counts;
active tables; IST vs UTC boundaries (00:10 IST orders on both sides of midnight); hourly and
daily zero-filled trend; order-type and payment-method filters; empty periods (zeros and
`null`, never invented); item/category ranking with void lines excluded and pagination;
customers (new, returning, repeat, average spend); branch ranking; Branch Manager limited to
their branch (403 on another); cashier 403; cross-tenant ids 403 and no leakage; filter
validation; every preset; cache hit on repeat and separate entries per branch scope;
invalidation after a committed kitchen-status change on a closed (900 s) range; Redis failure
fallback; 20 concurrent identical requests; platform analytics Super Admin-only.

## 4. Benchmarks

Full tables: `apps/api/perf/results/phase6-analytics.md` (raw: `phase6-analytics.json`).
Machine: 8-core i5-10310U, 8 GiB RAM, PostgreSQL 18 and Redis 8 in Docker, database
`foodstack_test`. Endpoint figures: `preset=last30`, owner, 3 branches.

|    Orders | `/summary` p50 cache off → on | `/menu` p50 off → on | 20 users × 5 dashboards: throughput off → on | PostgreSQL CPU s off → on | Hit ratio | Failed requests (off / on) |
| --------: | ----------------------------: | -------------------: | -------------------------------------------: | ------------------------: | --------: | -------------------------: |
|     1,000 |                    79 → 46 ms |           60 → 44 ms |                     13.9 → 17.6 dashboards/s |                12.3 → 6.3 |     99.2% |                      0 / 0 |
|    10,000 |                   103 → 54 ms |           90 → 51 ms |                                8.7 → 10.1 /s |               31.3 → 10.0 |      100% |                      0 / 0 |
|   100,000 |                   187 → 41 ms |          257 → 37 ms |                                3.4 → 15.4 /s |               182.0 → 6.6 |     99.3% |                  **2 / 0** |
| 1,000,000 |                  not measured |                    — |                                            — |                         — |         — |                          — |

SQL at 100k orders (EXPLAIN ANALYZE as the API role, RLS on), `last30`: sales 26 ms via
`orders_branch_completed_idx`, payments 32 ms, refunds 24 ms via `refunds_tenant_created_idx`,
customers 69 ms, trend 57 ms, orders 162 ms, item sales 260 ms. `thisYear` (most of the table):
PostgreSQL switches to sequential scans, 0.2–0.8 s per statement uncached.

Findings:

- **Cache off under concurrency fails at 100k.** 2 of 400 requests in the final run (31 in an
  earlier run) returned 500 with the logged cause `timeout exceeded when trying to connect`.
  80 simultaneous uncached dashboard calls exhaust the 10-connection pool (5 s acquire timeout).
  With the cache on there were no failures and PostgreSQL CPU dropped 182 s → 6.6 s.
- **Cached latency is flat (~40 ms)** from 1k to 100k orders. What remains is per-request
  authentication, permission loading and scope resolution, which are deliberately not cached.
- **Not measured:** 1M orders and the covering `order_items` index comparison. Attempts failed
  on a bench integer overflow (fixed), then Jest's 30-min timeout (raised), then the host
  stopping the run for low memory (8 GiB). No 1M claims are made.

## 4a. Verification pass (2026-11-05, after review)

| Task                                                                | Status                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type errors in `addons.int-spec.ts` / `plan-management.int-spec.ts` | **Fixed, type-only.** TypeORM 1.1.2 types `DataSource.query` (3rd param `queryRunner`) incompatibly with `QueryRunner.query` (3rd param `useStructuredResult`). The seeds' parameter is now `SqlExecutor { query(sql, params?) }`, the only call they make. No SQL or billing logic changed. `npm run typecheck` (src + integration + test) passes.                                                |
| Migration and indexes                                               | **Verified in `foodstack_test`.** `AnalyticsIndexes1798000024000` is the latest applied migration. `orders_branch_completed_idx`, `refunds_tenant_created_idx` and `orders_customer_created_idx` exist with the intended definitions and `indisvalid = true`. `orders_customer_idx` is removed. `down()` has not been exercised separately.                                                        |
| Cache invalidation review                                           | **Verified by code review.** `OrdersService` has 6 write methods; all 6 call `audit()`, which queues the after-commit invalidation. No other code writes orders, order_items, payments or refunds. Stale-by-TTL only: menu item/category renames and availability (names and the unsold list in `/analytics/menu`, ≤ 60 s for live ranges, ≤ 900 s for closed ranges). Platform analytics ≤ 300 s. |
| Tenant/branch isolation review                                      | **Verified by code review + the 20 analytics integration tests.** The cache is read only after `resolveScope`. The namespace comes from `auth.tenantId`. The digest covers the authorised branch set. Permissions are read fresh on every request, so a revoked role gets 403 immediately even when an entry is cached.                                                                            |
| Role checks (Super Admin, Owner, Branch Manager, Cashier)           | Covered by the analytics integration tests (all passed earlier this session). The re-run inside the full suite is still pending.                                                                                                                                                                                                                                                                   |
| Full integration suite                                              | **Not run.** `foodstack_test` was busy with the bench6 cleanup, and the host ran out of memory.                                                                                                                                                                                                                                                                                                    |
| Bench6 cleanup                                                      | **In progress.** The first attempt rolled back (an orphaned 1M benchmark process was still inserting; it was stopped). The second attempt is still running server-side as one transaction scoped to `bench6-*` tenants and `bench6-*@example.test` users. Its client was stopped for low memory. `bench_orders_number_idx` (bench-only) is dropped by the same script.                             |
| Browser verification                                                | **Not feasible:** no browser tool in this session.                                                                                                                                                                                                                                                                                                                                                 |
| 1M-order benchmark                                                  | **Pending** a machine with more memory; not retried here.                                                                                                                                                                                                                                                                                                                                          |

## 5. Remaining limitations

- **No tables module.** "Active tables" counts distinct open dine-in table labels; there is no
  occupancy % or capacity.
- **Kitchen counts are current state.** Pending/preparing/ready/served describe orders placed in
  the period as they are now, not as they were then (there is no status history table).
- **Order counts vs sales dates.** Order counts use `created_at`; sales use `completed_at`. An
  order placed before midnight and paid after it counts as an order on day 1 and as a sale on
  day 2. This is labelled in the UI.
- **Low performers** are hidden until ≥ 10 distinct items have sold over ≥ 7 days. The "unsold"
  list shows up to 50 items.
- **Multi-branch timezone.** An all-branches view uses the restaurant timezone. Branches in
  other timezones are bucketed on the restaurant's clock.
- **Platform analytics** is cached by TTL only (≤ 5 min stale), uses UTC months, and sums
  revenue per currency.
- **Hit ratio under write load.** Every order write invalidates the tenant's analytics
  namespace. During service the "today" entries are recomputed after each write; the benchmark
  measures the read-only case and the uncached cost, which bounds the write-heavy case.
- **Visual verification.** No browser automation was available in this session, so there are no
  screenshots. The pages type-check and lint. The dev API serves the new routes (401 when
  unauthenticated, not 404). The dev database has **not** been migrated: run
  `pnpm db:migrate` before using the dashboard locally. The endpoints work without the
  indexes, only slower. `db:migrate` runs `nest build`, which stops a running dev API on :4000,
  so restart it and check `/api/v1/health` afterwards.

## 6. Production deployment checklist

1. Pre-create the three indexes `CONCURRENTLY` on large databases (§1), then run migrations
   (`1798000024000`). This also drops the superseded `orders_customer_idx`.
2. Optionally set `CACHE_TTL_ANALYTICS_SECONDS`, `CACHE_TTL_ANALYTICS_CLOSED_SECONDS`,
   `CACHE_TTL_PLATFORM_ANALYTICS_SECONDS` (defaults 60/900/300).
3. Deploy API before web (the web dashboard calls `/analytics/*`).
4. Confirm `report:view` is granted to the intended roles (seeded: owner, restaurant_admin,
   branch_manager, accountant).
5. Watch `GET /platform/cache` for `analytics:*` hit/miss/fallback counts and
   `DATABASE_STATEMENT_TIMEOUT_MS` errors on `/analytics/*` after rollout.
6. Smoke test as an owner (all branches), a branch manager (one branch, 403 on another) and a
   cashier (403).
