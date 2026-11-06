# FoodStack — Final Execution Plan (Phase 0)

_Date: 2026-11-06 · Branch `feature/central-authentication` @ `2bf71dc` · Source audit: `docs/FOODSTACK_COMPLETE_PHASE_AUDIT.md`_

## Environment (verified)

| Item    | Value                                                                                                                                                                                                                                                                  |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host    | Windows 11, i5-10310U (8 threads), **7.7 GB RAM, ~0.8 GB free** at start. Disk: 104 GB free.                                                                                                                                                                           |
| Docker  | 29.9.2. Running: `postgres:18-alpine`, `redis:8-alpine` (`noeviction`, password), `mailpit`. `api`, `worker`, `migrate` and the web services are defined in `docker-compose.yml` but not running.                                                                      |
| Dev DB  | `foodstack` (12 MB, 3 tenants, 0 orders). 25 migrations applied; **`AnalyticsIndexes1798000024000` is missing**. Dev API on :4000 is healthy.                                                                                                                          |
| Test DB | `foodstack_test` (3.6 GB). Contains **10 `bench6-*` tenants / 1,450,000 orders** left over from Phase 6, plus integration fixtures. Integration setup refuses any DB name that does not end in `_test`.                                                                |
| Tools   | Missing on the host: `k6`, `pg_dump`, `gh`. Use `pg_dump` inside the Postgres container and k6 from the `grafana/k6` Docker image. CI status can't be checked without `gh`; `.github/workflows/ci.yml` runs format, lint, typecheck, unit, build, integration and e2e. |
| Git     | Clean, apart from the new audit docs. Commit locally only, no push.                                                                                                                                                                                                    |

## Phase status at start

| Phase               | Status  | Outstanding                                                                                      |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| 2 DB optimization   | Partial | 1M/10M benchmarks (need ≥16 GB RAM); trigram decision; integration re-run                        |
| 3 Integration/E2E   | Partial | Back up `foodstack_test`, clean bench6, full integration and e2e run, fix failures               |
| 4 Cache / MFA       | Partial | Throughput regression analysis; atomic MFA counter and tests                                     |
| 5 Worker            | Partial | Container build, compose start, smoke test (jobs, retry, shutdown, health)                       |
| 6 Analytics         | Partial | `customer:read` decision; pool pressure; dev migration after backup; browser check; 1M benchmark |
| 7 Cursor pagination | Pending | Everything (API, web, tests)                                                                     |
| 8 Load testing      | Pending | k6 scripts, targets, normal/spike/soak runs; 1M/10M runs need a bigger machine                   |

## Risks and dependencies

- **Memory.** 8 GB total and <1 GB free. Concurrent Docker image builds, a 1M seed and long soak tests can exhaust the host (this already happened in Phase 6). Mitigations:
  - Run one heavy job at a time.
  - Do not attempt 1M/10M here.
  - Keep soak tests short and low-VU, and label them as such.
- **Dev API restarts.** A full build crashes the dev API on :4000. Health-check it and restart after each build.
- **Destructive operations.** Restricted to `foodstack_test`, after a verified `pg_dump`, and scoped to `bench6-*` tenant ids. Before migrating, the dev DB gets a verified `pg_dump`. No data is deleted from it.

## Execution order

1. Phase 3 first: back up and clean the test DB, then run the full integration and e2e suites. Every later phase depends on a green baseline.
2. Phase 4: MFA fix and tests; throughput analysis.
3. Phase 6: permission decision, pool/concurrency fix, dev DB backup and migration, API restart.
4. Phase 7: cursor pagination (API, then web, then tests).
5. Phase 5: worker container build and smoke test.
6. Phase 8: k6 scripts in `tests/load/k6`, runs at the scale this host allows.
7. Phase 2: trigram evaluation and a pool/config review; 1M/10M instructions for a larger machine.
8. Final audit and `FINAL_PHASE_COMPLETION_REPORT.md`.

Each phase gets its own commit or commits and its own `docs/PHASE_N_FINAL_REPORT.md`.
