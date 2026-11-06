/** In-process cache counters (per API instance). Labels never contain ids or values. */

type Counters = {
  hits: number;
  misses: number;
  /** Redis unavailable (breaker open) or the command failed: served from PostgreSQL. */
  fallbacks: number;
  /** Requests that waited for an identical in-flight load instead of querying. */
  coalesced: number;
  errors: number;
};

const empty = (): Counters => ({ hits: 0, misses: 0, fallbacks: 0, coalesced: 0, errors: 0 });

const SAMPLES = 1024;

export class CacheMetrics {
  private readonly byEntry = new Map<string, Counters>();
  private readonly invalidations = new Map<string, number>();
  private invalidationErrors = 0;
  private readonly latency: number[] = [];
  private latencyNext = 0;
  readonly since = new Date();

  count(label: string, what: keyof Counters): void {
    let c = this.byEntry.get(label);
    if (!c) this.byEntry.set(label, (c = empty()));
    c[what] += 1;
  }

  invalidated(area: string, ok: boolean): void {
    this.invalidations.set(area, (this.invalidations.get(area) ?? 0) + 1);
    if (!ok) this.invalidationErrors += 1;
  }

  /** Round-trip time of one Redis command, in ms. */
  redisLatency(ms: number): void {
    if (this.latency.length < SAMPLES) this.latency.push(ms);
    else this.latency[this.latencyNext] = ms;
    this.latencyNext = (this.latencyNext + 1) % SAMPLES;
  }

  snapshot() {
    const total = empty();
    const entries: Record<string, Counters & { hitRatio: number | null }> = {};
    for (const [label, c] of [...this.byEntry].sort(([a], [b]) => a.localeCompare(b))) {
      for (const k of Object.keys(total) as (keyof Counters)[]) total[k] += c[k];
      entries[label] = { ...c, hitRatio: ratio(c) };
    }
    const sorted = [...this.latency].sort((a, b) => a - b);
    const pct = (p: number) =>
      sorted.length
        ? round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!)
        : null;
    return {
      since: this.since.toISOString(),
      totals: { ...total, hitRatio: ratio(total) },
      entries,
      invalidations: Object.fromEntries(this.invalidations),
      invalidationErrors: this.invalidationErrors,
      redisLatencyMs: { samples: sorted.length, p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) },
    };
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function ratio(c: Counters): number | null {
  const lookups = c.hits + c.misses;
  return lookups === 0 ? null : round(c.hits / lookups);
}
