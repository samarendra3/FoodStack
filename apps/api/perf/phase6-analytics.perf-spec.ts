import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { Db } from '../src/core/db/db-context';
import { PasswordHasher } from '../src/core/security/password-hasher';
import { buildTenantAccess } from '../src/modules/auth/access';
import { resolveScope } from '../src/modules/analytics/analytics-scope';
import * as Q from '../src/modules/analytics/analytics.queries';
import type { AnalyticsQuery } from '../src/modules/analytics/analytics.schemas';
import { CacheService } from '../src/shared/cache/cache.service';
import { connect } from '../integration/helpers';

/**
 * Phase 6 benchmark (separate *_test database; never the dev API on :4000).
 * Results: perf/results/phase6-analytics.md (+ .json).
 *
 * Data per step (cumulative): orders over the last 365 days across 3 branches, 2 lines each,
 * 90% completed / 5% cancelled / 5% open, 20% with an identified customer, one payment per
 * completed order (cash/card/upi), 2% of payments half-refunded a day later.
 *
 * Measured per step:
 * - every analytics statement: EXPLAIN (ANALYZE, BUFFERS) run as the API role under RLS —
 *   execution time, rows read by scan nodes, shared buffers, indexes used;
 * - endpoints: sequential latency with the cache off vs on, plus a concurrent run;
 * - PostgreSQL container CPU time (cgroup cpu.stat) during the concurrent runs;
 * - cache hit ratio from CacheService metrics.
 */

const SIZES = (process.env.PHASE6_SIZES ?? '1000,10000,100000,1000000').split(',').map(Number);
const OUT = process.env.PHASE6_OUT ?? 'phase6-analytics';
const PASSWORD = 'Correct-Horse-42';
// Seeding 1M orders alone takes ~20 min on a laptop.
jest.setTimeout(4 * 3600 * 1000);
const API = '/api/v1';
const SEQ = 20;
const CONCURRENCY = 20;
const PER_WORKER = 5;
const ITEMS = 100;
const CUSTOMERS = 50_000;
const BATCH = 50_000;
const PG_CONTAINER = process.env.PHASE6_PG_CONTAINER ?? 'foodstack-postgres-1';

const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;
const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
const stats = (times: number[]) => {
  const s = [...times].sort((a, b) => a - b);
  return { p50: pct(s, 0.5), p95: pct(s, 0.95), max: s.at(-1)! };
};
const f1 = (n: number) => n.toFixed(1);
const fmtN = (n: number) => n.toLocaleString('en-US');

type Plan = Record<string, unknown> & { Plans?: Plan[] };
function walk(plan: Plan, out: { rows: number; indexes: Set<string>; seq: Set<string> }) {
  const type = String(plan['Node Type']);
  if (type.includes('Scan')) {
    out.rows += Number(plan['Actual Rows'] ?? 0) * Number(plan['Actual Loops'] ?? 1);
    if (plan['Index Name']) out.indexes.add(String(plan['Index Name']));
    if (type === 'Seq Scan') out.seq.add(String(plan['Relation Name']));
  }
  for (const child of plan.Plans ?? []) walk(child, out);
}

