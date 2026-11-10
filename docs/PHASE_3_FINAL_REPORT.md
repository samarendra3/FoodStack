# Phase 3 — Integration and End-to-End Verification: Final Report

_2026-11-06 · branch `feature/central-authentication` · all results below were produced in this session._

**Status: COMPLETED.** The full integration and e2e suites pass on the committed code. The
backup was verified by an actual restore. Only disposable benchmark data was removed, and
dev data is unchanged.

## 1. Database identity

| Database         | Role               | Evidence                                                                                                                                                                                                         |
| ---------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `foodstack_test` | Disposable test DB | Integration setup refuses any name not ending in `_test` (`integration/setup-env.ts`). `.env` points the dev API at `foodstack`. 3.6 GB at start: 20 tenants, of which 10 were `bench6-*` with 1,450,000 orders. |
| `foodstack`      | Development DB     | 12 MB: 3 tenants, 3 users, 44 menu items, 83 audit rows. Not touched by any cleanup.                                                                                                                             |

## 2. Backup and recovery (verified by restore, not just by listing)

All dumps are in `C:\Users\DELL\Documents\FoodStack-backups\`, outside the repository; checksums are in `SHA256SUMS`.

| Dump                                                    | Size    | Verification                                                                                                                                       |
| ------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `foodstack_test_2026-11-06.dump` (`pg_dump -Fc -Z1`)    | 89 MB   | Restored into a scratch DB `foodstack_restorecheck`. Counts matched: 1,450,000 orders, 20 tenants, 26 migrations. The scratch DB was then dropped. |
| `foodstack_dev_2026-11-06.dump`                         | 0.27 MB | `pg_restore --list` shows 44 table-data entries.                                                                                                   |
| `foodstack_dev_pre-analytics-migration_2026-11-06.dump` | 0.27 MB | Restored into the scratch DB. Counts matched (3 / 3 / 44 / 25 migrations / 83 audit rows). The scratch DB was then dropped.                        |

To restore: `docker exec -i foodstack-postgres-1 pg_restore -U foodstack_owner -d <empty db> --no-owner < <dump>`.

## 3. bench6 cleanup (test DB only)

The script refuses to run unless `current_database() = 'foodstack_test'`. Every statement filters on
the ids of tenants whose slug is `bench6-%`.

1. A batched `DELETE` of orders ran at about 5 min per 100k rows. This host has <1 GB free RAM, so
   the delete was I/O-bound. I confirmed that every foreign key into `orders` is indexed.
   One batch (100k) was committed before I stopped it.
2. A read-only check then showed **every** remaining order (1,350,000) belonged to bench6, and
   `order_items`, `payments`, `refunds` and `order_discounts` were empty. A guarded
   `TRUNCATE orders, order_items, order_discounts, payments, refunds` followed. A `DO` block
   raises and aborts if any non-bench6 sales row exists. It finished in 12 s.
3. The following rows were deleted, all scoped to bench6 tenants:

   | Table                   | Rows deleted |
   | ----------------------- | -----------: |
   | `customers`             |      100,000 |
   | `menu_items`            |          200 |
   | `menu_categories`       |           20 |
   | `user_role_assignments` |            2 |
   | `sessions`              |           23 |

4. **Kept on purpose:** 23 bench6 `audit_logs` rows. The table is append-only: the trigger
   `audit_logs_append_only` rejected the `DELETE`, and I did not bypass it. The 10 empty bench6 tenant
   shells also remain, the same way every integration suite leaves its tenants. Result: 0 orders,
   67 MB database.
5. Also removed: 3 orphaned `platform_role_assignments` rows (`admin-*@example.test`, Super Admin
   fixtures of the analytics suite). They were the cause of the `database.int-spec` failure in §4.

**Dev and production data:** not touched. Dev counts were checked before and after every step
(3 tenants, 3 users, 44 menu items, 83 audit rows). There is no production database in this
environment.

## 4. Test runs

| Run                                    | Result                        | Notes                                                                                                               |
| -------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Integration, first run (while editing) | 253 / 254, 2 suites failed    | `addons`: a compile error from my in-progress edit, an artifact. `database`: **a genuine bug**, see below.          |
| **Integration on HEAD `1ecee33`**      | **24 / 24 suites, 277 / 277** | Includes the new `cursor-pagination` (14) and `mfa-attempts` (6) suites. Run 11:40–11:44 with nothing else running. |
| E2E, first run                         | 55 / 56                       | `rls-coverage`: **a genuine guard failure**, see below.                                                             |
| **E2E after fix**                      | **2 / 2 suites, 56 / 56**     | RLS coverage and tenant isolation (`test/database/*`).                                                              |
| Unit (API)                             | **21 / 21 suites, 169 / 169** | After `9671c89`.                                                                                                    |
| Web (vitest)                           | **4 / 4 files, 30 / 30**      |                                                                                                                     |

### Genuine failures found and fixed

1. **`database.int-spec`: "apply, fully revert and re-apply" failed** with an FK violation on
   `platform_role_assignments → roles`.
   - Cause: the Phase 6 analytics suite created a Super Admin assignment and, unlike every other suite,
     never deleted it.
   - Fix: its `afterAll` now removes it (`8279d4d`).
   - This went unnoticed because the full suite was never run after Phase 6.
2. **`rls-coverage.e2e-spec`: `plans` and `addon_packages` had no RLS and were not allow-listed.**
   - Both are platform-wide catalogues without `tenant_id`, the same category as `permissions`.
     Writes go through Super Admin endpoints only.
   - The guard's documented rule is "add RLS or deliberately allow-list". They were allow-listed with a
     stated reason (`2439006`). The check itself was not weakened.
   - It had been failing since `2e019af`, because e2e was not being run.
3. **Unit `paged.spec` failed after the Phase 7 commit.** The new `pagination: 'offset'` default was
   missing from the expected defaults. I corrected the expectation and added cursor tests (`9671c89`).
   This failure was mine: I hadn't re-run unit tests after that commit.

## 5. What the suites verify

The 277 integration tests and 56 e2e tests cover:

- **Authentication:** password, lockout, rate limits, sessions and refresh rotation, TOTP enrolment and
  replay protection, recovery codes, and the new MFA counter atomicity tests.
- **Isolation:** restaurant and branch isolation (lists, analytics, cursor pagination, reports, inventory), and
  RLS on every tenant table with a forced policy.
- **Permissions:** permissions per role and the custom role `reports_only`.
- **Business flows:** orders (creation, idempotency, voids, payments, refunds, limits), billing, subscriptions,
  add-ons and plan management.
- **Infrastructure:** email outbox and worker contracts, and the Redis cache and failure fallback.

## 6. Observations

- **`request-cost.int-spec` latency.** It regenerates `perf/results/phase3-request-cost.md`.
  - Statement counts were identical to the committed baseline. Those counts are what the test guards.
  - Latency was 1.5–5× higher, because that run overlapped the bench6 cleanup on a memory-starved
    host. I restored the committed file rather than committing a contaminated baseline.
- **Deprecation warning in test output:** `pg` warns "client.query() when the client is already
  executing a query", which will be removed in pg@9. Some code path issues overlapping queries on one
  client. It is harmless today but must be fixed before upgrading to pg 9 (see the final report).
