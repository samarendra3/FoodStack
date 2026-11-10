#!/usr/bin/env bash
# Samples resource use while a k6 run is in progress: container CPU/memory, PostgreSQL
# connections by state, Redis memory, and BullMQ notifications queue depth. One CSV line per interval.
#
#   tests/load/monitor.sh [interval_seconds=15] [db=foodstack_load] > monitor.csv
#
# Needs the compose stack (postgres, redis) and REDIS_PASSWORD in the environment or .env.
set -euo pipefail
INTERVAL="${1:-15}"
DB="${2:-foodstack_load}"
PG_USER="${PG_USER:-foodstack_owner}"
PREFIX="${QUEUE_PREFIX:-foodstack}"
if [[ -z "${REDIS_PASSWORD:-}" && -f .env ]]; then
  REDIS_PASSWORD="$(grep -E '^REDIS_PASSWORD=' .env | cut -d= -f2-)"
fi

psqlq() { docker compose exec -T postgres psql -U "$PG_USER" -d "$DB" -At -c "$1"; }
rcli() { docker compose exec -T -e REDISCLI_AUTH="$REDIS_PASSWORD" redis redis-cli "$@"; }

echo "time,container,cpu_pct,mem,pg_active,pg_idle,pg_idle_in_tx,pg_total,redis_used_bytes,queue_waiting,queue_active,queue_failed"
while true; do
  now="$(date -u +%FT%TZ)"
  pg="$(psqlq "SELECT count(*) FILTER (WHERE state='active'), count(*) FILTER (WHERE state='idle'),
                      count(*) FILTER (WHERE state LIKE 'idle in transaction%'), count(*)
                 FROM pg_stat_activity WHERE datname = '$DB'" | tr '|' ',')"
  mem="$(rcli INFO memory | awk -F: '/^used_memory:/ {gsub(/\r/,"",$2); print $2}')"
  waiting="$(rcli LLEN "$PREFIX:notifications:wait" | tr -d '\r')"
  active="$(rcli LLEN "$PREFIX:notifications:active" | tr -d '\r')"
  failed="$(rcli ZCARD "$PREFIX:notifications:failed" | tr -d '\r')"
  docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' |
    while IFS=, read -r name cpu memusage; do
      echo "$now,$name,${cpu%\%},\"$memusage\",$pg,$mem,$waiting,$active,$failed"
    done
  sleep "$INTERVAL"
done
