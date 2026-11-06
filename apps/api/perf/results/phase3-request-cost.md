# Phase 3 request cost (measured, current code)

Integration test database, one owner, 15 sequential requests after a warm-up; statements include BEGIN/COMMIT. Latency is end-to-end through the Nest app (supertest).

| Request                                                              | SQL statements | Transactions | Permission look-ups | Look-up time (ms) | Median (ms) | p95 (ms) |
| -------------------------------------------------------------------- | -------------: | -----------: | ------------------: | ----------------: | ----------: | -------: |
| `GET /orders?branchId=01a1a699-722e-7c79-a1cc-0c7427ec2fcd&limit=25` |             11 |            2 |                   1 |              8.13 |        44.0 |    136.2 |
| `GET /menu`                                                          |             10 |            2 |                   1 |              7.98 |        40.6 |     51.9 |
| `GET /billing/subscription`                                          |             14 |            2 |                   1 |              7.46 |        50.7 |     57.2 |
| `GET /billing/addons`                                                |             15 |            2 |                   1 |             10.43 |        61.1 |    111.2 |
| `GET /billing/entitlement`                                           |             11 |            2 |                   1 |              6.16 |        35.6 |     39.9 |
| `GET /billing/usage`                                                 |             12 |            2 |                   1 |              7.21 |        39.4 |     71.7 |
