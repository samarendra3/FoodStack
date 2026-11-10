import { createServer, type Server } from 'node:http';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  register,
  type CounterConfiguration,
  type GaugeConfiguration,
  type HistogramConfiguration,
} from 'prom-client';

/**
 * Prometheus metrics for the API and the worker (one registry per process).
 * Names are prefixed `foodstack_`; labels never carry ids, emails or raw URLs (cardinality and
 * privacy): routes are the matched route template, statuses are numbers.
 *
 * Get-or-create so a process that boots several Nest apps (tests) never registers twice.
 */
export const PREFIX = 'foodstack_';

function getOrCreate<T>(name: string, make: () => T): T {
  return (register.getSingleMetric(name) as T | undefined) ?? make();
}

export const counter = <L extends string>(c: CounterConfiguration<L>) =>
  getOrCreate(c.name, () => new Counter<L>(c));
export const gauge = <L extends string>(c: GaugeConfiguration<L>) =>
  getOrCreate(c.name, () => new Gauge<L>(c));
export const histogram = <L extends string>(c: HistogramConfiguration<L>) =>
  getOrCreate(c.name, () => new Histogram<L>(c));

export const httpRequests = counter({
  name: `${PREFIX}http_requests_total`,
  help: 'HTTP requests by method, route template and status code',
  labelNames: ['method', 'route', 'status'] as const,
});

export const httpDuration = histogram({
  name: `${PREFIX}http_request_duration_seconds`,
  help: 'HTTP request duration by method, route template and status class',
  labelNames: ['method', 'route', 'status_class'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const rateLimitUnavailable = counter({
  name: `${PREFIX}rate_limit_unavailable_total`,
  help: 'Requests seen while distributed rate limiting was unavailable, by outcome',
  labelNames: ['outcome'] as const, // rejected (fail-closed 503) | allowed (fail-open)
});

/** Process metrics (CPU, memory, event loop lag, GC, handles). Call once, from main/worker. */
export function startDefaultMetrics(app: 'api' | 'worker'): void {
  register.setDefaultLabels({ app });
  collectDefaultMetrics({ prefix: PREFIX });
}

/**
 * Serves /metrics on its own port, separate from the public HTTP port: the load balancer never
 * routes to it, so it needs no authentication and is not reachable from the internet.
 */
export function startMetricsServer(port: number, host = '127.0.0.1'): Server | undefined {
  if (!port) return undefined;
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || (req.url ?? '').split('?')[0] !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    register
      .metrics()
      .then((body) => res.writeHead(200, { 'Content-Type': register.contentType }).end(body))
      .catch(() => res.writeHead(500).end());
  });
  server.listen(port, host);
  return server;
}
