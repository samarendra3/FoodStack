import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type Redis from 'ioredis';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { Db } from '../src/core/db/db-context';
import { PasswordHasher } from '../src/core/security/password-hasher';
import { CacheService } from '../src/shared/cache/cache.service';
import { REDIS_CLIENT } from '../src/shared/redis/redis.constants';
import { connect, testEnv } from '../integration/helpers';

/**
 * Phase 4 benchmark: the cached endpoints with CACHE_ENABLED=false vs true, same data, same
 * process. Sequential latency (median/p95/p99), a concurrent run (throughput + latency), SQL
 * statements per request, PostgreSQL work (pg_stat_database deltas), hit ratio and Redis memory.
 * Results: perf/results/phase4-cache.md
 *
 * Data: 1 restaurant, 16 categories × 14 items (224 items, every third with 2 portions),
 * 180 stock items with quantities, plus the seeded plan catalogue.
 */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const SEQ = 200;
const WARMUP = 20;
const CONCURRENCY = 20;
// PHASE4_ROUNDS > 0: interleaved A/B/B/A throughput rounds instead of the single comparison
// (written to phase4-throughput.md). One sample per mode in a fixed order is too noisy on a laptop.
const ROUNDS = Number(process.env.PHASE4_ROUNDS ?? 0);
const PER_WORKER = Number(process.env.PHASE4_PER_WORKER ?? 20);
const OUT = ROUNDS > 0 ? 'phase4-throughput' : 'phase4-cache';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;

type Stats = { p50: number; p95: number; p99: number };
const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
const summarize = (times: number[]): Stats => {
  const s = [...times].sort((a, b) => a - b);
  return { p50: pct(s, 0.5), p95: pct(s, 0.95), p99: pct(s, 0.99) };
};
const f = (n: number) => n.toFixed(1);

