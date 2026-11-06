# Phase 4 cache benchmark — three runs (measured)

Same harness three times in a row (perf/phase4-cache.perf-spec.ts). Latency varies run to run by up to 2× on this laptop; statement and PostgreSQL counts are stable.

---

## Run 1

Machine: Intel(R) Core(TM) i5-10310U CPU @ 1.70GHz, 8 logical CPUs, 8 GiB RAM; PostgreSQL 18 and Redis 8 in Docker on the same host. Requests go through the full Nest app (auth guard, permission look-up, RLS transaction) via supertest over loopback. Data: 224 menu items in 16 categories (75 with portions), 180 stock items. Sequential: 200 requests per endpoint after 20 warm-up. Concurrent: 20 workers × 20 requests, endpoints interleaved. Statements include BEGIN/set_config/COMMIT. Run 2026-11-04T11:41:40.265Z.

### Sequential latency (ms) and SQL statements per request

| Endpoint                                   | DB p50 | DB p95 | DB p99 | Cache p50 | Cache p95 | Cache p99 | Statements DB → cache |
| ------------------------------------------ | -----: | -----: | -----: | --------: | --------: | --------: | --------------------: |
| `GET /menu`                                |   56.4 |   88.3 |  141.0 |      38.6 |      50.9 |      73.6 |           13.0 → 10.0 |
| `GET /menu/categories`                     |   39.3 |   61.2 |  112.1 |      48.3 |     111.8 |     386.4 |           12.0 → 10.0 |
| `GET /inventory/summary?branchId={branch}` |   35.7 |   49.0 |  130.5 |      41.3 |      79.8 |     163.8 |            11.0 → 9.0 |
| `GET /plans`                               |   15.2 |   22.9 |   42.7 |      14.5 |      25.3 |      38.6 |             4.0 → 0.0 |

### Concurrent mixed load (20 workers)

| Mode          | Req/s |   p50 |   p95 |    p99 | Statements/req | PG tuples returned/req | PG tuples fetched/req | PG buffer hits/req |
| ------------- | ----: | ----: | ----: | -----: | -------------: | ---------------------: | --------------------: | -----------------: |
| Database only |  63.4 | 333.4 | 461.8 |  498.5 |           10.0 |                  507.8 |                  68.7 |              103.3 |
| Cache enabled |  41.9 | 508.6 | 929.2 | 1096.9 |            7.3 |                   96.5 |                  55.7 |               67.6 |

### Cache

- Hit ratio over the cache-enabled run (warm-up included): 0.997 (1207 hits, 4 misses, 69 coalesced, 0 fallbacks).
- Redis memory for all cache keys after the run: 110758 bytes in 29 keys (MEMORY USAGE).
- PostgreSQL figures are `pg_stat_database` deltas for the test database divided by requests; they include other activity on that database during the run (none expected).

---

## Run 2

Machine: Intel(R) Core(TM) i5-10310U CPU @ 1.70GHz, 8 logical CPUs, 8 GiB RAM; PostgreSQL 18 and Redis 8 in Docker on the same host. Requests go through the full Nest app (auth guard, permission look-up, RLS transaction) via supertest over loopback. Data: 224 menu items in 16 categories (75 with portions), 180 stock items. Sequential: 200 requests per endpoint after 20 warm-up. Concurrent: 20 workers × 20 requests, endpoints interleaved. Statements include BEGIN/set_config/COMMIT. Run 2026-11-04T11:43:51.646Z.

### Sequential latency (ms) and SQL statements per request

| Endpoint                                   | DB p50 | DB p95 | DB p99 | Cache p50 | Cache p95 | Cache p99 | Statements DB → cache |
| ------------------------------------------ | -----: | -----: | -----: | --------: | --------: | --------: | --------------------: |
| `GET /menu`                                |   64.5 |  112.3 |  131.9 |      79.5 |     217.0 |     482.9 |           13.0 → 10.0 |
| `GET /menu/categories`                     |   36.9 |   57.9 |  105.3 |      42.8 |     161.7 |     624.1 |           12.0 → 10.0 |
| `GET /inventory/summary?branchId={branch}` |   38.6 |   56.9 |   65.9 |      39.4 |      57.6 |      84.9 |            11.0 → 9.0 |
| `GET /plans`                               |   17.1 |   25.8 |   37.8 |      13.5 |      32.2 |      59.3 |             4.0 → 0.0 |

