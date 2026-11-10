# FoodStack — High Availability and Monitoring: Local Rehearsal Report

_2026-11-06 · Docker Compose on the 8 GB development laptop. The stack used the production image with
`NODE_ENV=production` validation, the `foodstack_load` database, and the queue prefix `foodstack-ha`.
This report covers a **local rehearsal of the AWS design** (`infrastructure/aws`). It is not a
production verification._

## 1. Stack under test

`docker-compose.ha.yml` + `docker-compose.monitoring.yml`:

- **nginx load balancer** (stand-in for the ALB): round robin, passive health checks, retry on connect errors;
- **2 API replicas**;
- **2 workers**;
- **PgBouncer 1.24.1**: transaction mode, `default_pool_size 20`, `max_db_connections 40`;
- **Monitoring:** Prometheus 3.5.0 (21 alert rules), Alertmanager, Grafana 12.1.1 (32-panel dashboard), and exporters
  for PostgreSQL, Redis and PgBouncer.

## 2. Defects found by the rehearsal (fixed)

| #   | Defect                                                                                                                                                                                             | Fix                                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **No replica could start behind PgBouncer**: node-pg sends `statement_timeout` as a startup parameter, and PgBouncer rejects it. Ignoring it at PgBouncer would silently drop the 15 s safety net. | `73e7e5f`: `statement_timeout` is set per transaction with `set_config(..., true)`, the same way as the RLS context. `DATABASE_POOLER=pgbouncer` drops the startup parameter. Integration test: inside a transaction, `SHOW` returns the configured value, and a 2 s query is cancelled under a 200 ms limit. |
| 2   | **The PgBouncer exporter was denied** (`not allowed`), so the PgBouncer panels were silently empty.                                                                                                | `STATS_USERS`, plus a `PgBouncerDown` alert so this can't go unnoticed again.                                                                                                                                                                                                                                 |
| 3   | **`/api/v1/health` (readiness) returns 503 when Redis is down.** If a load balancer used it, every replica would leave rotation at once.                                                           | The AWS target groups use `/api/v1/health/live` (liveness). Documented in the ECS module.                                                                                                                                                                                                                     |
| 4   | **The worker overlay lacked `SWAGGER_ENABLED=false`.** Production validation refused to start, which is the intended behaviour.                                                                    | Overlay corrected.                                                                                                                                                                                                                                                                                            |

## 3. Results (measured)

