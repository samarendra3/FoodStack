#!/usr/bin/env node
// Builds dashboards/foodstack-overview.json from the panel list below (easier to review than
// hand-edited Grafana JSON). Run: node infrastructure/monitoring/grafana/build-dashboard.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const lat = (q, f = '') =>
  `histogram_quantile(${q}, sum by (le${f}) (rate(foodstack_http_request_duration_seconds_bucket{route!~".*health.*"}[5m])))`;

// [type, title, expr(s), unit, width]
const P = [
  ['row', 'API'],
  ['stat', 'API replicas up', 'sum(up{job="api"})', 'none', 4],
  ['stat', 'Request rate', 'sum(rate(foodstack_http_requests_total[1m]))', 'reqps', 5],
  [
    'stat',
    '5xx error rate',
    'sum(rate(foodstack_http_requests_total{status=~"5.."}[5m])) / clamp_min(sum(rate(foodstack_http_requests_total[5m])), 1e-9)',
    'percentunit',
    5,
  ],
  ['stat', 'p95 latency', lat(0.95), 's', 5],
  ['stat', 'p99 latency', lat(0.99), 's', 5],
  [
    'ts',
    'Requests by status class',
    'sum by (status_class) (rate(foodstack_http_request_duration_seconds_count[1m]))',
    'reqps',
    12,
  ],
  ['ts', 'Latency p50 / p95 / p99', [lat(0.5), lat(0.95), lat(0.99)], 's', 12],
  ['ts', 'Slowest routes (p95)', `topk(10, ${lat(0.95, ', route')})`, 's', 12],
  [
    'ts',
    '5xx by route',
    'topk(10, sum by (route) (rate(foodstack_http_requests_total{status=~"5.."}[5m])))',
    'reqps',
    12,
  ],
  ['row', 'Processes: CPU, memory, event loop'],
  ['ts', 'CPU per process', 'rate(foodstack_process_cpu_seconds_total[1m])', 'percentunit', 8],
  ['ts', 'Resident memory', 'foodstack_process_resident_memory_bytes', 'bytes', 8],
  ['ts', 'Event loop lag p99', 'foodstack_nodejs_eventloop_lag_p99_seconds', 's', 8],
  ['row', 'Database'],
  ['ts', 'App pool connections (per replica)', 'foodstack_db_pool_connections', 'none', 8],
  ['ts', 'PostgreSQL connections by state', 'sum by (state) (pg_stat_activity_count)', 'none', 8],
  ['ts', 'PgBouncer waiting clients', 'pgbouncer_pools_client_waiting_connections', 'none', 8],
  [
    'ts',
    'Commits / s by database',
    'sum by (datname) (rate(pg_stat_database_xact_commit{datname!~"template.*|postgres"}[1m]))',
    'ops',
    12,
  ],
  [
    'ts',
    'Deadlocks and rollbacks',
    ['sum(rate(pg_stat_database_deadlocks[5m]))', 'sum(rate(pg_stat_database_xact_rollback[5m]))'],
    'ops',
    12,
  ],
  ['row', 'Redis, cache, rate limiting'],
  ['stat', 'Redis up', 'redis_up', 'none', 4],
  [
    'ts',
    'Redis memory (used / max)',
    ['redis_memory_used_bytes', 'redis_memory_max_bytes'],
    'bytes',
    7,
  ],
  [
    'ts',
    'Redis clients and commands/s',
    ['redis_connected_clients', 'rate(redis_commands_processed_total[1m])'],
    'none',
    7,
  ],
  [
    'ts',
    'Cache hit ratio',
    'sum(rate(foodstack_cache_events_total{event="hits"}[5m])) / clamp_min(sum(rate(foodstack_cache_events_total{event=~"hits|misses"}[5m])), 1e-9)',
    'percentunit',
    6,
  ],
  [
    'ts',
    'Rate limiting unavailable (rejected = auth 503)',
    'sum by (outcome) (increase(foodstack_rate_limit_unavailable_total[5m]))',
    'none',
    12,
  ],
  ['ts', 'Analytics limiter', 'sum by (state) (foodstack_analytics_limiter)', 'none', 12],
  ['row', 'Queue and worker'],
  ['stat', 'Workers up', 'sum(up{job="worker"})', 'none', 4],
  [
    'ts',
    'Queue jobs by state',
    'max by (state) (foodstack_queue_jobs{state=~"waiting|active|delayed|failed"})',
    'none',
    10,
  ],
  [
    'ts',
    'Worker attempts by outcome',
    'sum by (outcome) (rate(foodstack_worker_jobs_total[5m]))',
    'ops',
    10,
  ],
  [
    'ts',
    'Job duration p95',
    'histogram_quantile(0.95, sum by (le) (rate(foodstack_worker_job_duration_seconds_bucket[5m])))',
    's',
    24,
  ],
];

const ds = { type: 'prometheus', uid: 'prometheus' };
const panels = [];
let x = 0;
let y = 0;
let rowH = 0;
let id = 1;
for (const [type, title, expr, unit, w] of P) {
  if (type === 'row') {
    if (x) y += rowH;
    x = 0;
    rowH = 0;
    panels.push({
      id: id++,
      type: 'row',
      title,
      collapsed: false,
      panels: [],
      gridPos: { h: 1, w: 24, x: 0, y },
    });
    y += 1;
    continue;
  }
  const h = type === 'stat' ? 4 : 8;
  if (x + w > 24) {
    y += rowH;
    x = 0;
    rowH = 0;
  }
  panels.push({
    id: id++,
    title,
    type: type === 'ts' ? 'timeseries' : 'stat',
    datasource: ds,
    gridPos: { h, w, x, y },
    fieldConfig: { defaults: { unit }, overrides: [] },
    options:
      type === 'stat'
        ? { reduceOptions: { calcs: ['lastNotNull'] }, colorMode: 'value' }
        : { legend: { displayMode: 'list', placement: 'bottom' } },
    targets: (Array.isArray(expr) ? expr : [expr]).map((e, i) => ({
      refId: String.fromCharCode(65 + i),
      expr: e,
      datasource: ds,
    })),
  });
  x += w;
  rowH = Math.max(rowH, h);
}

const dashboard = {
  uid: 'foodstack-overview',
  title: 'FoodStack — Overview',
  tags: ['foodstack'],
  schemaVersion: 39,
  version: 1,
  refresh: '15s',
  time: { from: 'now-1h', to: 'now' },
  panels,
};
const out = join(dirname(fileURLToPath(import.meta.url)), 'dashboards', 'foodstack-overview.json');
writeFileSync(out, JSON.stringify(dashboard, null, 2) + '\n');
console.log(`${panels.length} panels → ${out}`);
