# Phase 3 request cost (measured, before code)

Integration test database, one owner, 15 sequential requests after a warm-up; statements include BEGIN/COMMIT. Latency is end-to-end through the Nest app (supertest).

| Request                                                              | SQL statements | Transactions | Permission look-ups | Look-up time (ms) | Median (ms) | p95 (ms) |
| -------------------------------------------------------------------- | -------------: | -----------: | ------------------: | ----------------: | ----------: | -------: |
| `GET /orders?branchId=01a1a62a-0584-760c-a327-77f364546a2b&limit=25` |             13 |            2 |                   2 |             18.45 |        64.3 |    133.0 |
| `GET /menu`                                                          |             15 |            2 |                   2 |             22.37 |        69.2 |    261.7 |
| `GET /billing/subscription`                                          |             16 |            2 |                   2 |             25.35 |        91.2 |    304.9 |
| `GET /billing/addons`                                                |             17 |            2 |                   2 |             21.58 |        71.9 |    157.8 |
| `GET /billing/entitlement`                                           |             11 |            2 |                   1 |              7.22 |        36.2 |     78.9 |
