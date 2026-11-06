#!/usr/bin/env bash
# Large-dataset benchmarks (1M / 10M orders), analytics at scale, multi-replica k6.
# MUST run on a machine with >= 16 GB RAM (the 8 GB dev laptop ran out of memory at 1M in Phase 6).
# Writes raw results to tests/load/large-dataset/results/<UTC timestamp>/. Nothing is summarised
# or invented by this script: the report is written by a person from these files.
#
# Usage (repository root, Docker running, `pnpm install` done, .env present):
#   tests/load/large-dataset/run.sh [all|plans|analytics|trigram|k6] [orders=1000000]
#   ORDERS=10000000 tests/load/large-dataset/run.sh all
set -euo pipefail

STEP="${1:-all}"
ORDERS="${ORDERS:-${2:-1000000}}"
MIN_GB=15
OUT="tests/load/large-dataset/results/$(date -u +%Y%m%dT%H%M%SZ)-${ORDERS}"
mkdir -p "$OUT"
log() { echo "[$(date -u +%T)] $*" | tee -a "$OUT/run.log"; }

# --- Guard: enough memory ----------------------------------------------------------------------
mem_gb() {
  if [[ -r /proc/meminfo ]]; then awk '/MemTotal/ {printf "%d", $2/1024/1024}' /proc/meminfo
  elif command -v sysctl >/dev/null; then echo $(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))
  else powershell -NoProfile -Command "[int]((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB)"; fi
}
GB="$(mem_gb | tr -d '\r')"
if (( GB < MIN_GB )); then
  echo "Refusing: ${GB} GB RAM detected, at least ${MIN_GB} GB required (16 GB machine)." >&2
  exit 1
fi
log "host: ${GB} GB RAM, $(nproc 2>/dev/null || echo '?') CPUs, orders=${ORDERS}, step=${STEP}"
docker info --format 'docker: {{.ServerVersion}}, {{.NCPU}} CPUs, {{.MemTotal}} bytes' | tee -a "$OUT/run.log"
git rev-parse HEAD | sed 's/^/commit: /' | tee -a "$OUT/run.log"

# --- PostgreSQL sized for the run (restart with these settings) ----------------------------------
cat > "$OUT/postgres.override.yml" <<'YML'
services:
  postgres:
    command: >
      postgres -c shared_buffers=4GB -c work_mem=32MB -c maintenance_work_mem=1GB
      -c effective_cache_size=10GB -c max_wal_size=8GB -c checkpoint_timeout=15min
      -c shared_preload_libraries=pg_stat_statements -c pg_stat_statements.track=top
YML
log "restarting postgres with benchmark settings"
docker compose -f docker-compose.yml -f "$OUT/postgres.override.yml" up -d postgres
until docker compose exec -T postgres pg_isready >/dev/null 2>&1; do sleep 1; done

