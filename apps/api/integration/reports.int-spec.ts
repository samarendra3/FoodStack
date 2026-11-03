import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PasswordHasher } from '../src/core/security/password-hasher';
import { connect } from './helpers';

/** Inventory report: totals, valuation at current cost, date range, branch scope, isolation. */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

describe('Reports (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  const tenants: string[] = [];
  const emails: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  let main: string;
  let second: string;

  const call = (who: string, method: 'get' | 'post', url: string) =>
    request(app.getHttpServer())
      [method](`${API}${url}`)
      .set('X-Forwarded-For', freshIp())
      .set('Authorization', `Bearer ${tokens[who]}`);

  async function tenant(label: string) {
    const [t] = await migrator.query(
      `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
      [`${label}-${suffix()}`, label],
    );
    tenants.push(t.id);
    const [r] = await migrator.query(
      `INSERT INTO restaurants (tenant_id, name, slug, currency_code, country_code, timezone)
       VALUES ($1, $2, $3, 'INR', 'IN', 'Asia/Kolkata') RETURNING id`,
      [t.id, label, `${label}-${suffix()}`],
    );
    const branch = async (code: string) =>
      (
        await migrator.query(
          `INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone, is_default)
           VALUES ($1, $2, $3, $4, 'Asia/Kolkata', $5) RETURNING id`,
          [t.id, r.id, code, `${code} branch`, code === 'MAIN'],
        )
      )[0].id as string;
    return { id: t.id as string, main: await branch('MAIN'), second: await branch('SECOND') };
  }

  async function member(
    key: string,
    tenantId: string,
    role: string,
    hash: string,
    branchId?: string,
  ) {
    emails[key] = `${key}-${suffix()}@example.test`;
    const [u] = await migrator.query(
      `INSERT INTO users (email, full_name, password_hash, email_verified_at)
       VALUES ($1, $2, $3, now()) RETURNING id`,
      [emails[key], key, hash],
    );
    const [m] = await migrator.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, status, joined_at)
       VALUES ($1, $2, 'active', now()) RETURNING id`,
      [tenantId, u.id],
    );
    await migrator.query(
      `INSERT INTO user_role_assignments (tenant_id, membership_id, role_id, scope_type, scope_id)
       SELECT $1, $2, id, $4, $5 FROM roles WHERE tenant_id IS NULL AND code = $3`,
      [tenantId, m.id, role, branchId ? 'branch' : 'tenant', branchId ?? null],
    );
  }

  beforeAll(async () => {
    migrator = await connect('migration');
    await migrator.runMigrations({ transaction: 'each' });
    const hash = await new PasswordHasher().hash(PASSWORD);
    const alpha = await tenant('repalpha');
    const bravo = await tenant('repbravo');
    main = alpha.main;
    second = alpha.second;
    await member('owner', alpha.id, 'owner', hash);
    await member('manager', alpha.id, 'branch_manager', hash, alpha.main);
    await member('cashier', alpha.id, 'cashier', hash, alpha.main);
    await member('bravoOwner', bravo.id, 'owner', hash);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app);
    await app.init();
    for (const who of Object.keys(emails)) {
      const res = await request(app.getHttpServer())
        .post(`${API}/auth/login`)
        .set('X-Forwarded-For', freshIp())
        .send({ email: emails[who], password: PASSWORD })
        .expect(200);
      tokens[who] = res.body.data.accessToken as string;
    }

    // Oil at ₹150/l: buy 10, use 4, waste 1 at MAIN; buy 2 at SECOND.
    const item = await call('owner', 'post', '/inventory/items')
      .send({ name: 'Sunflower Oil', unit: 'l', costPerUnitMinor: 15000, lowStockThreshold: 6 })
      .expect(201);
    const id = item.body.data.id;
    const move = (branchId: string, type: string, quantity: number) =>
      call('owner', 'post', `/inventory/items/${id}/movements`)
        .send({ branchId, type, quantity })
        .expect(201);
    await move(main, 'purchase', 10);
    await move(main, 'usage', 4);
    await move(main, 'wastage', 1);
    await move(second, 'purchase', 2);
  });

  afterAll(async () => {
    await app?.close();
    if (migrator?.isInitialized) {
      for (const table of [
        'inventory_movements',
        'inventory_stock',
        'inventory_items',
        'user_role_assignments',
      ]) {
        await migrator.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
      }
      await migrator.destroy();
    }
  });

  const url = (branchId: string, from = today(), to = today()) =>
    `/reports/inventory?branchId=${branchId}&from=${from}&to=${to}`;

  it('totals movements and values them at current cost', async () => {
    const r = (await call('owner', 'get', url(main)).expect(200)).body.data;
    expect(r.totals).toEqual({
      purchase: { movements: 1, valueMinor: 150000 },
      usage: { movements: 1, valueMinor: 60000 },
      wastage: { movements: 1, valueMinor: 15000 },
      count: { movements: 0, valueMinor: 0 },
    });
    expect(r.items).toEqual([
      expect.objectContaining({
        name: 'Sunflower Oil',
        purchased: 10,
        used: 4,
        wasted: 1,
        wastedValueMinor: 15000,
      }),
    ]);
    expect(r.stock.totalValueMinor).toBe(75000);
    expect(r.stock.rows[0]).toMatchObject({ quantity: 5, status: 'low' });
    expect(r.daily.map((d: { type: string }) => d.type).sort()).toEqual([
      'purchase',
      'usage',
      'wastage',
    ]);
  });

  it('keeps branches separate and respects the date range', async () => {
    const r = (await call('owner', 'get', url(second)).expect(200)).body.data;
    expect(r.totals.purchase.valueMinor).toBe(30000);
    const past = (await call('owner', 'get', url(main, '2020-01-01', '2020-01-31')).expect(200))
      .body.data;
    expect(past.totals.purchase.movements).toBe(0);
    expect(past.stock.rows[0].quantity).toBe(5);
  });

  it('limits branch managers to their branch and blocks cashiers', async () => {
    const r = (
      await call('manager', 'get', `/reports/inventory?from=${today()}&to=${today()}`).expect(200)
    ).body.data;
    expect(r.branch.id).toBe(main);
    expect(r.branches).toHaveLength(1);
    await call('manager', 'get', url(second)).expect(403);
    await call('cashier', 'get', url(main)).expect(403);
  });

  it('isolates tenants and validates the range', async () => {
    await call('bravoOwner', 'get', url(main)).expect(403);
    await call('owner', 'get', url(main, '2026-02-01', '2026-01-01')).expect(400);
    await call('owner', 'get', url(main, '2020-01-01', '2026-01-01')).expect(400);
    await call('owner', 'get', url(main, 'yesterday')).expect(400);
  });
});