### Concurrent mixed load (20 workers)

| Mode          | Req/s |   p50 |   p95 |   p99 | Statements/req | PG tuples returned/req | PG tuples fetched/req | PG buffer hits/req |
| ------------- | ----: | ----: | ----: | ----: | -------------: | ---------------------: | --------------------: | -----------------: |
| Database only |  49.0 | 404.0 | 702.7 | 741.9 |           10.0 |                  472.3 |                  66.1 |               96.8 |
| Cache enabled |  67.3 | 338.4 | 544.3 | 629.7 |            7.3 |                   93.3 |                  53.3 |               64.6 |

### Cache

- Hit ratio over the cache-enabled run (warm-up included): 0.998 (1201 hits, 3 misses, 76 coalesced, 0 fallbacks).
- Redis memory for all cache keys after the run: 211947 bytes in 31 keys (MEMORY USAGE).
- PostgreSQL figures are `pg_stat_database` deltas for the test database divided by requests; they include other activity on that database during the run (none expected).

---

## Run 3

Machine: Intel(R) Core(TM) i5-10310U CPU @ 1.70GHz, 8 logical CPUs, 8 GiB RAM; PostgreSQL 18 and Redis 8 in Docker on the same host. Requests go through the full Nest app (auth guard, permission look-up, RLS transaction) via supertest over loopback. Data: 224 menu items in 16 categories (75 with portions), 180 stock items. Sequential: 200 requests per endpoint after 20 warm-up. Concurrent: 20 workers × 20 requests, endpoints interleaved. Statements include BEGIN/set_config/COMMIT. Run 2026-11-04T11:45:41.530Z.

### Sequential latency (ms) and SQL statements per request

| Endpoint                                   | DB p50 | DB p95 | DB p99 | Cache p50 | Cache p95 | Cache p99 | Statements DB → cache |
| ------------------------------------------ | -----: | -----: | -----: | --------: | --------: | --------: | --------------------: |
| `GET /menu`                                |   75.7 |  130.2 |  190.9 |      42.4 |      59.0 |      74.0 |           13.0 → 10.0 |
| `GET /menu/categories`                     |   45.1 |   83.1 |  154.7 |      37.0 |      73.8 |     111.1 |           12.0 → 10.0 |
| `GET /inventory/summary?branchId={branch}` |   45.8 |   73.4 |  220.7 |      36.4 |      54.1 |     101.9 |            11.0 → 9.0 |
| `GET /plans`                               |   16.1 |   23.1 |   41.7 |      13.8 |      29.0 |     116.7 |             4.0 → 0.0 |

### Concurrent mixed load (20 workers)

| Mode          | Req/s |   p50 |    p95 |    p99 | Statements/req | PG tuples returned/req | PG tuples fetched/req | PG buffer hits/req |
| ------------- | ----: | ----: | -----: | -----: | -------------: | ---------------------: | --------------------: | -----------------: |
| Database only |  47.1 | 383.7 |  666.8 |  889.6 |           10.0 |                  512.1 |                  70.1 |              106.2 |
| Cache enabled |  36.9 | 456.0 | 1346.5 | 1732.6 |            7.3 |                   94.9 |                  53.9 |               65.5 |

### Cache

- Hit ratio over the cache-enabled run (warm-up included): 0.998 (1216 hits, 3 misses, 61 coalesced, 0 fallbacks).
- Redis memory for all cache keys after the run: 214670 bytes in 32 keys (MEMORY USAGE).
- PostgreSQL figures are `pg_stat_database` deltas for the test database divided by requests; they include other activity on that database during the run (none expected).
