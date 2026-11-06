# FoodStack — Phase 2 Performance Report

_Phase 2 of `docs/PERFORMANCE_AUDIT.md`: order-limit counter (F1), bulk order writes (F3),
index-friendly date filters (F4), Super Admin list (F7) and explicit list columns (F10)._

Architecture is unchanged: hand-written parameterised SQL through `DbContext`, with TypeORM used
only for pooling and migrations. No entities were introduced.

---

## 1. Measured results

**Method.** `pnpm --filter @foodstack/api test:perf` (`apps/api/perf/phase2-plans.perf-spec.ts`).

- **Data:** it seeds the `foodstack_test` database (never a real one; the test setup refuses any other database name) with one restaurant and one branch: **200,000 orders over 30 days**, 3 % cancelled.
- **Execution:** each query runs as the **app role under row-level security**, exactly as requests run it, with `EXPLAIN (ANALYZE, BUFFERS)`. Each is run 5 times and the median reported, warm cache.
- **Hardware:** a developer laptop with PostgreSQL 18.6 in Docker. Absolute numbers will differ on production hardware; the ratios and buffer counts are what matter.
- Full plans are written to `apps/api/perf/results/phase2-plans.md`.

| Query                                                   |                    Before (median) |                   After (median) | Pages read (shared buffers) |
| ------------------------------------------------------- | ---------------------------------: | -------------------------------: | --------------------------- |
| F1 — order-limit check, run on **every order creation** | 372.6 ms (run 1), 270.3 ms (run 2) | 0.35 ms (run 1), 0.58 ms (run 2) | 6,434 → 9                   |
| F4 — orders page for one local day (25 rows)            |                           251.1 ms |                          16.9 ms | 6,466 → 243                 |
| F4 — the same page's total count                        |                           244.8 ms |                          13.9 ms | —                           |

What each "after" plan shows:

- **F1 after:** one `INSERT … ON CONFLICT DO UPDATE` on the counter row (`Conflict Arbiter Indexes: tenant_usage_counters_pkey`). It no longer depends on how many orders the restaurant has.
- **F4 before:** `Parallel Seq Scan on orders`. Every one of the 200,000 rows was read, and about 64,000 per worker discarded by the day filter.
- **F4 after:** the day bounds are computed once (`InitPlan`) and used as index range keys on `(tenant_id, branch_id, created_at)`.

**Not benchmarked** (no measurements, so no numbers claimed):

- **F3:** bulk line and discount inserts. The saving is round trips: a 10-line order with 2 offers goes from 12 insert statements to 2. That depends on network latency, which a local benchmark wouldn't represent.
- **F7:** the single owner look-up in the Super Admin list.
- **F10:** explicit list columns.

---

## 2. What changed

### F1 — monthly order limit

**Before** (ran inside a per-tenant advisory lock on every order creation, together with three other counts that were not needed):

```sql
SELECT (SELECT count(*) FROM branches WHERE status = 'active') AS branches,
       (SELECT count(*) FROM tenant_memberships WHERE status IN ('active', 'invited')) AS staff,
       (SELECT count(*) FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
         WHERE o.status <> 'cancelled'
           AND o.created_at >= date_trunc('month', now() AT TIME ZONE r.timezone) AT TIME ZONE r.timezone) AS orders,
       (SELECT count(*) FROM menu_items WHERE deleted_at IS NULL) AS menu_items
```

**After.** One atomic statement reserves the slot (`$4` is the plan + add-on limit; `NULL` = unlimited, which is still counted so usage can be shown):

```sql
INSERT INTO tenant_usage_counters AS c (tenant_id, period, orders)
SELECT $1, date_trunc('month', now() AT TIME ZONE r.timezone)::date, $3
  FROM branches b JOIN restaurants r ON r.id = b.restaurant_id WHERE b.id = $2
ON CONFLICT (tenant_id, period) DO UPDATE
  SET orders = c.orders + EXCLUDED.orders, updated_at = now()
  WHERE $4::int IS NULL OR c.orders + EXCLUDED.orders <= $4::int
RETURNING c.orders
```

How it behaves:

