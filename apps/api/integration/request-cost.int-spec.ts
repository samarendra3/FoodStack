import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
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
import { AccessService } from '../src/modules/auth/access.service';
import { connect } from './helpers';

/**
 * Phase 3 measurement and regression guard (docs/PHASE_3_PERFORMANCE_REPORT.md): SQL statements
 * and transactions per API request, permission-lookup count and time, and usage-endpoint latency.
 * Counts come from wrapping the one database entry point (Db.query / Db.setScope), so every
 * statement a request runs is seen. Results: perf/results/phase3-request-cost.md
 */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;
const RUNS = 15;

describe('Request cost (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  const tenants: string[] = [];
  let token = '';
  let branch = '';
  const lines: string[] = [];
  let statements = 0;
  let transactions = 0;
  let accessCalls = 0;
  let accessMs = 0;

  const get = (url: string) =>
    request(app.getHttpServer())
      .get(`${API}${url}`)
      .set('X-Forwarded-For', freshIp())
      .set('Authorization', `Bearer ${token}`);

  /** Statements, transactions and permission look-ups for one request (median latency). */
  async function measure(url: string) {
    await get(url).expect(200); // warm-up
    const times: number[] = [];
    let s = 0;
    let t = 0;
    let a = 0;
    let am = 0;
    for (let i = 0; i < RUNS; i++) {
      statements = transactions = accessCalls = 0;
      accessMs = 0;
      const start = performance.now();
      await get(url).expect(200);
      times.push(performance.now() - start);
      s = statements;
      t = transactions;
      a = accessCalls;
      am += accessMs;
    }
    times.sort((x, y) => x - y);
    const median = times[Math.floor(RUNS / 2)]!;
    const p95 = times[Math.floor(RUNS * 0.95)]!;
    // A transaction is BEGIN + set_config + … + COMMIT: count BEGIN/COMMIT as statements too.
    const total = s + 2 * t;
    lines.push(
      `| \`GET ${url}\` | ${total} | ${t} | ${a} | ${(am / RUNS).toFixed(2)} | ${median.toFixed(1)} | ${p95.toFixed(1)} |`,
    );
    return { statements: total, transactions: t, accessCalls: a, median };
  }

  beforeAll(async () => {
    migrator = await connect('migration');
    await migrator.runMigrations({ transaction: 'each' });
    const hash = await new PasswordHasher().hash(PASSWORD);
    const [t] = await migrator.query(
      `INSERT INTO tenants (slug, name) VALUES ($1, 'rc') RETURNING id`,
      [`rc-${suffix()}`],
    );
    tenants.push(t.id);
    const [r] = await migrator.query(
      `INSERT INTO restaurants (tenant_id, name, slug, currency_code, country_code, timezone)
       VALUES ($1, 'rc', $2, 'INR', 'IN', 'Asia/Kolkata') RETURNING id`,
      [t.id, `rc-${suffix()}`],
    );
    branch = (
      await migrator.query(
        `INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone, is_default)
         VALUES ($1, $2, 'MAIN', 'Main', 'Asia/Kolkata', true) RETURNING id`,
        [t.id, r.id],
      )
    )[0].id;
    const email = `rc-${suffix()}@example.test`;
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

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app);
    await app.init();
    token = (
      await request(app.getHttpServer())
        .post(`${API}/auth/login`)
        .set('X-Forwarded-For', freshIp())
        .send({ email, password: PASSWORD })
        .expect(200)
    ).body.data.accessToken;
    await request(app.getHttpServer())
      .post(`${API}/menu/import`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Forwarded-For', freshIp())
      .send({ rows: [{ category: 'Drinks', name: 'Chai', priceMinor: 5000, diet: 'veg' }] })
      .expect(201);

    // Count every statement and transaction, and time permission look-ups.
    const query = Db.prototype.query;
    jest.spyOn(Db.prototype, 'query').mockImplementation(function (this: Db, ...args) {
      statements++;
      return query.apply(this, args as Parameters<typeof query>);
    });
    const setScope = Db.prototype.setScope;
    jest.spyOn(Db.prototype, 'setScope').mockImplementation(function (this: Db, ...args) {
      transactions++;
      statements++;
      return setScope.apply(this, args as Parameters<typeof setScope>);
    });
    const access = app.get(AccessService);
    const tenantAccess = access.tenantAccess.bind(access);
    jest.spyOn(access, 'tenantAccess').mockImplementation(async (...args) => {
      accessCalls++;
      const start = performance.now();
      try {
        return await tenantAccess(...args);
      } finally {
        accessMs += performance.now() - start;
      }
    });
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    const dir = join(__dirname, '..', 'perf', 'results');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'phase3-request-cost.md'),
      [
        `# Phase 3 request cost (measured, ${process.env.PHASE ?? 'current'} code)`,
        '',
        `Integration test database, one owner, ${RUNS} sequential requests after a warm-up; ` +
          'statements include BEGIN/COMMIT. Latency is end-to-end through the Nest app (supertest).',
        '',
        '| Request | SQL statements | Transactions | Permission look-ups | Look-up time (ms) | Median (ms) | p95 (ms) |',
        '|---|---:|---:|---:|---:|---:|---:|',
        ...lines,
        '',
      ].join('\n'),
    );
    await app?.close();
    if (migrator?.isInitialized) {
      for (const t of [
        'menu_item_variants',
        'menu_items',
        'menu_categories',
        'user_role_assignments',
      ]) {
        await migrator.query(`DELETE FROM ${t} WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
      }
      await migrator.destroy();
    }
  });

  it('measures statements, transactions and permission look-ups per request', async () => {
    const results = {
      orders: await measure(`/orders?branchId=${branch}&limit=25`),
      menu: await measure('/menu'),
      subscription: await measure('/billing/subscription'),
      addons: await measure('/billing/addons'),
      entitlement: await measure('/billing/entitlement'),
      usage: await measure('/billing/usage'),
    };
    console.warn(lines.join('\n'));
    // Phase 3: the guard's permission set is reused, so services never look it up again.
    for (const r of Object.values(results)) expect(r.accessCalls).toBe(1);
    // Ceilings at the measured Phase 3 counts: a regression adds statements.
    expect(results.orders.statements).toBeLessThanOrEqual(11);
    expect(results.menu.statements).toBeLessThanOrEqual(13);
    expect(results.subscription.statements).toBeLessThanOrEqual(14);
    expect(results.addons.statements).toBeLessThanOrEqual(15);
    // The banner endpoint is a fraction of the full add-ons call, with the same figures.
    expect(results.usage.statements).toBeLessThan(results.addons.statements);
    const light = (await get('/billing/usage').expect(200)).body.data.orders;
    const full = (await get('/billing/addons').expect(200)).body.data.orders;
    expect(light).toEqual(full);
  });
});
