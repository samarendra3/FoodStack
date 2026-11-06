import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import { connect } from '../integration/helpers';

/**
 * Phase 2 query plans (docs/PHASE_2_PERFORMANCE_REPORT.md). Seeds one large restaurant into the
 * *_test database (never a real one: setup-env refuses other names), then records
 * EXPLAIN (ANALYZE, BUFFERS) for the old and new form of each optimized query, as the app role
 * under row-level security, exactly as requests run them.
 *
 *   PERF_ORDERS=200000 pnpm test:perf        (default 200,000 orders, one month)
 *
 * The seed is reused across runs (tenant slug "perf-bench"); delete it to reseed.
 * Results: perf/results/phase2-plans.md
 */

const ORDERS = Number(process.env.PERF_ORDERS ?? 200_000);
const RUNS = 5;

describe('Phase 2 query plans', () => {
  let migrator: DataSource;
  let appDb: DataSource;
  let tenantId: string;
  let branchId: string;
  const out: string[] = [];

  beforeAll(async () => {
    migrator = await connect('migration');
    await migrator.runMigrations({ transaction: 'each' });
    appDb = await connect('app');
    await seed();
    await migrator.query('ANALYZE orders; ANALYZE order_items; ANALYZE tenant_usage_counters');
  });

  afterAll(async () => {
    const dir = join(__dirname, 'results');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'phase2-plans.md'), out.join('\n'));
    await appDb?.destroy();
    await migrator?.destroy();
  });

  /** Creates the bench restaurant once; resumable (reuses what exists, fills what is missing). */
  async function seed() {
    const [existing] = await migrator.query(`SELECT id FROM tenants WHERE slug = 'perf-bench'`);
    tenantId =
      existing?.id ??
      (
        await migrator.query(
          `INSERT INTO tenants (slug, name) VALUES ('perf-bench', 'Perf Bench') RETURNING id`,
        )
      )[0].id;
    const [rest] = await migrator.query(`SELECT id FROM restaurants WHERE tenant_id = $1`, [
      tenantId,
    ]);
    const restaurantId =
      rest?.id ??
      (
        await migrator.query(
          `INSERT INTO restaurants (tenant_id, name, slug, currency_code, country_code, timezone)
           VALUES ($1, 'Perf Bench', 'perf-bench', 'INR', 'IN', 'Asia/Kolkata') RETURNING id`,
          [tenantId],
        )
      )[0].id;
    const [br] = await migrator.query(
      `SELECT id FROM branches WHERE tenant_id = $1 AND code = 'MAIN'`,
      [tenantId],
    );
    branchId =
      br?.id ??
      (
        await migrator.query(
          `INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone, is_default)
           VALUES ($1, $2, 'MAIN', 'Main', 'Asia/Kolkata', true) RETURNING id`,
          [tenantId, restaurantId],
        )
      )[0].id;
    const [{ n }] = await migrator.query(
      `SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1`,
      [tenantId],
    );
    if (n > 0) return;
    // Bulk seed: no statement timeout inside this one transaction.
    await migrator.transaction(async (m) => {
      await m.query('SET LOCAL statement_timeout = 0');
      // ORDERS orders spread over the last 30 days (≈ one busy month); 3 % cancelled, 20 % open.
      await m.query(
        `INSERT INTO orders (tenant_id, restaurant_id, branch_id, order_number, channel, status,
                           currency_code, tax_rate_bp, subtotal_minor, discount_minor, tax_minor,
                           total_minor, created_at, completed_at, cancelled_at)
       SELECT $1, $2, $3, g, (ARRAY['dine_in','takeaway','delivery'])[1 + g % 3], st,
              'INR', 500, 50000, 0, 2500, 52500, ts,
              CASE WHEN st = 'completed' THEN ts + interval '20 minutes' END,
              CASE WHEN st = 'cancelled' THEN ts + interval '5 minutes' END
         FROM generate_series(1, $4::int) g,
              LATERAL (SELECT CASE WHEN g % 33 = 0 THEN 'cancelled' WHEN g % 5 = 0 THEN 'open'
                                   ELSE 'completed' END AS st,
                              now() - (g::double precision / $4) * interval '30 days' AS ts) x`,
        [tenantId, restaurantId, branchId, ORDERS],
      );
      await m.query(
        `INSERT INTO tenant_usage_counters (tenant_id, restaurant_id, period, orders)
       SELECT tenant_id, restaurant_id, date_trunc('month', created_at AT TIME ZONE 'Asia/Kolkata')::date, count(*)
         FROM orders WHERE tenant_id = $1 AND status <> 'cancelled' GROUP BY 1, 2, 3
       ON CONFLICT (tenant_id, restaurant_id, period) DO UPDATE SET orders = EXCLUDED.orders`,
        [tenantId],
      );
    });
  }

  /** Runs `sql` RUNS times as the app role in the tenant scope; keeps the median plan. */
  async function plan(title: string, sql: string, params: unknown[] = []) {
    const runs: { ms: number; text: string }[] = [];
    for (let i = 0; i < RUNS; i++) {
      const qr = appDb.createQueryRunner();
      await qr.startTransaction();
      try {
        await qr.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
        const rows: { 'QUERY PLAN': string }[] = await qr.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`,
          params,
        );
        const text = rows.map((r) => r['QUERY PLAN']).join('\n');
        const ms = Number(/Execution Time: ([\d.]+) ms/.exec(text)?.[1] ?? NaN);
        runs.push({ ms, text });
      } finally {
        await qr.rollbackTransaction(); // writes in plans (upserts) are never kept
        await qr.release();
      }
    }
    runs.sort((a, b) => a.ms - b.ms);
    const median = runs[Math.floor(RUNS / 2)]!;
    out.push(
      `### ${title}`,
      '',
      `Median execution time over ${RUNS} runs: **${median.ms} ms**`,
      '',
      '```',
      median.text,
      '```',
      '',
    );
    return median.ms;
  }

  it('records plans for the old and new forms of each Phase 2 query', async () => {
    out.push(
      `# Phase 2 query plans (measured)`,
      '',
      `Data: one restaurant, one branch, ${ORDERS.toLocaleString('en-IN')} orders over 30 days (3 % cancelled), ` +
        `PostgreSQL test database, app role under RLS, ${RUNS} runs each (median shown). Warm cache.`,
      '',
    );

    // F1 — monthly order limit.
    const oldCount = await plan(
      "F1 before — count this month's orders (ran on every order creation)",
      `SELECT count(*) FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
        WHERE o.status <> 'cancelled'
          AND o.created_at >= date_trunc('month', now() AT TIME ZONE r.timezone) AT TIME ZONE r.timezone`,
    );
    const newReserve = await plan(
      'F1 after — per-restaurant counter reservation with the account-wide limit (rolled back)',
      `WITH used AS (SELECT coalesce(sum(c.orders), 0)::int AS n
                       FROM restaurants r JOIN tenant_usage_counters c
                         ON c.tenant_id = r.tenant_id AND c.restaurant_id = r.id
                        AND c.period = date_trunc('month', now() AT TIME ZONE r.timezone)::date)
       INSERT INTO tenant_usage_counters AS c (tenant_id, restaurant_id, period, orders)
       SELECT $1, r.id, date_trunc('month', now() AT TIME ZONE r.timezone)::date, 1
         FROM branches b JOIN restaurants r ON r.id = b.restaurant_id
        WHERE b.id = $2 AND ($3::int IS NULL OR (SELECT n FROM used) + 1 <= $3::int)
       ON CONFLICT (tenant_id, restaurant_id, period) DO UPDATE
         SET orders = c.orders + EXCLUDED.orders, updated_at = now()
       RETURNING c.orders`,
      [tenantId, branchId, 1_000_000],
    );

    // F4 — orders list for one local day.
    const day = (
      await migrator.query(
        `SELECT to_char((now() - interval '10 days') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS d`,
      )
    )[0].d as string;
    const list = (dateWhere: string) =>
      `SELECT o.id, o.order_number, o.status, o.total_minor, o.created_at, b.name
         FROM orders o JOIN branches b ON b.id = o.branch_id
        WHERE o.branch_id = ANY($1::uuid[]) AND ${dateWhere}
        ORDER BY o.created_at DESC, o.id DESC LIMIT 25`;
    const oldDay = await plan(
      'F4 before — one-day filter converting every row',
      list(
        `(o.created_at AT TIME ZONE b.timezone)::date >= $2::date AND (o.created_at AT TIME ZONE b.timezone)::date <= $3::date`,
      ),
      [[branchId], day, day],
    );
    const newDay = await plan(
      'F4 after — one-day filter on local-day bounds',
      list(
        `o.created_at >= ($2::date::timestamp AT TIME ZONE b.timezone) AND o.created_at >= (SELECT min($2::date::timestamp AT TIME ZONE tz.timezone) FROM branches tz WHERE tz.id = ANY($1::uuid[])) AND o.created_at < (($3::date + 1)::timestamp AT TIME ZONE b.timezone) AND o.created_at < (SELECT max(($3::date + 1)::timestamp AT TIME ZONE tz.timezone) FROM branches tz WHERE tz.id = ANY($1::uuid[]))`,
      ),
      [[branchId], day, day],
    );
    const countWhere = (dateWhere: string) =>
      `SELECT count(*) FROM orders o JOIN branches b ON b.id = o.branch_id WHERE o.branch_id = ANY($1::uuid[]) AND ${dateWhere}`;
    const oldDayCount = await plan(
      'F4 before — page total for the one-day filter',
      countWhere(
        `(o.created_at AT TIME ZONE b.timezone)::date >= $2::date AND (o.created_at AT TIME ZONE b.timezone)::date <= $3::date`,
      ),
      [[branchId], day, day],
    );
    const newDayCount = await plan(
      'F4 after — page total for the one-day filter',
      countWhere(
        `o.created_at >= ($2::date::timestamp AT TIME ZONE b.timezone) AND o.created_at >= (SELECT min($2::date::timestamp AT TIME ZONE tz.timezone) FROM branches tz WHERE tz.id = ANY($1::uuid[])) AND o.created_at < (($3::date + 1)::timestamp AT TIME ZONE b.timezone) AND o.created_at < (SELECT max(($3::date + 1)::timestamp AT TIME ZONE tz.timezone) FROM branches tz WHERE tz.id = ANY($1::uuid[]))`,
      ),
      [[branchId], day, day],
    );

    out.push(
      '## Summary (median ms)',
      '',
      '| Query | Before | After |',
      '|---|---:|---:|',
      `| F1 order-limit check per order | ${oldCount} | ${newReserve} |`,
      `| F4 one-day orders page (25 rows) | ${oldDay} | ${newDay} |`,
      `| F4 one-day page total (count) | ${oldDayCount} | ${newDayCount} |`,
      '',
    );
    console.warn(out.slice(-8).join('\n'));
    expect(newReserve).toBeLessThan(oldCount);
    expect(newDayCount).toBeLessThan(oldDayCount);
    expect(newDay).toBeLessThan(oldDay);
  });
});
