import { performance } from 'node:perf_hooks';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { AppConfigService } from '../../config/app-config.service';
import type { Db } from '../../core/db/db-context';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { type CacheNamespace, metricName } from './cache.keys';
import { CacheMetrics } from './cache.metrics';

/** Version counters outlive every entry by far; an idle namespace may restart from 0 safely. */
const VERSION_TTL_S = 7 * 24 * 3600;
/** Up to +10% TTL so entries written together do not all expire together. */
const JITTER = 0.1;

export type CacheTtl =
  | 'menu'
  | 'menuCategories'
  | 'inventorySummary'
  | 'plans'
  | 'analytics'
  | 'analyticsClosed'
  | 'platformAnalytics';

const TTL_ENV = {
  menu: 'CACHE_TTL_MENU_SECONDS',
  menuCategories: 'CACHE_TTL_MENU_CATEGORIES_SECONDS',
  inventorySummary: 'CACHE_TTL_INVENTORY_SUMMARY_SECONDS',
  plans: 'CACHE_TTL_PLANS_SECONDS',
  analytics: 'CACHE_TTL_ANALYTICS_SECONDS',
  analyticsClosed: 'CACHE_TTL_ANALYTICS_CLOSED_SECONDS',
  platformAnalytics: 'CACHE_TTL_PLATFORM_ANALYTICS_SECONDS',
} as const;

