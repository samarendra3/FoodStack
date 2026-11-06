# Phase 8 — Load Testing and Scalability: Final Report

_2026-11-06 · k6 1.4.2 (Docker) against the production API image, worker running, `foodstack_load` database._

**Status: PARTIALLY COMPLETED.**

- **Executed here:** scenarios A (normal), B (spike) and C (soak), plus a 150-VU stress run.
- **Blocked:** D (1M / 10M orders) needs a ≥16 GB machine. Multi-replica scaling has not been tested.

## 1. Setup

- **Scripts:** `tests/load/k6/` (`normal.js`, `spike.js`, `soak.js`, `lib/api.js`). Seed: `apps/api/scripts/seed-load.mjs` (refuses any DB name that doesn't end in `_load`). Sampler: `tests/load/monitor.sh` (container CPU and memory, PG connections, Redis memory, queue depth).
- **Traffic.** Cashiers (POS: create order with an Idempotency-Key, read it, cursor-list orders) and owners (analytics summary, menu, 4 cursor pages of orders, payments), with 0.5–5 s think time. Each VU logs in itself and re-logs before the 15-minute token expiry.
- **Rate limits stay ON.** Each VU is its own client IP via `X-Forwarded-For`, which the API trusts because it runs with `TRUST_PROXY=true`, as it would behind a load balancer. **0 × 429 in every run.**
- **Caveat.** API, PostgreSQL, Redis, the worker _and_ k6 shared one 8-thread laptop with <1 GB free RAM. The absolute numbers are a lower bound for production hardware.

## 2. Targets (set before testing)

| Target                                        | Threshold                                           |
| --------------------------------------------- | --------------------------------------------------- |
| Standard API p95                              | < 300 ms (reads and writes separately)              |
| Standard API p99                              | < 800 ms                                            |
| Error rate                                    | < 1 %                                               |
| Critical authenticated endpoints availability | ≥ 99.9 % (error rate < 0.1 % on `critical:yes`)     |
| Spike scenario                                | p99 < 2 s during the spike; error targets unchanged |

## 3. Results

| Scenario                      | VUs           | Requests |  Errors | Read p95 / p99   | Write p95 / p99  | Thresholds            |
| ----------------------------- | ------------- | -------: | ------: | ---------------- | ---------------- | --------------------- |
| **A normal** (ramp, ~3.5 min) | 1 → 20        |    2,827 | **0 %** | 43.7 / 79.6 ms   | 92.3 / 146.3 ms  | ✅ all                |
| **B spike** (×8 in 10 s)      | 5 → 40 → 5    |    4,355 | **0 %** | 43.3 / 73.4 ms   | 121.9 / 231.3 ms | ✅ all                |
| Stress (spike to 150)         | 10 → 150 → 10 |    7,185 | **0 %** | 2,176 / 3,779 ms | 3,735 / 4,458 ms | ❌ latency; ✅ errors |
| **C soak** (20 min)           | 10 + 3        |   16,523 | **0 %** | 52.0 / 81.4 ms   | 74.3 / 184.0 ms  | ✅ all                |

Orders created: 700 (A), 1,136 (B), 1,926 (stress), 3,880 (C). Analytics 503s: 0. 429s: 0.

### Capacity and bottleneck (stress run, `monitor-spike150.csv`)

- **Throughput plateaued at ~33 req/s.**
- **API container ~92–113 % CPU during the hold**, meaning one Node.js event loop saturated a single core. It peaked at 533 % during the ramp, when 150 argon2 logins ran in parallel on libuv threads.
- **PostgreSQL CPU 187–275 %**, with 9 of 10 pool connections active.
- **Redis <12 %; worker idle.**
- **Recovery after the spike:** API CPU fell to ~10–17 % and active PG connections to 1 within ~30 s, with no errors at any point. The system degrades by queueing, not by failing.
- **Implication.** On this hardware, capacity per API process is a few tens of req/s. The API is stateless (rate limits, cache and queues live in Redis), so production capacity scales with replicas. PgBouncer is needed beyond ~6 replicas of 10 connections each against `max_connections = 100`.

### Soak (C): leak check (`monitor-soak.csv`, 30 s samples)

| Signal                               | Start   | Middle      | End     | Verdict                                                          |
| ------------------------------------ | ------- | ----------- | ------- | ---------------------------------------------------------------- |
| API container memory                 | 193 MiB | 164–166 MiB | 140 MiB | **No leak** (GC'd down)                                          |
| PostgreSQL connections (DB total)    | 4       | 5           | 6       | **No connection leak** (pool ≤ 10)                               |
| PostgreSQL CPU                       | 16 %    | 23–25 %     | 20 %    | steady                                                           |
| Redis used memory                    | 3.32 MB | 3.33 MB     | 3.31 MB | flat (bounded TTL keys; `noeviction` is safe)                    |
| Notifications queue waiting / failed | 0 / 1   | 0 / 1       | 0 / 1   | **No backlog** (the 1 failed job is the deliberate Phase 5 test) |

20 minutes is short for a soak. Run 4–24 h on staging with `DURATION=4h` before launch.

## 4. D: Large datasets (1M / 10M orders): NOT RUN

**Blocked: needs ≥16 GB RAM.** Seeding 1M orders exhausted this host in Phase 6, so I didn't attempt it here, as instructed.

**Exact procedure:** see `tests/load/k6/README.md` §Large datasets.

1. Seed with `LOAD_ORDERS=1000000`, then `10000000`.
2. Run `normal.js` with `PEAK_VUS=100 STAGE=5m` while `monitor.sh` samples.
3. Run `EXPLAIN (ANALYZE, BUFFERS)` on the cursor and analytics queries.

**No results are claimed.**

## 5. Monitoring coverage

| Metric                                     | Source                                   | Covered                                                                    |
| ------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------- |
| Latency p50 / p95 / p99, req/s, error rate | k6 summaries (`results/*.json`, `*.txt`) | ✅                                                                         |
| CPU, memory per container                  | `monitor.sh` (`docker stats`)            | ✅                                                                         |
| PostgreSQL connections by state            | `pg_stat_activity`                       | ✅                                                                         |
| Redis memory                               | `INFO memory`                            | ✅                                                                         |
| Queue depth                                | BullMQ keys                              | ✅                                                                         |
| Slow queries                               | —                                        | ⚠️ `pg_stat_statements` not enabled in the dev image; enable it in staging |
| Worker throughput                          | Phase 5 benchmark: ~30–43 jobs/s         | ✅ (earlier phase)                                                         |

## 6. Next steps

1. Run D on a ≥16 GB runner.
2. Test 2–4 API replicas behind a load balancer, with PgBouncer.
3. Soak for 4 h or more in staging with `pg_stat_statements`.
4. Add the k6 smoke run (`PEAK_VUS=5 STAGE=30s`) to CI against the Compose stack.
