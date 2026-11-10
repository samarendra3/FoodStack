# Phase 2 — Database and Performance Optimization: Final Report

_2026-11-06 · Host: i5-10310U (8 threads), 7.7 GB RAM, about 0.8 GB free. PostgreSQL 18 and Redis 8 run in Docker on the same machine._

**Status: PARTIALLY COMPLETED (BLOCKED for the 1M/10M part).**

**Done here:**

- The Phase 2 optimizations (F1, F3, F4, F7, F10) are verified by the green integration suite.
- The trigram evaluation was measured and a decision made.
- The pool and DB configuration was reviewed.

**Not run, needs a ≥16 GB machine:**

- the 1M and 10M order benchmarks, which exhausted memory on this host in Phase 6. I did not retry them, as instructed.

The exact commands are in §5.

## 1. Existing optimizations re-verified

The optimizations themselves are documented in `PHASE_2_PERFORMANCE_REPORT.md` and measured at 200k orders in `perf/results/phase2-plans.md`. In this session they were re-verified by the integration suites:

- `order-limits`, `orders`, `lists`, `database` and `request-cost` are part of the **277/277** run on HEAD;
- `database-conventions.spec.ts` (unit) passes.

## 2. Trigram search (pg_trgm): measured, **not adopted as-is**

**Where search happens.** Every list search is `ILIKE '%term%'`:

- orders: customer phone, customer name, table label;
- payments: reference;
- customers: phone, name;
- stock: item name, category, note;
- billing and admin lists.

`pg_trgm` is already installed (migration `1798000000000-InitExtensions`), so this is about indexes, not the extension.

**Method.** `apps/api/perf/phase2-trigram.sql` runs inside one transaction that is **rolled back**:

- one tenant with 200,000 customers and 300,000 orders;
- queries run **as `foodstack_app` with RLS forced**, the same path the API uses;
- the same queries are re-run after building GIN trigram indexes on `customers(name)` and `customers(phone)`.

| Query (200k customers / 300k orders, one tenant) |             Without index |                With trigram indexes |
| ------------------------------------------------ | ------------------------: | ----------------------------------: |
| Customer search, digits `%4471%`                 | 485 ms, parallel seq scan |          501 ms, **still seq scan** |
| Customer search, name `%reddy 77%`               |          580 ms, seq scan |          615 ms, **still seq scan** |
| Order search, last 30 days (43k rows in range)   |                    484 ms |                          not re-run |
| Order search, all time (103k rows)               |                    812 ms |    538 ms (warmer cache, same plan) |
| Build cost                                       |                         — | name index 2.8 s, phone index 1.4 s |

**Root cause (verified):**

|                                                                   |                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------ |
| **Same search as the table owner (RLS bypassed), 100k customers** | Bitmap index scans on both trigram indexes, **3.2 ms** |
| **Same search as the app role (RLS forced)**                      | Sequential scan, **97 ms**                             |
| `pg_proc.proleakproof`                                            | `texticlike` (ILIKE) = **false**; `texteq` (=) = true  |

Under forced RLS, PostgreSQL applies the policy (`tenant_id = current_setting(...)`) first. A query condition built on a **non-leakproof** operator may not be evaluated ahead of it, so it can't drive an index scan. ILIKE is not leakproof, so trigram indexes are **unusable by the API as written**. They would only add write cost and disk space.

**Decision: don't add trigram indexes now.** Making them effective requires one of:

1. **`ALTER FUNCTION texticlike(...) LEAKPROOF`.** This needs a superuser. It is only safe if the function can never leak row data through errors or timing, and that is a security sign-off, not a performance change.
2. **A narrow `SECURITY DEFINER` search function.** It would take the tenant id explicitly and filter on it, and return ids only. The main query would then join under RLS. This moves part of the isolation from RLS into code, so it also needs security review.

Either option can bring searches from hundreds of ms to a few ms at this size. **This needs your approval** (see the final report).

**Works under RLS today, no index change:**

- Exact-match lookups use leakproof `=`. For example, a phone lookup is 24 ms at 100k without a dedicated index.
- Keeping searches date-bounded: the orders search over 30 days reads 43k rows, against 103k for all time.

## 3. Connection pooling and database configuration (reviewed)