/**
 * Centralized cache-aside over the shared request-path Redis client. Redis is an optimization:
 * every failure path falls back to `load()` (PostgreSQL).
 *
 * Keys: `{prefix}:cache:e{epoch}:{namespace}:v{version}:{entry}`.
 * - `namespace` carries the tenant and restaurant (see cache.keys.ts).
 * - Invalidation bumps the namespace version (one INCR, no SCAN/DEL). The version is read
 *   *before* loading, so a load that raced with a write is stored under the old version and
 *   never served after the write's invalidation.
 * - `epoch` is bumped once after Redis recovers if an invalidation failed during the outage,
 *   which retires every entry written before it.
 *
 * Stampede protection: identical concurrent loads in this process share one promise
 * (single-flight), TTLs have jitter, and a circuit breaker skips Redis for CACHE_BREAKER_MS
 * after an error so an outage costs one timeout per window, not one per request. No
 * distributed lock: per-instance single-flight bounds a cold key to one query per instance.
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger('Cache');
  readonly metrics = new CacheMetrics();
  private readonly prefix: string;
  private readonly enabled: boolean;
  private readonly breakerMs: number;
  private readonly ttls: Record<CacheTtl, number>;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private breakerUntil = 0;
  private outage = false;
  private epochBumpNeeded = false;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: AppConfigService,
  ) {
    this.prefix = `${config.get('QUEUE_PREFIX')}:cache`;
    this.enabled = config.get('CACHE_ENABLED');
    this.breakerMs = config.get('CACHE_BREAKER_MS');
    this.ttls = Object.fromEntries(
      Object.entries(TTL_ENV).map(([k, env]) => [k, config.get(env)]),
    ) as Record<CacheTtl, number>;
  }

  ttl(kind: CacheTtl): number {
    return this.ttls[kind];
  }

  /**
   * Cache-aside read. The caller must already have checked that the requester may read this
   * namespace. `undefined` results are not stored.
   */
  async getOrLoad<T>(
    ns: CacheNamespace,
    entry: string,
    ttlSeconds: number,
    load: () => Promise<T>,
  ): Promise<T> {
    if (!this.enabled) return load();
    const label = metricName(ns, entry);
    if (!this.available()) {
      this.metrics.count(label, 'fallbacks');
      return load();
    }
    const flightKey = `${ns}|${entry}`;
    const pending = this.inflight.get(flightKey) as Promise<T> | undefined;
    if (pending) {
      this.metrics.count(label, 'coalesced');
      // The leader's load ran in the leader's transaction; if it failed, load our own.
      return pending.catch(() => load());
    }
    const leader = this.lookup(ns, entry, ttlSeconds, load, label);
    this.inflight.set(flightKey, leader);
    try {
      return await leader;
    } finally {
      this.inflight.delete(flightKey);
    }
  }

  /** Retires every entry of `ns` now (all instances, since the version lives in Redis). */
  async invalidate(ns: CacheNamespace): Promise<void> {
    if (!this.enabled) return;
    const area = ns.split(':').at(-1)!;
    if (!this.available()) {
      this.epochBumpNeeded = true;
      this.metrics.invalidated(area, false);
      return;
    }
    try {
      await this.bumpEpochIfNeeded();
      const key = this.versionKey(ns);
      const res = await this.timed(() =>
        this.redis.multi().incr(key).expire(key, VERSION_TTL_S).exec(),
      );
      const failed = !res || res.some(([err]) => err);
      if (failed) throw new Error('invalidation transaction failed');
      this.metrics.invalidated(area, true);
      this.recovered();
    } catch (error) {
      this.epochBumpNeeded = true;
      this.metrics.invalidated(area, false);
      this.failed(error);
    }
  }

  /** Invalidates `ns` once the transaction behind `db` commits (never on rollback). */
  invalidateAfterCommit(db: Db, ns: CacheNamespace): void {
    db.afterCommit(`cache:${ns}`, () => this.invalidate(ns));
  }

  /** Metrics plus Redis server memory/eviction figures (no keys or values). */
  async stats() {
    let server: Record<string, string | number> | { error: string };
    try {
      const info = await this.timed(() => this.redis.info());
      const pick = new Set([
        'redis_version',
        'used_memory',
        'used_memory_human',
        'used_memory_peak_human',
        'maxmemory',
        'maxmemory_policy',
        'evicted_keys',
        'expired_keys',
        'keyspace_hits',
        'keyspace_misses',
        'connected_clients',
      ]);
      server = Object.fromEntries(
        info
          .split(/\r?\n/)
          .map((line) => line.split(':'))
          .filter(([k]) => k && pick.has(k))
          .map(([k, v]) => [k!, /^\d+$/.test(v!) ? Number(v) : v!]),
      );
    } catch (error) {
      server = { error: (error as Error).message || 'Redis unavailable' };
    }
    return {
      enabled: this.enabled,
      available: this.available(),
      ttlSeconds: this.ttls,
      ...this.metrics.snapshot(),
      redis: server,
    };
  }

  // ---- internals ----

  private async lookup<T>(
    ns: CacheNamespace,
    entry: string,
    ttlSeconds: number,
    load: () => Promise<T>,
    label: string,
  ): Promise<T> {
    let dataKey: string;
    try {
      await this.bumpEpochIfNeeded();
      const [epoch, version] = await this.timed(() =>
        this.redis.mget(this.epochKey(), this.versionKey(ns)),
      );
      dataKey = `${this.prefix}:e${epoch ?? 0}:${ns}:v${version ?? 0}:${entry}`;
      const raw = await this.timed(() => this.redis.get(dataKey));
      this.recovered();
      if (raw !== null) {
        const decoded = this.decode<T>(raw, ns, entry);
        if (decoded.ok) {
          this.metrics.count(label, 'hits');
          return decoded.value;
        }
        this.metrics.count(label, 'errors');
      }
      this.metrics.count(label, 'misses');
    } catch (error) {
      this.failed(error);
      this.metrics.count(label, 'fallbacks');
      return load();
    }

    const value = await load();
    if (value !== undefined) {
      const ttl = Math.max(1, Math.round(ttlSeconds * (1 + Math.random() * JITTER)));
      try {
        const body = JSON.stringify({ k: `${ns}|${entry}`, d: value });
        await this.timed(() => this.redis.set(dataKey, body, 'EX', ttl));
      } catch (error) {
        this.metrics.count(label, 'errors');
        this.failed(error);
      }
    }
    return value;
  }

  /** The stored envelope names its own key: a mismatch (bug or collision) is never served. */
  private decode<T>(raw: string, ns: CacheNamespace, entry: string) {
    try {
      const parsed = JSON.parse(raw) as { k?: string; d?: T };
      if (parsed.k === `${ns}|${entry}` && 'd' in parsed) {
        return { ok: true as const, value: parsed.d as T };
      }
      this.logger.error(`Cache entry key mismatch in ${metricName(ns, entry)}; ignored`);
    } catch {
      this.logger.error(`Unreadable cache entry in ${metricName(ns, entry)}; ignored`);
    }
    return { ok: false as const };
  }

  private async bumpEpochIfNeeded(): Promise<void> {
    if (!this.epochBumpNeeded) return;
    await this.timed(() => this.redis.incr(this.epochKey()));
    this.epochBumpNeeded = false;
    this.logger.warn('Cache epoch advanced: entries from before the Redis outage are retired');
  }

  private available(): boolean {
    return Date.now() >= this.breakerUntil;
  }

  private failed(error: unknown): void {
    this.breakerUntil = Date.now() + this.breakerMs;
    if (this.outage) return;
    this.outage = true;
    const e = error as NodeJS.ErrnoException;
    this.logger.error(
      `Cache unavailable, reading from PostgreSQL (${e?.message || e?.code || 'unknown error'})`,
    );
  }

  private recovered(): void {
    if (!this.outage) return;
    this.outage = false;
    this.logger.log('Cache available again');
  }

  private async timed<R>(command: () => Promise<R>): Promise<R> {
    const start = performance.now();
    try {
      return await command();
    } finally {
      this.metrics.redisLatency(performance.now() - start);
    }
  }

  private epochKey(): string {
    return `${this.prefix}:epoch`;
  }

  private versionKey(ns: CacheNamespace): string {
    return `${this.prefix}:ver:${ns}`;
  }
}