function pgCpuUsec(): number | null {
  try {
    const out = execFileSync('docker', ['exec', PG_CONTAINER, 'cat', '/sys/fs/cgroup/cpu.stat'], {
      encoding: 'utf8',
    });
    const m = /usage_usec (\d+)/.exec(out);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

describe('Phase 6 analytics benchmark', () => {
  let migrator: DataSource;
  let appDs: DataSource;
  let tenantId = '';
  let restaurantId = '';
  let branches: string[] = [];
  let email = '';
  let seeded = 0;
  const out: string[] = [];
  const results: Record<string, unknown> = {};

  beforeAll(async () => {
    migrator = await connect('migration');
    await migrator.runMigrations({ transaction: 'each' });
    appDs = await connect('app');
    const hash = await new PasswordHasher().hash(PASSWORD);
    const [t] = await migrator.query(
      `INSERT INTO tenants (slug, name) VALUES ($1, 'bench6') RETURNING id`,
      [`bench6-${suffix()}`],
    );
    tenantId = t.id;
    const [r] = await migrator.query(
      `INSERT INTO restaurants (tenant_id, name, slug, currency_code, country_code, timezone)
       VALUES ($1, 'Bench Analytics', $2, 'INR', 'IN', 'Asia/Kolkata') RETURNING id`,
      [tenantId, `bench6-${suffix()}`],
    );
    restaurantId = r.id;
    for (const code of ['MAIN', 'EAST', 'WEST']) {
      const [b] = await migrator.query(
        `INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone, is_default)
         VALUES ($1, $2, $3, $5, 'Asia/Kolkata', $4) RETURNING id`,
        [tenantId, restaurantId, code, code === 'MAIN', code],
      );
      branches.push(b.id);
    }
    branches = branches.sort();
    email = `bench6-${suffix()}@example.test`;
    const [u] = await migrator.query(
      `INSERT INTO users (email, full_name, password_hash, email_verified_at) VALUES ($1, 'Owner', $2, now()) RETURNING id`,
      [email, hash],
    );
    const [m] = await migrator.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, status, joined_at) VALUES ($1, $2, 'active', now()) RETURNING id`,
      [tenantId, u.id],
    );
    await migrator.query(
      `INSERT INTO user_role_assignments (tenant_id, membership_id, role_id, scope_type)
       SELECT $1, $2, id, 'tenant' FROM roles WHERE tenant_id IS NULL AND code = 'owner'`,
      [tenantId, m.id],
    );
    await migrator.query(
      `INSERT INTO menu_categories (tenant_id, restaurant_id, name, sort_order)
       SELECT $1, $2, 'Category ' || g, g FROM generate_series(1, 10) g`,
      [tenantId, restaurantId],
    );
    await migrator.query(
      `INSERT INTO menu_items (tenant_id, restaurant_id, category_id, name, price_minor, currency_code, diet, is_available, sort_order)
       SELECT $1, $2, c.id, c.name || ' item ' || g, 10000 + (c.sort_order * 10 + g) * 500, 'INR', 'veg', true, g
         FROM menu_categories c, generate_series(0, 9) g WHERE c.restaurant_id = $2`,
      [tenantId, restaurantId],
    );
    await migrator.query(
      `INSERT INTO customers (tenant_id, name, phone)
       SELECT $1, 'Guest ' || g, '8' || lpad(g::text, 9, '0') FROM generate_series(1, $2) g`,
      [tenantId, CUSTOMERS],
    );
  });

  afterAll(async () => {
    const dir = join(__dirname, 'results');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${OUT}.md`), out.join('\n') + '\n');
    writeFileSync(join(dir, `${OUT}.json`), JSON.stringify(results, null, 2) + '\n');
    if (migrator?.isInitialized) {
      for (const table of [
        'refunds',
        'payments',
        'order_items',
        'orders',
        'customers',
        'menu_items',
        'menu_categories',
        'user_role_assignments',
      ]) {
        await migrator.transaction(async (tx) => {
          await tx.query('SET LOCAL statement_timeout = 0');
          await tx.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
        });
      }
      await migrator.query('DROP INDEX IF EXISTS bench_orders_number_idx');
      await migrator.destroy();
    }
    if (appDs?.isInitialized) await appDs.destroy();
  });

  /** Adds orders `seeded+1 .. target` (with lines, payments, refunds) in batches. */
  async function seedTo(target: number) {
    while (seeded < target) {
      await migrator.transaction(async (tx) => {
        await tx.query('SET LOCAL statement_timeout = 0');
        const from = seeded + 1;
        const to = Math.min(target, seeded + BATCH);
        await tx.query(
          `WITH items AS (
           SELECT array_agg(id ORDER BY sort_order, name) AS ids, array_agg(price_minor ORDER BY sort_order, name) AS prices
             FROM menu_items WHERE restaurant_id = $2),
         cust AS (SELECT array_agg(id ORDER BY phone) AS ids FROM customers WHERE tenant_id = $1),
         g AS (
           SELECT g,
                  now() - (((g::bigint * 7919) % 525600) || ' minutes')::interval AS ts,
                  (ARRAY['dine_in','dine_in','takeaway','delivery','qr'])[1 + g % 5] AS channel,
                  CASE WHEN g % 20 = 0 THEN 'cancelled' WHEN g % 20 = 1 THEN 'open' ELSE 'completed' END AS status,
                  1 + g % 3 AS q1, 1 + (g / 3) % 2 AS q2,
                  1 + g % ${ITEMS} AS i1, 1 + (g * 7 + 3) % ${ITEMS} AS i2
             FROM generate_series($4::int, $5::int) g),
         x AS (
           SELECT g.*, g.q1 * items.prices[g.i1] + g.q2 * items.prices[g.i2] AS sub,
                  CASE WHEN g.g % 5 = 0 THEN cust.ids[1 + (g.g / 5) % ${CUSTOMERS}] END AS customer_id
             FROM g, items, cust)
         INSERT INTO orders (tenant_id, restaurant_id, branch_id, order_number, channel, status, kitchen_status,
                             table_label, customer_id, currency_code, tax_rate_bp, subtotal_minor, discount_minor,
                             tax_minor, total_minor, paid_minor, refunded_minor, created_at, completed_at,
                             cancelled_at, cancel_reason)
         SELECT $1, $2, ($3::uuid[])[1 + x.g % 3], x.g, x.channel, x.status,
                CASE x.status WHEN 'open' THEN 'preparing' WHEN 'cancelled' THEN 'new' ELSE 'served' END,
                CASE WHEN x.channel = 'dine_in' THEN 'T' || (x.g % 20) END, x.customer_id, 'INR', 500,
                x.sub, (x.sub / 10) * (x.g % 4 = 0)::int,
                round((x.sub - (x.sub / 10) * (x.g % 4 = 0)::int) * 0.05),
                x.sub - (x.sub / 10) * (x.g % 4 = 0)::int + round((x.sub - (x.sub / 10) * (x.g % 4 = 0)::int) * 0.05),
                0, 0, x.ts,
                CASE WHEN x.status = 'completed' THEN x.ts + interval '20 minutes' END,
                CASE WHEN x.status = 'cancelled' THEN x.ts END,
                CASE WHEN x.status = 'cancelled' THEN 'bench' END
           FROM x`,
          [tenantId, restaurantId, branches, from, to],
        );
        await tx.query(
          `WITH items AS (
           SELECT array_agg(id ORDER BY sort_order, name) AS ids, array_agg(price_minor ORDER BY sort_order, name) AS prices,
                  array_agg(category_id ORDER BY sort_order, name) AS cats, array_agg(name ORDER BY sort_order, name) AS names
             FROM menu_items WHERE restaurant_id = $2)
         INSERT INTO order_items (tenant_id, order_id, menu_item_id, category_id, name, unit_price_minor, quantity,
                                  line_total_minor, discount_minor, created_at)
         SELECT $1, o.id, items.ids[l.i], items.cats[l.i], items.names[l.i], items.prices[l.i], l.q,
                items.prices[l.i] * l.q,
                CASE WHEN o.discount_minor > 0 THEN (items.prices[l.i] * l.q) / 10 ELSE 0 END, o.created_at
           FROM orders o, items,
                LATERAL (VALUES (1 + o.order_number % ${ITEMS}, 1 + o.order_number % 3),
                                (1 + (o.order_number * 7 + 3) % ${ITEMS}, 1 + (o.order_number / 3) % 2)) l(i, q)
          WHERE o.tenant_id = $1 AND o.order_number BETWEEN $3 AND $4`,
          [tenantId, restaurantId, from, to],
        );
        await tx.query(
          `UPDATE orders SET paid_minor = total_minor
          WHERE tenant_id = $1 AND status = 'completed' AND order_number BETWEEN $2 AND $3`,
          [tenantId, from, to],
        );
        await tx.query(
          `INSERT INTO payments (tenant_id, order_id, branch_id, method, amount_minor, refunded_minor, created_at)
         SELECT $1, o.id, o.branch_id, (ARRAY['cash','card','upi'])[1 + o.order_number % 3], o.total_minor,
                CASE WHEN o.order_number % 50 = 2 THEN o.total_minor / 2 ELSE 0 END, o.completed_at
           FROM orders o
          WHERE o.tenant_id = $1 AND o.status = 'completed' AND o.order_number BETWEEN $2 AND $3`,
          [tenantId, from, to],
        );
        await tx.query(
          `INSERT INTO refunds (tenant_id, payment_id, order_id, amount_minor, reason, created_at)
         SELECT $1, p.id, p.order_id, p.refunded_minor, 'bench', least(p.created_at + interval '1 day', now())
           FROM payments p JOIN orders o ON o.id = p.order_id
          WHERE p.tenant_id = $1 AND p.refunded_minor > 0 AND o.order_number BETWEEN $2 AND $3`,
          [tenantId, from, to],
        );
        await tx.query(
          `UPDATE orders o SET refunded_minor = p.refunded_minor FROM payments p
          WHERE p.order_id = o.id AND p.refunded_minor > 0 AND o.tenant_id = $1 AND o.order_number BETWEEN $2 AND $3`,
          [tenantId, from, to],
        );
        seeded = to;
      });
    }
    for (const t of ['orders', 'order_items', 'payments', 'refunds', 'customers']) {
      await migrator.query(`VACUUM ANALYZE ${t}`);
    }
  }

  /** EXPLAIN ANALYZE every analytics statement as the API role, under RLS. */
  async function explainAll(preset: AnalyticsQuery['preset']) {
    const runner = appDs.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const db = new Db(runner);
      await db.setScope({ tenantId });
      const allBranches = (
        await db.query<{ id: string; name: string; code: string; restaurant_id: string }>(
          'SELECT id, name, code, restaurant_id FROM branches',
        )
      ).map((b) => ({ id: b.id, name: b.name, code: b.code, restaurantId: b.restaurant_id }));
      const access = buildTenantAccess(
        [
          { role: 'owner', scopeType: 'tenant', scopeId: null, permissions: ['report:view'] },
        ] as never,
        allBranches,
      );
      const scope = await resolveScope(db, access, { preset } as AnalyticsQuery);
      const plans: { sql: string; plan: Plan; ms: number }[] = [];
      const explaining = {
        query: async (sql: string, params: unknown[] = []) => {
          const [row] = await runner.query(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
            params,
          );
          const root = (row['QUERY PLAN'] as { Plan: Plan; 'Execution Time': number }[])[0]!;
          plans.push({ sql, plan: root.Plan, ms: root['Execution Time'] });
          return [];
        },
        one: async (sql: string, params: unknown[] = []) => {
          await explaining.query(sql, params);
          return undefined;
        },
      } as unknown as Db;
      const named: [string, () => Promise<unknown>][] = [
        ['sales', () => Q.salesQuery(explaining, scope)],
        ['orders', () => Q.ordersQuery(explaining, scope)],
        ['payments', () => Q.paymentsQuery(explaining, scope)],
        ['refunds', () => Q.refundsQuery(explaining, scope)],
        ['activeTables', () => Q.activeTablesQuery(explaining, scope)],
        ['customers', () => Q.customersQuery(explaining, scope)],
        ['itemSales', () => Q.itemSalesQuery(explaining, scope)],
        ['trend', () => Q.trendQuery(explaining, scope)],
      ];
      const rows: Record<string, unknown>[] = [];
      for (const [name, run] of named) {
        plans.length = 0;
        await run();
        const p = plans[0]!;
        const acc = { rows: 0, indexes: new Set<string>(), seq: new Set<string>() };
        walk(p.plan, acc);
        rows.push({
          name,
          ms: p.ms,
          rowsScanned: acc.rows,
          sharedHit: Number(p.plan['Shared Hit Blocks'] ?? 0),
          sharedRead: Number(p.plan['Shared Read Blocks'] ?? 0),
          indexes: [...acc.indexes].sort(),
          seqScans: [...acc.seq].sort(),
        });
      }
      return rows;
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  }

  async function boot(cacheEnabled: boolean) {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: ['error'] });
    configureApp(app);
    await app.init();
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

  const ENDPOINTS = [
    '/analytics/summary',
    '/analytics/trend',
    '/analytics/menu',
    '/analytics/customers',
  ];

  async function apiRun(app: NestExpressApplication, token: string, preset: string) {
    const server = app.getHttpServer();
    // Failures are counted and reported (status + error code), not hidden or retried.
    const errors: Record<string, number> = {};
    const hit = async (path: string) => {
      const t0 = performance.now();
      const res = await request(server)
        .get(`${API}${path}?preset=${preset}`)
        .set('X-Forwarded-For', freshIp())
        .set('Authorization', `Bearer ${token}`);
      if (res.status !== 200) {
        const key =
          `${res.status} ${res.body?.error?.code ?? res.body?.code ?? ''} ${String(res.body?.error?.message ?? res.body?.message ?? '').slice(0, 80)}`.trim();
        errors[key] = (errors[key] ?? 0) + 1;
      }
      return performance.now() - t0;
    };
    const seq: Record<string, ReturnType<typeof stats> & { first: number }> = {};
    for (const path of ENDPOINTS) {
      const first = await hit(path);
      const times: number[] = [];
      for (let i = 0; i < SEQ; i++) times.push(await hit(path));
      seq[path] = { first, ...stats(times) };
    }
    // Concurrent users each loading the whole dashboard (4 calls) PER_WORKER times.
    const cpu0 = pgCpuUsec();
    const t0 = performance.now();
    const times: number[] = [];
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        for (let i = 0; i < PER_WORKER; i++) {
          const s = performance.now();
          await Promise.all(ENDPOINTS.map(hit));
          times.push(performance.now() - s);
        }
      }),
    );
    const wall = performance.now() - t0;
    const cpu1 = pgCpuUsec();
    return {
      seq,
      concurrent: {
        users: CONCURRENCY,
        dashboards: CONCURRENCY * PER_WORKER,
        wallMs: wall,
        dashboardsPerSec: (CONCURRENCY * PER_WORKER) / (wall / 1000),
        ...stats(times),
        pgCpuSeconds: cpu0 !== null && cpu1 !== null ? (cpu1 - cpu0) / 1e6 : null,
      },
      errors,
    };
  }

  it('measures analytics at each dataset size', async () => {
    out.push('# Phase 6 — Analytics benchmark', '');
    out.push(
      `Generated by \`apps/api/perf/phase6-analytics.perf-spec.ts\` on ${new Date().toISOString()}.`,
      `Machine: ${cpus().length}× ${cpus()[0]?.model.trim()}, ${Math.round(totalmem() / 2 ** 30)} GiB RAM. ` +
        'PostgreSQL 18 and Redis 8 in local Docker containers; API in-process (Nest test app).',
      'Database: `foodstack_test` (the dev API on :4000 and its database are not touched).',
      '',
      'Dataset per step (cumulative): orders over the past 365 days across 3 branches, 2 lines each, ' +
        '90% completed / 5% cancelled / 5% open, 20% with a customer (pool of 50,000), one payment per ' +
        'completed order, 2% of payments half-refunded a day later.',
      '',
    );
    for (const size of SIZES) {
      const t0 = performance.now();
      // Bench-only lookup index so seeding batches find their own rows; dropped before measuring.
      await migrator.transaction(async (tx) => {
        await tx.query('SET LOCAL statement_timeout = 0');
        await tx.query(
          'CREATE INDEX IF NOT EXISTS bench_orders_number_idx ON orders (tenant_id, order_number)',
        );
      });
      await seedTo(size);
      await migrator.query('DROP INDEX IF EXISTS bench_orders_number_idx');
      const seedS = (performance.now() - t0) / 1000;
      const [counts] = await migrator.query(
        `SELECT (SELECT count(*) FROM orders WHERE tenant_id = $1) AS orders,
                (SELECT count(*) FROM order_items WHERE tenant_id = $1) AS items,
                (SELECT count(*) FROM payments WHERE tenant_id = $1) AS payments,
                (SELECT count(*) FROM refunds WHERE tenant_id = $1) AS refunds`,
        [tenantId],
      );
      const step: Record<string, unknown> = { counts, seedSeconds: seedS };
      out.push(
        `## ${fmtN(size)} orders`,
        '',
        `Rows: ${fmtN(Number(counts.orders))} orders, ${fmtN(Number(counts.items))} order items, ` +
          `${fmtN(Number(counts.payments))} payments, ${fmtN(Number(counts.refunds))} refunds (seeded in ${f1(seedS)} s).`,
        '',
      );

      for (const preset of ['last30', 'thisYear'] as const) {
        const rows = await explainAll(preset);
        step[`explain_${preset}`] = rows;
        out.push(
          `### SQL — \`${preset}\`, all 3 branches (EXPLAIN ANALYZE, API role, RLS on)`,
          '',
          '| Statement | Execution ms | Rows read by scans | Shared hit / read blocks | Indexes | Seq scans |',
          '|---|---:|---:|---:|---|---|',
          ...rows.map(
            (r) =>
              `| ${r.name} | ${f1(r.ms as number)} | ${fmtN(r.rowsScanned as number)} | ${fmtN(r.sharedHit as number)} / ${fmtN(r.sharedRead as number)} | ${(r.indexes as string[]).join(', ') || '—'} | ${(r.seqScans as string[]).join(', ') || '—'} |`,
          ),
          '',
        );
      }

      const api: Record<string, unknown> = {};
      for (const mode of ['database', 'cache'] as const) {
        const { app, token } = await boot(mode === 'cache');
        try {
          const cache = app.get(CacheService);
          api[mode] = await apiRun(app, token, 'last30');
          const snap = cache.metrics.snapshot();
          api[`${mode}_metrics`] = snap.totals;
        } finally {
          await app.close();
        }
      }
      step.api = api;
      const db = api.database as Awaited<ReturnType<typeof apiRun>>;
      const ca = api.cache as Awaited<ReturnType<typeof apiRun>>;
      const totals = api.cache_metrics as { hits: number; misses: number };
      out.push(
        '### API — `preset=last30`, owner, all branches',
        '',
        `Sequential: first call, then ${SEQ} repeats (ms). Cache off = CACHE_ENABLED=false (PostgreSQL every time).`,
        '',
        '| Endpoint | Cache off first | off p50 | off p95 | Cache on first (miss) | on p50 | on p95 |',
        '|---|---:|---:|---:|---:|---:|---:|',
        ...ENDPOINTS.map((e) => {
          const a = db.seq[e]!;
          const b = ca.seq[e]!;
          return `| ${e} | ${f1(a.first)} | ${f1(a.p50)} | ${f1(a.p95)} | ${f1(b.first)} | ${f1(b.p50)} | ${f1(b.p95)} |`;
        }),
        '',
        `Concurrent: ${CONCURRENCY} users × ${PER_WORKER} full dashboards (4 parallel calls each).`,
        '',
        '| Mode | Wall s | Dashboards/s | Dashboard p50 ms | p95 ms | PostgreSQL CPU s |',
        '|---|---:|---:|---:|---:|---:|',
        ...(
          [
            ['Cache off', db],
            ['Cache on', ca],
          ] as const
        ).map(
          ([label, r]) =>
            `| ${label} | ${f1(r.concurrent.wallMs / 1000)} | ${f1(r.concurrent.dashboardsPerSec)} | ${f1(r.concurrent.p50)} | ${f1(r.concurrent.p95)} | ${r.concurrent.pgCpuSeconds === null ? 'not measured' : r.concurrent.pgCpuSeconds.toFixed(2)} |`,
        ),
        '',
        `Cache on: ${fmtN(totals.hits)} hits / ${fmtN(totals.misses)} misses → hit ratio ` +
          `${f1((100 * totals.hits) / Math.max(1, totals.hits + totals.misses))}% (no writes during the run).`,
        '',
        `Failed requests — cache off: ${JSON.stringify(db.errors)}; cache on: ${JSON.stringify(ca.errors)}.`,
        '',
      );
      results[String(size)] = step;
    }

    // Covering order_items index from the audit: measured, not assumed.
    const before = (await explainAll('thisYear')).find((r) => r.name === 'itemSales')!;
    await migrator.query(
      `CREATE INDEX bench_order_items_cover ON order_items (tenant_id, order_id)
         INCLUDE (menu_item_id, category_id, quantity, line_total_minor, discount_minor) WHERE status = 'active'`,
    );
    await migrator.query('VACUUM ANALYZE order_items');
    const after = (await explainAll('thisYear')).find((r) => r.name === 'itemSales')!;
    await migrator.query('DROP INDEX bench_order_items_cover');
    results.coveringIndex = { before, after };
    out.push(
      `## Candidate index: covering \`order_items\` (at ${fmtN(seeded)} orders, \`thisYear\`)`,
      '',
      '| Variant | itemSales ms | Rows read | Shared hit / read |',
      '|---|---:|---:|---:|',
      `| Existing order_items_order_idx | ${f1(before.ms as number)} | ${fmtN(before.rowsScanned as number)} | ${fmtN(before.sharedHit as number)} / ${fmtN(before.sharedRead as number)} |`,
      `| + covering partial index | ${f1(after.ms as number)} | ${fmtN(after.rowsScanned as number)} | ${fmtN(after.sharedHit as number)} / ${fmtN(after.sharedRead as number)} |`,
      '',
    );
    expect(seeded).toBe(SIZES.at(-1));
  });
});