sample() { # background resource sampler for the duration of a step
  (while true; do docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' | sed "s/^/$(date -u +%T),/"; sleep 15; done) > "$OUT/$1-docker-stats.csv" &
  echo $!
}

run_plans() {
  log "Phase 2 plans: ${ORDERS} orders (EXPLAIN ANALYZE, insert throughput)"
  pid=$(sample plans)
  PERF_ORDERS="$ORDERS" pnpm --filter @foodstack/api test:perf -- phase2-plans 2>&1 | tee "$OUT/phase2-plans.log"
  kill "$pid" || true
  cp apps/api/perf/results/phase2-plans.md "$OUT/" 2>/dev/null || true
}

run_analytics() {
  log "Phase 6 analytics: 1k warm-up + ${ORDERS} orders (cache off/on, concurrency, EXPLAIN)"
  pid=$(sample analytics)
  PHASE6_SIZES="1000,${ORDERS}" PHASE6_OUT="phase6-analytics-${ORDERS}" \
    pnpm --filter @foodstack/api test:perf -- phase6-analytics 2>&1 | tee "$OUT/phase6-analytics.log"
  kill "$pid" || true
  cp "apps/api/perf/results/phase6-analytics-${ORDERS}."* "$OUT/" 2>/dev/null || true
}

run_trigram() {
  log "Search under RLS: $((ORDERS / 5)) customers / ${ORDERS} orders (rolled back)"
  docker compose exec -T postgres psql -U "${DATABASE_MIGRATION_USER:-foodstack_owner}" -d foodstack_test \
    -v customers=$((ORDERS / 5)) -v orders="$ORDERS" < apps/api/perf/phase2-trigram.sql | tee "$OUT/trigram.log"
}

run_k6() {
  log "Multi-replica k6 on a ${ORDERS}-order dataset (foodstack_load)"
  set -a; source .env; set +a
  [[ -f infrastructure/docker/ha/secrets.env ]] || node infrastructure/docker/ha/gen-secrets.mjs > infrastructure/docker/ha/secrets.env
  docker compose exec -T postgres dropdb -U "$DATABASE_MIGRATION_USER" --if-exists foodstack_load
  docker compose exec -T postgres createdb -U "$DATABASE_MIGRATION_USER" foodstack_load
  docker compose --profile apps build api
  docker compose --profile apps run --rm --no-deps --env-from-file infrastructure/docker/ha/secrets.env \
    -e DATABASE_NAME=foodstack_load migrate
  ( cd apps/api && DATABASE_NAME=foodstack_load DATABASE_HOST=localhost LOAD_PASSWORD='Load-Test-Pass-42' \
      LOAD_ORDERS="$ORDERS" node scripts/seed-load.mjs ) | tee "$OUT/seed.json"
  export GRAFANA_ADMIN_PASSWORD="${GRAFANA_ADMIN_PASSWORD:-$(openssl rand -hex 12)}"
  C=(docker compose -f docker-compose.yml -f docker-compose.ha.yml -f docker-compose.monitoring.yml --profile ha --profile monitoring)
  for replicas in 1 2 4; do
    log "k6 normal.js through the LB with ${replicas} API replica(s)"
    "${C[@]}" up -d --scale api-ha="$replicas" --scale worker-ha=2
    sleep 30
    docker run --rm -i --network foodstack_default -v "$PWD/tests/load/k6:/scripts" -v "$PWD/$OUT:/out" \
      -e BASE_URL=http://lb:8080 -e LOAD_PASSWORD='Load-Test-Pass-42' -e PEAK_VUS=$((50 * replicas)) -e STAGE=3m \
      grafana/k6:1.4.2 run --summary-export="/out/k6-normal-${replicas}replicas.json" /scripts/normal.js \
      | tee "$OUT/k6-normal-${replicas}replicas.txt" || true
    curl -s 'http://127.0.0.1:9090/api/v1/query' --data-urlencode \
      'query=max_over_time(sum(rate(foodstack_process_cpu_seconds_total{app="api"}[1m]))[10m:15s])' > "$OUT/cpu-${replicas}replicas.json" || true
  done
  log "soak: 2 replicas, 4 h"
  "${C[@]}" up -d --scale api-ha=2 --scale worker-ha=2
  docker run --rm -i --network foodstack_default -v "$PWD/tests/load/k6:/scripts" -v "$PWD/$OUT:/out" \
    -e BASE_URL=http://lb:8080 -e LOAD_PASSWORD='Load-Test-Pass-42' -e VUS=40 -e DURATION=4h \
    grafana/k6:1.4.2 run --summary-export=/out/k6-soak-4h.json /scripts/soak.js | tee "$OUT/k6-soak-4h.txt" || true
}

case "$STEP" in
  plans) run_plans ;;
  analytics) run_analytics ;;
  trigram) run_trigram ;;
  k6) run_k6 ;;
  all) run_plans; run_analytics; run_trigram; run_k6 ;;
  *) echo "unknown step: $STEP" >&2; exit 2 ;;
esac

docker compose exec -T postgres psql -U "${DATABASE_MIGRATION_USER:-foodstack_owner}" -d foodstack_test -c \
  "SELECT left(query, 120) AS query, calls, round(mean_exec_time::numeric, 1) AS mean_ms, round(total_exec_time::numeric) AS total_ms
     FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 25" > "$OUT/top-statements.txt" 2>&1 || true
log "done. Raw results: $OUT (write the report from these files; do not edit them)."
