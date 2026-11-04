import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PasswordHasher } from '../src/core/security/password-hasher';
import { connect } from './helpers';

/**
 * Promotions: CRUD, validation, link ownership, server-side quotes (prices from the database,
 * branch/coupon/expiry rules), role permissions and tenant isolation.
 */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;

describe('Promotions (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  const tenants: string[] = [];
  const emails: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  let main: string;
  let second: string;
  let bravoBranch: string;
  let chicken: string;
  let naan: string;
  let breads: string;
  let bravoItem: string;

  const call = (who: string, method: 'get' | 'post' | 'patch' | 'delete', url: string) =>
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
    const alpha = await tenant('promoalpha');
    const bravo = await tenant('promobravo');
    main = alpha.main;
    second = alpha.second;
    bravoBranch = bravo.main;
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

    const imported = async (who: string) =>
      call(who, 'post', '/menu/import')
        .send({
          rows: [
            { category: 'Mains', name: 'Butter Chicken', priceMinor: 36000, diet: 'non_veg' },
            { category: 'Breads', name: 'Naan', priceMinor: 6000, diet: 'veg' },
          ],
        })
        .expect(201);
    await imported('owner');
    await imported('bravoOwner');
    const menu = (await call('owner', 'get', '/menu').expect(200)).body.data;
    chicken = menu.items.find((i: { name: string }) => i.name === 'Butter Chicken').id;
    naan = menu.items.find((i: { name: string }) => i.name === 'Naan').id;
    breads = menu.categories.find((c: { name: string }) => c.name === 'Breads').id;
    bravoItem = (await call('bravoOwner', 'get', '/menu').expect(200)).body.data.items[0].id;
  });

  afterAll(async () => {
    await app?.close();
    if (migrator?.isInitialized) {
      for (const table of [
        'promotion_items',
        'promotion_categories',
        'promotion_branches',
        'promotions',
        'menu_items',
        'menu_categories',
        'user_role_assignments',
      ]) {
        await migrator.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
      }
      await migrator.destroy();
    }
  });

  const cart = () => [
    { menuItemId: chicken, quantity: 1 },
    { menuItemId: naan, quantity: 3 },
  ]; // ₹360 + ₹180 = ₹540
  const quoteAs = (who: string, body: object) =>
    call(who, 'post', '/promotions/quote').send({
      branchId: main,
      channel: 'dine_in',
      lines: cart(),
      ...body,
    });

  let tenOff: string;
  let breadBogo: string;

  it('creates promotions and lists them with their state', async () => {
    tenOff = (
      await call('owner', 'post', '/promotions')
        .send({ name: '10% off', type: 'percentage', value: 1000, maxDiscountMinor: 4000 })
        .expect(201)
    ).body.data.id;
    breadBogo = (
      await call('owner', 'post', '/promotions')
        .send({
          name: 'Naan BOGO',
          type: 'bogo',
          scope: 'items',
          value: 10000,
          buyQuantity: 1,
          getQuantity: 1,
          categoryIds: [breads],
          stackable: true,
        })
        .expect(201)
    ).body.data.id;
    await call('owner', 'post', '/promotions')
      .send({ name: 'Later', type: 'percentage', value: 500, startsAt: '2099-01-01T00:00:00Z' })
      .expect(201);
    const res = (await call('owner', 'get', '/promotions').expect(200)).body;
    expect(res.meta).toMatchObject({ page: 1, limit: 25, total: 3, totalPages: 1 });
    expect(res.data.map((p: { name: string; state: string }) => [p.name, p.state])).toEqual(
      expect.arrayContaining([
        ['10% off', 'active'],
        ['Naan BOGO', 'active'],
        ['Later', 'scheduled'],
      ]),
    );
    const summary = (await call('owner', 'get', '/promotions/summary').expect(200)).body.data;
    expect(summary).toEqual({
      counts: { active: 2, scheduled: 1, expired: 0, paused: 0 },
      canManage: true,
    });
    const scheduled = (await call('owner', 'get', '/promotions?state=scheduled').expect(200)).body;
    expect(scheduled.data.map((p: { name: string }) => p.name)).toEqual(['Later']);
  });

  it('validates rules and ownership of linked records', async () => {
    const bad = (body: object) =>
      call('owner', 'post', '/promotions')
        .send({ name: 'x', ...body })
        .expect(400);
    await bad({ type: 'percentage', value: 15000 });
    await bad({ type: 'bogo', value: 10000, scope: 'items', categoryIds: [breads] });
    await bad({ type: 'percentage', value: 100, scope: 'items' });
    await bad({
      type: 'percentage',
      value: 100,
      startsAt: '2026-02-01T00:00:00Z',
      endsAt: '2026-01-01T00:00:00Z',
    });
    await bad({ type: 'percentage', value: 100, scope: 'items', itemIds: [bravoItem] });
    await bad({ type: 'percentage', value: 100, branchIds: [bravoBranch] });
  });

  it('quotes from database prices and picks the better of stackable vs single offers', async () => {
    // 10% (capped ₹40) vs BOGO on 3 naan (1 free = ₹60): BOGO wins
    const q = (await quoteAs('cashier', {}).expect(200)).body.data;
    expect(q.subtotalMinor).toBe(54000);
    expect(q.applied.map((a: { name: string }) => a.name)).toEqual(['Naan BOGO']);
    expect(q.discountMinor).toBe(6000);
    expect(q.totalMinor).toBe(48000);
  });

  it('rejects client-sent prices', async () => {
    await call('cashier', 'post', '/promotions/quote')
      .send({
        branchId: main,
        channel: 'dine_in',
        lines: [{ menuItemId: chicken, quantity: 1, unitPriceMinor: 1 }],
      })
      .expect(400);
  });

  it('applies coupons, and rejects expired, wrong-branch and below-minimum ones', async () => {
    await call('owner', 'post', '/promotions')
      .send({
        name: 'Flat 100',
        type: 'fixed_amount',
        value: 10000,
        couponCode: 'flat100',
        minOrderMinor: 50000,
      })
      .expect(201);
    await call('owner', 'post', '/promotions')
      .send({
        name: 'Old',
        type: 'percentage',
        value: 5000,
        couponCode: 'OLD50',
        startsAt: '2020-01-01T00:00:00Z',
        endsAt: '2020-02-01T00:00:00Z',
      })
      .expect(201);
    await call('owner', 'post', '/promotions')
      .send({
        name: 'Second only',
        type: 'percentage',
        value: 2000,
        couponCode: 'SECOND20',
        branchIds: [second],
      })
      .expect(201);
    await call('owner', 'post', '/promotions')
      .send({ name: 'dup', type: 'percentage', value: 100, couponCode: 'FLAT100' })
      .expect(409);

    const applied = (await quoteAs('cashier', { couponCode: 'Flat100' }).expect(200)).body.data;
    expect(applied.coupon).toEqual({ code: 'FLAT100', status: 'applied' });
    expect(applied.applied[0]).toMatchObject({ name: 'Flat 100', discountMinor: 10000 });

    const reason = async (body: object) =>
      (await quoteAs('cashier', body).expect(200)).body.data.coupon.reason;
    expect(await reason({ couponCode: 'OLD50' })).toBe('expired');
    expect(await reason({ couponCode: 'SECOND20' })).toBe('wrong_branch');
    expect(await reason({ couponCode: 'NOPE' })).toBe('not_found');
    expect(
      await reason({ couponCode: 'FLAT100', lines: [{ menuItemId: naan, quantity: 1 }] }),
    ).toBe('min_order');
  });

  it('pauses, edits and deletes', async () => {
    await call('owner', 'patch', `/promotions/${breadBogo}`).send({ status: 'paused' }).expect(204);
    let q = (await quoteAs('cashier', {}).expect(200)).body.data;
    expect(q.applied.map((a: { name: string }) => a.name)).toEqual(['10% off']);
    expect(q.discountMinor).toBe(4000);
    await call('owner', 'patch', `/promotions/${tenOff}`)
      .send({ maxDiscountMinor: null })
      .expect(204);
    q = (await quoteAs('cashier', {}).expect(200)).body.data;
    expect(q.discountMinor).toBe(5400);
    await call('owner', 'patch', `/promotions/${tenOff}`).send({ value: 20000 }).expect(400);
    await call('owner', 'delete', `/promotions/${tenOff}`).expect(204);
    await call('owner', 'get', `/promotions/${tenOff}`).expect(404);
  });

  it('enforces roles', async () => {
    const mgr = (await call('manager', 'get', '/promotions/summary').expect(200)).body.data;
    expect(mgr.canManage).toBe(false);
    await call('manager', 'post', '/promotions')
      .send({ name: 'x', type: 'percentage', value: 100 })
      .expect(403);
    await call('cashier', 'get', '/promotions').expect(403);
    await call('cashier', 'post', '/promotions/quote')
      .send({ branchId: second, channel: 'dine_in', lines: cart() })
      .expect(403);
  });

  it('isolates tenants', async () => {
    const list = (await call('bravoOwner', 'get', '/promotions').expect(200)).body;
    expect(list.data).toEqual([]);
    expect(list.meta.total).toBe(0);
    await call('bravoOwner', 'get', `/promotions/${breadBogo}`).expect(404);
    await call('bravoOwner', 'patch', `/promotions/${breadBogo}`)
      .send({ status: 'active' })
      .expect(404);
    await call('bravoOwner', 'post', '/promotions/quote')
      .send({ branchId: main, channel: 'dine_in', lines: cart() })
      .expect(403);
    await call('bravoOwner', 'post', '/promotions/quote')
      .send({ branchId: bravoBranch, channel: 'dine_in', lines: cart() })
      .expect(400);
  });
});