| Test                                                                                         | Result                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Multi-replica load:** k6 `normal.js`, 40 VUs through the LB, 2 replicas                    | 5,403 requests, **0 % errors**. Reads p95 147 ms / p99 321 ms ✅. Writes p95 592 ms / p99 2.07 s ❌ (target 300 / 800 ms).                                                                                                                                                                                                      |
| **Graceful shutdown under load:** `docker stop -t 30` of replica 1 at 90 s, restart at 150 s | Drained in **7.8 s** (exit 143 = Nest's re-raised SIGTERM after closing). **No failed requests** during or after; the LB routed around it.                                                                                                                                                                                      |
| **Connection limits:** 2 API pools (10 each) + 2 workers behind PgBouncer                    | PostgreSQL server connections for the DB **peaked at 18** (cap 40). App-side `waiting_clients` stayed 0.                                                                                                                                                                                                                        |
| **Redis failure:** Redis stopped with live traffic                                           | Login, forgot-password and MFA verify returned **503 `AUTH_UNAVAILABLE` + `Retry-After: 10`** (fail closed, as decided). Authenticated `GET /menu` returned **200 in 0.10 s** (cache fell back to PostgreSQL). Redis healthy again after ~4 s, and login **200** right after. The dev API on :4000 (same Redis) stayed healthy. |
| **Alerting on that outage**                                                                  | `AuthFailingClosed` **fired**; `CacheFallingBack` and `ApiLatencyP99High` went pending. Alertmanager received them.                                                                                                                                                                                                             |
| **Worker scaling:** 12 emails, 2 workers                                                     | All 12 sent, **5 / 7** split between workers (BullMQ competing consumers), no duplicates.                                                                                                                                                                                                                                       |
| **PgBouncer restart** with replicas running                                                  | LB health stayed **200**; the pools reconnected.                                                                                                                                                                                                                                                                                |
| **Monitoring wiring**                                                                        | Every target `up` (2 API, 2 workers, postgres, redis, pgbouncer, prometheus). 32/32 dashboard queries valid. Grafana datasource healthy. 21/21 rules healthy (`promtool check rules`: SUCCESS).                                                                                                                                 |

### Why writes missed the latency target

On the API replicas, CPU peaked at 0.62 core and event-loop p99 at 80 ms, with no DB pool waits. The
API was not the limit. All test orders belong to **one tenant**, and creating an order updates that
tenant's monthly usage-counter row and the branch order-number row, which serializes concurrent orders
of the same tenant. The single laptop also ran PostgreSQL, two replicas, two workers, PgBouncer,
monitoring and k6 at the same time.

**Follow-up:** measure on the ≥16 GB machine with many tenants (`run.sh k6`). If one very busy tenant
is still slow, batch counter increments (per-request counter rows, aggregated asynchronously) rather than
weakening the order-limit guarantee.

## 4. Metrics implemented (`apps/api/src/shared/metrics`)

- **HTTP:** `foodstack_http_requests_total{method,route,status}` and `foodstack_http_request_duration_seconds{method,route,status_class}`.
  Routes are templates (`/api/v1/orders/:id`); unknown routes collapse to `unmatched`.
- **Process:** CPU, resident memory, heap, GC and event-loop lag p50/p90/p99 (`collectDefaultMetrics`, prefix `foodstack_`, label `app=api|worker`).
- **Database:** `foodstack_db_pool_connections{state=total|idle|waiting_clients}`.
- **Queue:** `foodstack_queue_jobs{queue,state}`, read at scrape time.
- **Cache:** `foodstack_cache_events_total{event=hits|misses|fallbacks|coalesced|errors}`.
- **Analytics limiter:** `foodstack_analytics_limiter{state=running|waiting|max}`.
- **Rate limiting:** `foodstack_rate_limit_unavailable_total{outcome=rejected|allowed}`.
- **Worker:** `foodstack_worker_jobs_total{queue,outcome=completed|retried|failed}` and `foodstack_worker_job_duration_seconds`.
- **Exposure:** a separate port (`METRICS_PORT` 9464, `WORKER_METRICS_PORT` 9465), bound to 127.0.0.1 unless
  `METRICS_HOST` says otherwise. It is never behind the public load balancer.

## 5. Not covered here

- **Real AWS behaviour:** ALB, RDS Multi-AZ failover, ElastiCache failover, ECS rolling deploys and AMP.
- **Sustained load at scale:** many tenants, 1M/10M orders, and 4+ replicas. See `tests/load/large-dataset/run.sh`.
- **A Redis _failover_** (replica promotion), as opposed to a full outage.

## 6. Reproduce

```bash
node infrastructure/docker/ha/gen-secrets.mjs > infrastructure/docker/ha/secrets.env
docker compose --profile apps build api
# foodstack_load: create, migrate and seed as in tests/load/k6/README.md
export GRAFANA_ADMIN_PASSWORD=$(openssl rand -hex 12)
docker compose -f docker-compose.yml -f docker-compose.ha.yml -f docker-compose.monitoring.yml \
  --profile ha --profile monitoring up -d --scale api-ha=2 --scale worker-ha=2
# k6 through the LB:
docker run --rm -i --network foodstack_default -v "$PWD/tests/load/k6:/scripts" \
  -e BASE_URL=http://lb:8080 -e LOAD_PASSWORD='Load-Test-Pass-42' -e PEAK_VUS=40 -e STAGE=1m \
  grafana/k6:1.4.2 run /scripts/normal.js
```