| Setting                                                           | Value                                                      | Assessment                                                                                                                                                                           |
| ----------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_POOL_MAX`                                               | 10 per API process                                         | Fine for one process. With N replicas the total is N × 10 + workers. PostgreSQL `max_connections` = 100, so put PgBouncer (transaction mode) in front beyond ~6 replicas.            |
| `connectionTimeoutMillis`                                         | 5 s                                                        | Callers fail after 5 s instead of hanging. Analytics are now bounded by `ANALYTICS_MAX_CONCURRENCY` (pool/2) so they can't take every connection (Phase 6).                          |
| `idleTimeoutMillis`                                               | 30 s                                                       | OK                                                                                                                                                                                   |
| `statement_timeout`                                               | 15 s                                                       | OK as a safety net. The heaviest uncached analytics at 100k were 0.2–0.8 s.                                                                                                          |
| PostgreSQL `shared_buffers` / `work_mem` / `effective_cache_size` | 128 MB / 4 MB / 4 GB                                       | Docker defaults. For production, set `shared_buffers` to ~25 % of RAM, `work_mem` to 16–32 MB (analytics sorts) and `effective_cache_size` to ~70 % of RAM. Tune at the 1M/10M runs. |
| Load test (Phase 8)                                               | 150 VUs: 9 of 10 pool connections active at peak, 0 errors | The pool is not the first limit; a single Node process saturating one core is.                                                                                                       |

## 4. Slow queries identified

| Query                                              | Measured                                   | Status                                                                                      |
| -------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Uncached analytics under concurrency (100k orders) | Pool exhaustion → 500s (Phase 6 benchmark) | **Fixed**: concurrency limiter + 503/Retry-After (`8279d4d`)                                |
| `ILIKE` searches at 200k+ rows per tenant          | 0.5–0.8 s (§2)                             | Needs a security decision (§2)                                                              |
| `thisYear` analytics (most of the table)           | 0.2–0.8 s per statement at 100k, seq scans | Cached (900 s for closed ranges). A daily rollup is the next step if 1M shows it is needed. |
| Deep offset pages + exact `count(*)`               | O(rows)                                    | **Fixed** for the four large lists: cursor pagination (Phase 7)                             |

## 5. 1M / 10M benchmarks: exact steps for a ≥16 GB machine

**Not executed here, and no results are claimed.**

```bash
# On a machine with >= 16 GB RAM, Docker, and this repository at the current branch:
pnpm install && pnpm docker:up
# PostgreSQL sized for the run (docker-compose override), e.g.:
#   command: postgres -c shared_buffers=4GB -c work_mem=32MB -c effective_cache_size=10GB -c max_wal_size=8GB
pnpm --filter @foodstack/api migration:run            # dev schema; tests create their own

# Phase 2 plans (EXPLAIN ANALYZE of F1/F4 queries, insert throughput) at 1M then 10M:
PERF_ORDERS=1000000  pnpm --filter @foodstack/api test:perf -- phase2-plans
PERF_ORDERS=10000000 pnpm --filter @foodstack/api test:perf -- phase2-plans
# Phase 6 analytics: 1M only (1k/10k/100k results already exist). Note: without PHASE6_SIZES the
# spec defaults to 1k,10k,100k,1M — never run it that way on an 8 GB machine.
PHASE6_SIZES=1000,1000000 PHASE6_OUT=phase6-analytics-1m pnpm --filter @foodstack/api test:perf -- phase6-analytics
# Trigram evaluation at scale (rolled back, test DB only):
docker exec -i foodstack-postgres-1 psql -U foodstack_owner -d foodstack_test \
  -v customers=2000000 -v orders=10000000 < apps/api/perf/phase2-trigram.sql
# Load tests on a large dataset: see tests/load/k6/README.md (LOAD_ORDERS=1000000 / 10000000).
```

To record: insert throughput, list and filter p50/p95, EXPLAIN plans, CPU and memory (`tests/load/monitor.sh`).
Results go in `apps/api/perf/results/` and update this report.

## 6. Follow-up: search alternatives that keep RLS intact (decision 1)

**Decision.** Trigram indexes stay disabled if making them usable weakens RLS. So these options are **rejected**:

- `ALTER FUNCTION texticlike LEAKPROOF`;
- a `SECURITY DEFINER` search path.

**Constraint, verified.** Under forced RLS only **leakproof** operators can drive an index ahead of the
policy. Checked in `pg_proc`:

| Operator               | Leakproof |
| ---------------------- | --------- |
| `texteq` (`=`)         | **yes**   |
| `texticlike` (ILIKE)   | no        |
| `arraycontains` (`@>`) | no        |
| `arrayoverlap` (`&&`)  | no        |
| `show_trgm`            | no        |

So an array-GIN trigram design doesn't help either. Only equality lookups can use an index for the app role.

**Prototype: a gram table, where RLS remains the only isolation mechanism.**

- `customer_search_grams(tenant_id, gram, customer_id)` holds the lowercase 3-character windows of name and phone.
- RLS is FORCED on it with the same tenant policy, plus a B-tree on `(tenant_id, gram, customer_id)`.
- A search is `gram = ANY($grams)` grouped by customer, keeping those with `count(DISTINCT gram) = n`. The candidates are then re-checked with `ILIKE` for exactness.

It was measured inside a rolled-back transaction as `foodstack_app`, with 200,000 customers in one tenant:

| Search                              | Seq-scan ILIKE (today) |                                                                  Gram table |
| ----------------------------------- | ---------------------: | --------------------------------------------------------------------------: |
| Digits `4471`                       |                 313 ms |    **75 ms** (index-only scan; the RLS predicate is in the index condition) |
| Name `reddy 77` (common grams)      |                 313 ms |                                         289 ms (82k gram hits to aggregate) |
| Other tenant reading the gram table |                      — |                                                      **0 rows** (RLS works) |
| Build                               |                      — | 36 s to fill + 22 s to index for 200k customers; about 30 rows per customer |

**Conclusion.** The design is safe and helps selective (digit) searches 4×. It doesn't help common name
fragments, and it costs about 30 index rows per customer write. It is **not adopted**.

**Recommended next step (cheap, RLS-safe):** a stored column such as `phone_last4` with a
`(tenant_id, phone_last4)` B-tree. Search would use it when the term is exactly 4 digits: an equality lookup,
leakproof, expected around 1 ms (an estimate, not measured). Customer search would stay seq-scan for free text. Measure at 2M customers on the ≥16 GB machine
(`tests/load/large-dataset/run.sh trigram`) before deciding.