- **No row returned** means the limit is reached; the request returns 403 `ORDER_LIMIT_REACHED`, as before.
- **Concurrency:** the counter row's lock serializes concurrent creations for the restaurant, until its transaction commits or rolls back.
- **Failed orders:** if the order fails after the reservation (an invalid coupon, a database error), the transaction rolls the slot back.
- **Cancellation:** cancelling an order runs `releaseOrderSlot()`, which decrements the counter of the month **the order was created in**, never below 0.
- **Months:** they follow the order's restaurant time zone, as the previous count did.
- **Other limits:** staff, branches and menu items keep the advisory-lock check, but each now counts **only its own resource**.

### F3 — order creation writes

**Before:** one `INSERT INTO order_items … VALUES (…)` per line, one `INSERT INTO order_discounts` per offer, and one `UPDATE order_items` per line when re-pricing.

**After:** one statement each. Line order is preserved (details sort by `created_at, id`, and ids are uuidv7, monotonic within the session):

```sql
INSERT INTO order_items (tenant_id, order_id, menu_item_id, …, note)
SELECT $1, $2, l.menu_item_id, …, l.note
  FROM unnest($3::uuid[], $4::uuid[], $5::uuid[], $6::text[], $7::text[], $8::bigint[],
              $9::int[], $10::bigint[], $11::bigint[], $12::text[])
       WITH ORDINALITY AS l(menu_item_id, variant_id, category_id, name, variant_name,
                            unit_price_minor, quantity, line_total_minor, discount_minor, note, n)
 ORDER BY l.n
-- re-pricing:
UPDATE order_items i SET discount_minor = u.discount_minor
  FROM unnest($1::uuid[], $2::bigint[]) AS u(id, discount_minor) WHERE i.id = u.id
```

**Retries.** Concurrent retries of one request (same `Idempotency-Key`) now take a transaction-level advisory lock on the key before the duplicate check. The second retry waits, then returns the first order. Previously the two raced to the unique index and the second failed with an error.

**Unchanged.** Pricing, tax, totals and the order's check constraints (including `total = subtotal − discount + tax`) are all still enforced in the same transaction. Inventory is not touched by order creation in the current code.

### F4 — local-day date filters (orders, payments, inventory movements)

**Before:** every row's timestamp was converted before comparing, so no index could be used:

```sql
(o.created_at AT TIME ZONE b.timezone)::date >= $2::date
AND (o.created_at AT TIME ZONE b.timezone)::date <= $3::date
```

A first rewrite compared raw `created_at` with bounds computed from `b.timezone`. It measured **no gain** (238.9 → 222.5 ms), because a bound taken from a joined row is a join filter, and PostgreSQL still scanned every order. The final form adds a bound that is constant for the whole query:

```sql
o.created_at >= ($2::date::timestamp AT TIME ZONE b.timezone)            -- exact, per branch
AND o.created_at >= (SELECT min($2::date::timestamp AT TIME ZONE tz.timezone)
                       FROM branches tz WHERE tz.id = ANY($1::uuid[]))  -- index range key
AND o.created_at < (($3::date + 1)::timestamp AT TIME ZONE b.timezone)
AND o.created_at < (SELECT max(($3::date + 1)::timestamp AT TIME ZONE tz.timezone)
                      FROM branches tz WHERE tz.id = ANY($1::uuid[]))
```

- **Correctness:** the exact per-branch condition keeps results right for restaurants whose branches are in different time zones.
- **Speed:** the uncorrelated sub-select is evaluated once and serves the index range.
- **Shared code:** both helpers are `dayFrom()` / `dayTo()` in `orders.service.ts`, also used by the inventory movements list.

### F7 — Super Admin subscriptions and invoices lists

**Before:** two correlated sub-selects per row fetched the same owner (one for the name, one for the email). The page count ran every per-row look-up too, because it reused the full `FROM` clause.

**After:**

- **One owner look-up per row** (`LEFT JOIN LATERAL … ow`) supplies both name and email.
- **Count without display look-ups:** `runPaged()` gained an optional `countFrom` without them. The latest-invoice join is kept in the count only when a filter uses it (payment status, search).

### F10 — explicit columns

- **Orders list:** selects only the 21 columns its response uses (`LIST_COLUMNS`) instead of `o.*`. The ones no longer read are `tenant_id`, `restaurant_id`, `customer_id`, `client_request_id`, `updated_at`, `kitchen_updated_at`, `created_by`, `updated_by` and `version`.
- **API responses** are unchanged.
- **Single-row `SELECT *` by primary key** was left as is: audit §2, F10.

---

## 3. Migration

`1798000021000-OrderUsageCounters` (transactional; reversible with `down()`). It runs four steps:

1. **Creates the table** `tenant_usage_counters (tenant_id, period date, orders int, updated_at)`:
   - primary key `(tenant_id, period)`;
   - checks that `period` is the first day of a month and `orders >= 0`;
   - `ON DELETE CASCADE` from tenants.
2. **Row-level security:** `ENABLE` + `FORCE`, with the standard `tenant_isolation` policy plus `platform_access`.
3. **Backfill:** counts existing non-cancelled orders per tenant and restaurant-local month, under the platform scope, so current usage is preserved. Applied to the dev database: counters match the existing orders.
4. **No new indexes.** The audit's proposed partial `orders (tenant_id, created_at)` index is not needed: the counter replaced the count it would have served. Nothing was dropped.

Not run with `CONCURRENTLY`: the migration creates and fills a new table and touches no existing index on a large table.

---

## 4. Tests

| Suite                                           | Result                                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| API unit (Jest)                                 | 126 / 126                                                                         |
| API integration (Jest, real PostgreSQL + Redis) | **186 / 186**, including the new `integration/order-limits.int-spec.ts` (8 tests) |
| Plan capture (`test:perf`)                      | passes; asserts the new forms are faster                                          |
| API lint and typecheck                          | clean                                                                             |

### Concurrency results (from `order-limits.int-spec.ts`, actual runs)

| Scenario                                                            | Result                                                                                                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 12 simultaneous orders against a limit of 5 (two users, one branch) | Exactly **5 created**, **7 refused** with `ORDER_LIMIT_REACHED`; counter = 5 = non-cancelled orders                                 |
| Order that fails after reserving (invalid coupon)                   | Counter unchanged (slot rolled back)                                                                                                |
| Cancel one order at the limit                                       | Counter 5 → 4; one more order allowed, the next refused; counter = live orders                                                      |
| 5 simultaneous retries with one `Idempotency-Key`                   | All succeed with the **same order id**; counter +1                                                                                  |
| Unlimited plan                                                      | Orders still counted (counter = live orders)                                                                                        |
| Tenant isolation                                                    | The other restaurant's counter, order list total and branch filter never include this restaurant's data (other branch id → refused) |
| Branch isolation                                                    | A branch-scoped cashier lists only their branch; asking for another branch → 403                                                    |
| Bulk insert                                                         | Lines stored in cart order (notes and quantities), subtotal and coupon discount correct, one discount row                           |
| Date filter across the time-zone boundary                           | 19:00 UTC on 3 Nov (00:30 on 4 Nov in Asia/Kolkata) appears under 4 Nov, not 3 Nov; 18:29:59 UTC stays on 3 Nov                     |

---

## 5. Remaining issues (later phases)

- **F2:** permissions computed twice per request (guard and service). Phase 3.
- **F5:** offset pagination plus an exact count on large lists. Keyset pagination is a separately reviewed task, per your instruction.
- **F6:** the usage banner calls the full add-ons endpoint on every Restaurant Admin page view. Phase 3/4.
- **F8:** `ILIKE '%term%'` search. Trigram indexes only once measurements on large tenants justify them.
- **Month boundary for display:** the counter's month follows each order's restaurant time zone; the usage display reads the month of the restaurant account's first restaurant. They differ only for a multi-restaurant account whose restaurants are in different time zones, and only in the hours around midnight at a month boundary.
- **Benchmark scale:** only the 200k-order data set was run. The 1M and 10M sets (`PERF_ORDERS=1000000 pnpm test:perf`) have not been run.

## 6. Files changed

**API, new:**

- `src/database/migrations/1798000021000-OrderUsageCounters.ts`
- `integration/order-limits.int-spec.ts`
- `perf/jest.config.json`, `perf/phase2-plans.perf-spec.ts`

**API, modified:**

- `src/database/migration-list.ts`
- `src/modules/billing/subscription-lifecycle.service.ts`: counter reservation and release; per-kind usage
- `src/modules/orders/orders.service.ts`: retry lock, reservation, bulk writes, release on cancel, date filters, list columns
- `src/modules/inventory/inventory.service.ts`: date filter
- `src/modules/billing/platform-billing.service.ts`: owner join, `countFrom`
- `src/common/pagination/paged.ts`: optional `countFrom`
- `package.json`: `test:perf` script

**Docs:** `docs/PERFORMANCE_AUDIT.md` (status updated), this report.
