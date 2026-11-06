# FoodStack load tests (k6)

Scenarios (all share `lib/api.js`: per-VU login, POS and back-office traffic, thresholds):

| Script      | What it does                                                                    | Knobs (env)                     |
| ----------- | ------------------------------------------------------------------------------- | ------------------------------- |
| `normal.js` | Gradual ramp of cashiers (80 %) and back office (20 %) to `PEAK_VUS`, then hold | `PEAK_VUS` (20), `STAGE` (1m)   |
| `spike.js`  | Baseline → ×8 within 10 s → hold → drop back; judges errors and recovery        | `BASE_VUS` (5), `PEAK_VUS` (40) |
| `soak.js`   | Constant traffic for a long time (leaks: memory, connections, queue backlog)    | `VUS` (10), `DURATION` (30m)    |

Traffic per iteration:

- **POS (cashier):** `POST /orders` with an `Idempotency-Key`, `GET /orders/:id`, `GET /orders?pagination=cursor`.
- **Back office (owner):** `GET /analytics/summary`, `GET /menu`, four cursor pages of `/orders`, and `/payments`.

Think time is 0.5–5 s.

Targets (thresholds) are in `lib/api.js` and explained in `docs/PHASE_8_FINAL_REPORT.md`:

- p95 < 300 ms and p99 < 800 ms for reads and for writes;
- under 1 % failed requests overall;
- under 0.1 % on critical endpoints (99.9 % availability).

## Never against dev or production data

The scripts create orders. Run them against a dedicated `foodstack_load` database, seeded with
`apps/api/scripts/seed-load.mjs`, which refuses any database name that does not end in `_load`.

## Rate limits stay on

The API limits each client IP to 300 requests/min, and logins to 10/min. A real restaurant is many
devices. Here each VU sends its own client address (`X-Forwarded-For`, accepted only because the load API
runs with `TRUST_PROXY=true`, as it does behind a load balancer). One VU stays well under both
limits at these think times, so a 429 in the results means a real problem. `rate_limited_429`
counts them.

## Run (Docker only; no local k6 install needed)

From the repository root, with the compose stack up (`pnpm docker:up`):

```bash
# 1. Image (same image as production) and a fresh load database
docker compose --profile apps build api
docker compose exec -T postgres dropdb -U foodstack_owner --if-exists foodstack_load
docker compose exec -T postgres createdb -U foodstack_owner foodstack_load
docker compose run --rm -e DATABASE_NAME=foodstack_load migrate

# 2. Seed (prints the user emails). LOAD_ORDERS adds history for large-dataset runs.
( cd apps/api && DATABASE_NAME=foodstack_load DATABASE_HOST=localhost \
    DATABASE_MIGRATION_USER=foodstack_owner DATABASE_MIGRATION_PASSWORD="$PG_OWNER_PASSWORD" \
    LOAD_PASSWORD='Load-Test-Pass-42' LOAD_ORDERS=0 node scripts/seed-load.mjs )

# 3. API under test on :4100 (production mode, real limits, trusted proxy)
docker compose run -d --name foodstack-load-api --service-ports=false -p 127.0.0.1:4100:4000 \
  -e DATABASE_NAME=foodstack_load -e TRUST_PROXY=true -e QUEUE_PREFIX=foodstack-load api

# 4. k6 (in Docker, on the compose network)
docker run --rm -i --network foodstack_default -v "$PWD/tests/load/k6:/scripts" \
  -e BASE_URL=http://foodstack-load-api:4000 -e LOAD_PASSWORD='Load-Test-Pass-42' \
  grafana/k6:1.4.2 run --summary-export=/scripts/results/normal.json /scripts/normal.js

# Optional, in another terminal: resource samples
tests/load/monitor.sh 15 foodstack_load > tests/load/k6/results/monitor.csv

# 5. Clean up
docker rm -f foodstack-load-api
docker compose exec -T postgres dropdb -U foodstack_owner foodstack_load
```

## Large datasets (1M / 10M orders): needs ≥ 16 GB RAM

On this repository's 8 GB development laptop, seeding 1M orders exhausted memory in Phase 6. Run step 2 with
`LOAD_ORDERS=1000000`, then `10000000`, on a machine with at least 16 GB RAM (PostgreSQL
`shared_buffers` ≥ 4 GB). Then repeat `normal.js` and record the results in
`docs/PHASE_8_FINAL_REPORT.md`.
