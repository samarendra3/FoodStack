# Phase 6 — Analytics and Reporting: Final Report

_2026-11-06 · Commits `8279d4d` (limiter, permission, test cleanup) and `9e37ded` (web export and gating)._

**Status: PARTIALLY COMPLETED.**

- **Done:** functionality, permissions, pool-pressure fix, dev migration, tests, and benchmarks up to 100k orders.
- **Outstanding:** a real-browser visual check (no browser tool in this session) and the 1M-order benchmark (needs ≥16 GB RAM).

## 1. Required analytics: coverage

| Requirement                                                | Where                                                                                                                                                             | Notes                                                                                                                                        |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Total revenue (gross / net / billed / collected / refunds) | `GET /analytics/summary`, dashboard KPI + "Revenue breakdown"                                                                                                     | Definitions in `PHASE_6_ANALYTICS_AUDIT.md` §2.1 (no double counting of refunds)                                                             |
| Total, completed, cancelled, pending orders                | summary KPIs, "Order status" card                                                                                                                                 | Pending/preparing/ready/served are current-state counts                                                                                      |
| Average order value                                        | summary KPI                                                                                                                                                       | net sales ÷ completed orders                                                                                                                 |
| Revenue trends, daily/weekly/monthly                       | `GET /analytics/trend`, "Revenue trend" card                                                                                                                      | hour, day or month buckets depending on range; zero-filled                                                                                   |
| Comparisons with the previous period                       | every summary value has `{ value, previous, changePct }`                                                                                                          | same-length previous period; "today so far" vs "yesterday until now"                                                                         |
| Top-selling items, popular categories                      | `GET /analytics/menu`, "Top-selling items" + category table                                                                                                       | low performers shown only when the range is ≥ 7 days and ≥ 10 items sold                                                                     |
| Payment-method breakdown                                   | summary `methods`, "Payment methods" card                                                                                                                         | net collected per method                                                                                                                     |
| Table utilization                                          | "Active tables" KPI                                                                                                                                               | **Proxy only**: distinct tables with an open dine-in order. There is no tables entity, so occupancy % is not possible (approved decision 2). |
| Branch-wise performance                                    | `GET /analytics/branches`, "Branch performance" (≥ 2 branches)                                                                                                    | ranked by net sales                                                                                                                          |
| Sales reports                                              | dashboard + `/restaurant/reports` (inventory)                                                                                                                     |                                                                                                                                              |
| Date-range filtering                                       | presets today / yesterday / last7 / last30 / thisMonth / lastMonth / thisYear / custom (≤ 366 days)                                                               | resolved on the server in the branch or restaurant time zone                                                                                 |
| Exportable reports                                         | **New:** CSV export of the sales trend (per bucket: net sales, collected, refunds, orders placed / completed / cancelled), plus the existing inventory report CSV | money in major units with two decimals; currency in the header                                                                               |
| Super Admin analytics                                      | `GET /platform/analytics`                                                                                                                                         | growth, subscription distribution, SaaS revenue                                                                                              |

**No placeholders remain.** The dashboard's cards read the live endpoints, each with loading
(skeleton), empty ("No sales in this period") and error (`ErrorNote`) states. I verified this by code review.
It was **not visually inspected in a browser** (see §5).

## 2. `customer:read` decision