describe('Phase 4 cache benchmark', () => {
  let migrator: DataSource;
  const tenants: string[] = [];
  let email = '';
  let branch = '';
  let statements = 0;
  const out: string[] = [];
  const results: Record<string, Record<string, unknown>> = {};

  const endpoints = () => [
    '/menu',
    '/menu/categories',
    `/inventory/summary?branchId=${branch}`,
    '/plans',
  ];

  beforeAll(async () => {
    migrator = await connect('migration');
    await migrator.runMigrations({ transaction: 'each' });
    const hash = await new PasswordHasher().hash(PASSWORD);
    const [t] = await migrator.query(
      `INSERT INTO tenants (slug, name) VALUES ($1, 'bench') RETURNING id`,
      [`bench-${suffix()}`],
    );
    tenants.push(t.id);
    const [r] = await migrator.query(
      `INSERT INTO restaurants (tenant_id, name, slug, currency_code, country_code, timezone)
       VALUES ($1, 'Bench Bistro', $2, 'INR', 'IN', 'Asia/Kolkata') RETURNING id`,
      [t.id, `bench-${suffix()}`],
    );
    branch = (
      await migrator.query(
        `INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone, is_default)
         VALUES ($1, $2, 'MAIN', 'Main', 'Asia/Kolkata', true) RETURNING id`,
        [t.id, r.id],
      )
    )[0].id;
    email = `bench-${suffix()}@example.test`;
    const [u] = await migrator.query(
      `INSERT INTO users (email, full_name, password_hash, email_verified_at) VALUES ($1, 'Owner', $2, now()) RETURNING id`,
      [email, hash],
    );
    const [m] = await migrator.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, status, joined_at) VALUES ($1, $2, 'active', now()) RETURNING id`,
      [t.id, u.id],
    );
    await migrator.query(
      `INSERT INTO user_role_assignments (tenant_id, membership_id, role_id, scope_type)
       SELECT $1, $2, id, 'tenant' FROM roles WHERE tenant_id IS NULL AND code = 'owner'`,
      [t.id, m.id],
    );
    // Menu: 16 categories × 14 items; every third item has Half/Full portions.
    await migrator.query(
      `INSERT INTO menu_categories (tenant_id, restaurant_id, name, sort_order)
       SELECT $1, $2, 'Category ' || g, g FROM generate_series(1, 16) g`,
      [t.id, r.id],
    );
    await migrator.query(
      `INSERT INTO menu_items (tenant_id, restaurant_id, category_id, name, description, price_minor,
                               currency_code, diet, is_available, sort_order)
       SELECT $1, $2, c.id, c.name || ' dish ' || g, 'House special with seasonal sides', 10000 + g * 500,
              'INR', (ARRAY['veg','non_veg','egg'])[1 + g % 3], g % 7 <> 0, g
         FROM menu_categories c, generate_series(1, 14) g WHERE c.restaurant_id = $2`,
      [t.id, r.id],
    );
    await migrator.query(
      `INSERT INTO menu_item_variants (tenant_id, menu_item_id, name, price_minor, sort_order)
       SELECT $1, i.id, v.name, i.price_minor * v.k / 100, v.o
         FROM menu_items i, (VALUES ('Half', 60, 0), ('Full', 100, 1)) v(name, k, o)
        WHERE i.restaurant_id = $2 AND i.sort_order % 3 = 0`,
      [t.id, r.id],
    );
    await migrator.query(
      `INSERT INTO inventory_items (tenant_id, restaurant_id, name, category, unit, low_stock_threshold,
                                    cost_per_unit_minor, currency_code)
       SELECT $1, $2, 'Stock item ' || g, 'Group ' || (g % 9), 'kg', 5, 100 + g, 'INR'
         FROM generate_series(1, 180) g`,
      [t.id, r.id],
    );
    await migrator.query(
      `INSERT INTO inventory_stock (tenant_id, branch_id, item_id, quantity)
       SELECT $1, $2, id, (row_number() OVER ()) % 40 FROM inventory_items WHERE restaurant_id = $3`,
      [t.id, branch, r.id],
    );

    const query = Db.prototype.query;
    jest.spyOn(Db.prototype, 'query').mockImplementation(function (this: Db, ...args) {
      statements++;
      return query.apply(this, args as Parameters<typeof query>);
    });
    const setScope = Db.prototype.setScope;
    jest.spyOn(Db.prototype, 'setScope').mockImplementation(function (this: Db, ...args) {
      statements += 3; // BEGIN + set_config + COMMIT
      return setScope.apply(this, args as Parameters<typeof setScope>);
    });
  });

  afterAll(async () => {
    const dir = join(__dirname, 'results');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${OUT}.md`), out.join('\n') + '\n');
    writeFileSync(join(dir, `${OUT}.json`), JSON.stringify(results, null, 2) + '\n');
    if (migrator?.isInitialized) {
      for (const table of [
        'inventory_stock',
        'inventory_items',
        'menu_item_variants',
        'menu_items',
        'menu_categories',
        'user_role_assignments',
      ]) {
        await migrator.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
      }
      await migrator.destroy();
    }
  });

  async function boot(cacheEnabled: boolean) {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app);
    await app.init();
    // Configuration is validated once per process, so the flag is set on the compiled service
    // (same effect as CACHE_ENABLED=false: every read goes straight to load()).
    (app.get(CacheService) as unknown as { enabled: boolean }).enabled = cacheEnabled;
    const token = (
      await request(app.getHttpServer())
        .post(`${API}/auth/login`)
        .set('X-Forwarded-For', freshIp())
        .send({ email, password: PASSWORD })
        .expect(200)
    ).body.data.accessToken as string;
    return { app, token };
  }

  async function pgCounters() {
    const [row] = await migrator.query(
      `SELECT xact_commit::bigint AS xact, tup_returned::bigint AS returned, tup_fetched::bigint AS fetched,
              blks_hit::bigint AS hit, blks_read::bigint AS read
         FROM pg_stat_database WHERE datname = current_database()`,
    );
    await migrator.query('SELECT pg_stat_clear_snapshot()');
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)])) as Record<
      string,
      number
    >;
  }

  async function run(mode: 'database' | 'cache') {
    const { app, token } = await boot(mode === 'cache');
    const cache = app.get(CacheService);
    expect((cache as unknown as { enabled: boolean }).enabled).toBe(mode === 'cache');
    const server = app.getHttpServer();
    const get = (url: string) =>
      request(server)
        .get(`${API}${url}`)
        .set('X-Forwarded-For', freshIp())
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

    const perEndpoint: Record<string, unknown> = {};
    for (const url of endpoints()) {
      for (let i = 0; i < WARMUP; i++) await get(url);
      statements = 0;
      const times: number[] = [];
      for (let i = 0; i < SEQ; i++) {
        const start = performance.now();
        await get(url);
        times.push(performance.now() - start);
      }
      perEndpoint[url] = { ...summarize(times), statementsPerRequest: statements / SEQ };
    }

    // Concurrent mixed load: CONCURRENCY workers, each PER_WORKER requests over all endpoints.
    // The database run never writes to Redis; the cache run's warm-up requests are its cold misses.
    statements = 0;
    const pgBefore = await pgCounters();
    const urls = endpoints();
    const times: number[] = [];
    const started = performance.now();
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async (_, w) => {
        for (let i = 0; i < PER_WORKER; i++) {
          const url = urls[(w + i) % urls.length]!;
          const s = performance.now();
          await get(url);
          times.push(performance.now() - s);
        }
      }),
    );
    const wall = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 600)); // pg stats flush
    const pgAfter = await pgCounters();
    const n = CONCURRENCY * PER_WORKER;
    const pg = Object.fromEntries(
      Object.keys(pgBefore).map((k) => [k, (pgAfter[k]! - pgBefore[k]!) / n]),
    );
    const concurrent = {
      requests: n,
      rps: n / (wall / 1000),
      ...summarize(times),
      statementsPerRequest: statements / n,
      pgPerRequest: pg,
    };

    let memory: Record<string, number> | undefined;
    const stats = await cache.stats();
    if (mode === 'cache') {
      const redis = app.get<Redis>(REDIS_CLIENT);
      let cursor = '0';
      let bytes = 0;
      let keys = 0;
      do {
        const [next, batch] = await redis.scan(
          cursor,
          'MATCH',
          `${testEnv().QUEUE_PREFIX}:cache:*`,
          'COUNT',
          500,
        );
        cursor = next;
        for (const k of batch) {
          bytes += Number((await redis.call('MEMORY', 'USAGE', k)) ?? 0);
          keys++;
        }
      } while (cursor !== '0');
      memory = { keys, bytes };
    }
    await app.close();
    results[mode] = { perEndpoint, concurrent, cache: stats.totals, memory };
    return results[mode]!;
  }

  (ROUNDS > 0 ? it.skip : it)('measures database-only vs cache-enabled', async () => {
    const db = await run('database');
    const cached = await run('cache');
    const cpu = cpus()[0]?.model ?? 'unknown CPU';
    out.push(
      '# Phase 4 cache benchmark (measured)',
      '',
      `Machine: ${cpu}, ${cpus().length} logical CPUs, ${(totalmem() / 2 ** 30).toFixed(0)} GiB RAM; PostgreSQL 18 and Redis 8 in Docker on the same host. ` +
        'Requests go through the full Nest app (auth guard, permission look-up, RLS transaction) via supertest over loopback. ' +
        `Data: 224 menu items in 16 categories (75 with portions), 180 stock items. Sequential: ${SEQ} requests per endpoint after ${WARMUP} warm-up. ` +
        `Concurrent: ${CONCURRENCY} workers × ${PER_WORKER} requests, endpoints interleaved. Statements include BEGIN/set_config/COMMIT. Run ${new Date().toISOString()}.`,
      '',
      '## Sequential latency (ms) and SQL statements per request',
      '',
      '| Endpoint | DB p50 | DB p95 | DB p99 | Cache p50 | Cache p95 | Cache p99 | Statements DB → cache |',
      '|---|---:|---:|---:|---:|---:|---:|---:|',
    );
    for (const url of endpoints()) {
      const a = (db.perEndpoint as Record<string, Stats & { statementsPerRequest: number }>)[url]!;
      const b = (cached.perEndpoint as Record<string, Stats & { statementsPerRequest: number }>)[
        url
      ]!;
      out.push(
        `| \`GET ${url.replace(branch, '{branch}')}\` | ${f(a.p50)} | ${f(a.p95)} | ${f(a.p99)} | ${f(b.p50)} | ${f(b.p95)} | ${f(b.p99)} | ${a.statementsPerRequest.toFixed(1)} → ${b.statementsPerRequest.toFixed(1)} |`,
      );
    }
    const c1 = db.concurrent as Record<string, number> & { pgPerRequest: Record<string, number> };
    const c2 = cached.concurrent as Record<string, number> & {
      pgPerRequest: Record<string, number>;
    };
    out.push(
      '',
      `## Concurrent mixed load (${CONCURRENCY} workers)`,
      '',
      '| Mode | Req/s | p50 | p95 | p99 | Statements/req | PG tuples returned/req | PG tuples fetched/req | PG buffer hits/req |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
      ...[
        ['Database only', c1],
        ['Cache enabled', c2],
      ].map(
        ([label, c]) =>
          `| ${label} | ${f((c as typeof c1).rps)} | ${f((c as typeof c1).p50)} | ${f((c as typeof c1).p95)} | ${f((c as typeof c1).p99)} | ${(c as typeof c1).statementsPerRequest.toFixed(1)} | ${f((c as typeof c1).pgPerRequest.returned!)} | ${f((c as typeof c1).pgPerRequest.fetched!)} | ${f((c as typeof c1).pgPerRequest.hit!)} |`,
      ),
      '',
      '## Cache',
      '',
      `- Hit ratio over the cache-enabled run (warm-up included): ${(cached.cache as { hitRatio: number }).hitRatio} ` +
        `(${(cached.cache as { hits: number }).hits} hits, ${(cached.cache as { misses: number }).misses} misses, ${(cached.cache as { coalesced: number }).coalesced} coalesced, ${(cached.cache as { fallbacks: number }).fallbacks} fallbacks).`,
      `- Redis memory for all cache keys after the run: ${(cached.memory as { bytes: number }).bytes} bytes in ${(cached.memory as { keys: number }).keys} keys (MEMORY USAGE).`,
      '- PostgreSQL figures are `pg_stat_database` deltas for the test database divided by requests; they include other activity on that database during the run (none expected).',
    );
    expect(c2.statementsPerRequest).toBeLessThan(c1.statementsPerRequest);
  });

  (ROUNDS > 0 ? it : it.skip)('interleaved throughput rounds (A/B/B/A)', async () => {
    const order: ('database' | 'cache')[] = [];
    for (let r = 0; r < ROUNDS; r++)
      order.push(
        ...(r % 2 === 0 ? (['database', 'cache'] as const) : (['cache', 'database'] as const)),
      );
    const samples: { mode: string; rps: number; p50: number; p95: number; statements: number }[] =
      [];
    for (const mode of order) {
      const r = (await run(mode)).concurrent as Record<string, number>;
      samples.push({
        mode,
        rps: r.rps!,
        p50: r.p50!,
        p95: r.p95!,
        statements: r.statementsPerRequest!,
      });
    }
    const median = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
    };
    const by = (mode: string) => samples.filter((s) => s.mode === mode);
    out.push(
      '# Phase 4 cache throughput — interleaved rounds (measured)',
      '',
      `Machine: ${cpus()[0]?.model ?? 'unknown CPU'}, ${cpus().length} logical CPUs, ${(totalmem() / 2 ** 30).toFixed(0)} GiB RAM. ` +
        `${ROUNDS} rounds, order A/B then B/A alternating; each sample is a fresh app, ${CONCURRENCY} workers × ${PER_WORKER} requests over the four cached endpoints. Run ${new Date().toISOString()}.`,
      '',
      '| # | Mode | Req/s | p50 ms | p95 ms | Statements/req |',
      '|---:|---|---:|---:|---:|---:|',
      ...samples.map(
        (s, i) =>
          `| ${i + 1} | ${s.mode} | ${f(s.rps)} | ${f(s.p50)} | ${f(s.p95)} | ${s.statements.toFixed(1)} |`,
      ),
      '',
      '| Mode | Median req/s | Min | Max | Median p95 ms |',
      '|---|---:|---:|---:|---:|',
      ...['database', 'cache'].map((m) => {
        const rps = by(m).map((s) => s.rps);
        return `| ${m} | ${f(median(rps))} | ${f(Math.min(...rps))} | ${f(Math.max(...rps))} | ${f(median(by(m).map((s) => s.p95)))} |`;
      }),
    );
    expect(samples).toHaveLength(ROUNDS * 2);
  });
});