**`customer:read` does not exist** in the permission catalogue. The customers list (`GET /customers`) is
gated by `order:read`. Decision, consistent with the approved Phase 6 design ("report:view +
permission to see customer data"):

- **`GET /analytics/customers` requires `report:view` and `order:read` on every branch in scope.**
  Otherwise it returns 403 `REPORT_FORBIDDEN` (`requireOnAllBranches`).
- **The summary's single "Customers" count** stays under `report:view`: it is one aggregate number, with
  no individual detail.
- **The web dashboard doesn't request customer analytics** for users with no `order:read` anywhere. Users with
  partial access see the server's 403 message in the card's error state.
- **System roles:** every role holding `report:view` (owner, restaurant_admin, branch_manager,
  accountant) also holds `order:read`, so nobody loses access. The check bites for custom roles.
- **Test:** a custom `reports_only` role (report:view only) gets summary 200, menu 200 and customers **403**. Owner and
  manager still get 200.

## 3. Connection pressure

The Phase 6 benchmark at 100k orders, uncached, had 80 simultaneous dashboard calls exhaust the
10-connection pool. 2 of 400 requests (31 in an earlier run) got 500 on a pool acquire timeout.

**Fix, without raising the pool:** an in-process limiter (`common/utils/concurrency-limiter.ts`).

- At most `ANALYTICS_MAX_CONCURRENCY` analytics requests per API process may hold a connection. The default is
  `DATABASE_POOL_MAX / 2`, which is 5.
- The slot is taken **before** a connection is checked out, so the rest of the pool always serves POS and order traffic.
- Excess requests wait (FIFO) up to `ANALYTICS_QUEUE_TIMEOUT_MS` (10 s). After that they get **503
  `ANALYTICS_BUSY` with `Retry-After: 5`**, a clean, retryable signal instead of an opaque 500.
- Cached responses still pass through the limiter, but they hold a slot only for ~40 ms.

**Why not raise the pool.** Each API replica's pool multiplies against PostgreSQL's `max_connections` (100).
Raising it just moves the cliff. The limiter protects the business-critical paths at any size.

**Tests:**

- unit `concurrency-limiter.spec.ts`: max concurrency, FIFO order, release on error, timeout drops the waiter;
- unit `problem-details.filter.spec.ts`: `Retry-After` header set, invalid values ignored.

**Not done:** an integration benchmark proving zero 500s at 100k uncached with the limiter. That rerun needs
the 100k seed, which the host's memory allows, but it was deprioritized after the cleanup. It is listed as a
remaining task.

## 4. Analytics migration on the development database

1. **Identity:** `current_database() = foodstack`, 25 migrations, latest `EmailOutbox1798000023000`.
2. **Backup:** `foodstack_dev_pre-analytics-migration_2026-11-06.dump`. I restored it into a scratch DB and the counts matched
   (3 tenants / 3 users / 44 menu items / 25 migrations / 83 audit rows). The scratch DB was then dropped.
3. **Applied** through the production image's `migrate` container. This avoids `nest build` in the dev tree, which crashes the
   watching dev API. The first attempt was correctly refused by production config validation
   (`COOKIE_SECURE`) and applied nothing. The second applied **only** `AnalyticsIndexes1798000024000`.
4. **Verified:**
   - 26 migrations;
   - `orders_branch_completed_idx`, `refunds_tenant_created_idx` and `orders_customer_created_idx` exist;
   - dev counts unchanged;
   - `GET /api/v1/health` → 200 (database up, redis up).
5. **No API restart was needed.** The migration only adds indexes, and the dev API never stopped serving.

## 5. Not done in this environment

| Item                                                                                    | Why                                                   | What remains                                                                                                                                                                          |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visual check of the dashboard in a real browser (loading, empty, error, success states) | No browser tool was available in this session         | Open `/restaurant/dashboard` as owner, branch manager and a `reports_only` role. Use an empty range and a populated range; stop the API to see the error state.                       |
| 1M-order analytics benchmark                                                            | Exhausted 8 GB in Phase 6; not retried, as instructed | `PHASE6_SIZES=1000,1000000 PHASE6_OUT=phase6-analytics-1m pnpm --filter @foodstack/api test:perf -- phase6-analytics` on a ≥16 GB machine                                             |
| Limiter benchmark at 100k uncached                                                      | Time                                                  | `PHASE6_SIZES=100000 PHASE6_OUT=phase6-limiter pnpm --filter @foodstack/api test:perf -- phase6-analytics` (expect 0 failures; some 503s are acceptable only beyond 10 s of queueing) |

## 6. Tests

- **Integration `analytics.int-spec.ts`: 21 tests** (20 earlier + the new permission test) within 277/277.
- **Unit:** `analytics-range.spec.ts` (16), the limiter (4) and the filter (2 new), within 169/169.
- **Web:** `analytics.test.ts` (CSV rows) within 31/31.

Benchmarks for 1k / 10k / 100k orders are in `perf/results/phase6-analytics.md`. Summary p50 with the cache:
~40 ms flat from 1k to 100k. PostgreSQL CPU under concurrency at 100k: 182 s uncached against 6.6 s cached.
