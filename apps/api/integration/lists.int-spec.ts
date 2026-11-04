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
 * Paged admin lists: page/limit/sort validation, metadata, filters, search, branch scoping and
 * tenant isolation for orders, payments, customers, menu items, stock and stock movements.
 */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;

describe('Paged lists (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  const tenants: string[] = [];
  const emails: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  let main: string;
  let second: string;
  let chai: string;
  let tikka: string;
  let half: string;
  let rice: string;

  const get = (who: string, url: string) =>
    request(app.getHttpServer())
      .get(`${API}${url}`)
      .set('X-Forwarded-For', freshIp())
      .set('Authorization', `Bearer ${tokens[who]}`);
  const post = (who: string, url: string, body: object) =>
    request(app.getHttpServer())
      .post(`${API}${url}`)
      .set('X-Forwarded-For', freshIp())
      .set('Authorization', `Bearer ${tokens[who]}`)
      .send(body);

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
    const alpha = await tenant('listalpha');
    const bravo = await tenant('listbravo');
    main = alpha.main;
    second = alpha.second;
    await member('owner', alpha.id, 'owner', hash);
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

    await post('owner', '/menu/import', {
      rows: [
        { category: 'Drinks', name: 'Chai', priceMinor: 5000, diet: 'veg' },
        { category: 'Drinks', name: 'Lassi', priceMinor: 9000, diet: 'veg', isAvailable: false },
        {
          category: 'Starters',
          name: 'Paneer Tikka',
          priceMinor: 30000,
          halfPriceMinor: 18000,
          diet: 'veg',
        },
        { category: 'Starters', name: 'Chicken 65', priceMinor: 29000, diet: 'non_veg' },
      ],
    }).expect(201);
    const menu = (await get('owner', '/menu').expect(200)).body.data;
    chai = menu.items.find((i: { name: string }) => i.name === 'Chai').id;
    const t = menu.items.find((i: { name: string }) => i.name === 'Paneer Tikka');
    tikka = t.id;
    half = t.variants.find((v: { name: string }) => v.name === 'Half').id;

    // 12 orders at MAIN (quantities 1..12 of chai), 3 at SECOND; every 3rd MAIN order paid by card.
    for (let q = 1; q <= 12; q++) {
      const o = (
        await post('cashier', '/orders', {
          branchId: main,
          channel: q % 2 ? 'dine_in' : 'takeaway',
          tableLabel: `T${q}`,
          customer: q === 5 ? { phone: '9000000005', name: 'Ravi' } : null,
          lines: [{ menuItemId: chai, quantity: q }],
        }).expect(201)
      ).body.data;
      if (q % 3 === 0) {
        await post('cashier', `/orders/${o.id}/payments`, {
          method: 'card',
          amountMinor: o.totalMinor,
        }).expect(201);
      }
    }
    for (let q = 1; q <= 3; q++) {
      await post('owner', '/orders', {
        branchId: second,
        channel: 'delivery',
        lines: [{ menuItemId: tikka, variantId: half, quantity: q }],
      }).expect(201);
    }

    rice = (
      await post('owner', '/inventory/items', {
        name: 'Rice',
        unit: 'kg',
        lowStockThreshold: 5,
      }).expect(201)
    ).body.data.id;
    await post('owner', '/inventory/items', {
      name: 'Oil',
      unit: 'l',
      lowStockThreshold: 2,
    }).expect(201);
    await post('owner', `/inventory/items/${rice}/movements`, {
      branchId: main,
      type: 'purchase',
      quantity: 20,
    }).expect(201);
    await post('owner', `/inventory/items/${rice}/movements`, {
      branchId: main,
      type: 'usage',
      quantity: 16,
    }).expect(201);
  });

  afterAll(async () => {
    await app?.close();
    if (migrator?.isInitialized) {
      for (const table of [
        'inventory_movements',
        'inventory_stock',
        'inventory_items',
        'refunds',
        'payments',
        'order_discounts',
        'order_items',
        'orders',
        'branch_order_counters',
        'customers',
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

  it('pages orders with metadata and stable sorting', async () => {
    const p1 = (await get('owner', '/orders?limit=10').expect(200)).body;
    expect(p1.meta).toMatchObject({
      page: 1,
      limit: 10,
      total: 15,
      totalPages: 2,
      hasNextPage: true,
      hasPreviousPage: false,
    });
    expect(p1.data).toHaveLength(10);
    const p2 = (await get('owner', '/orders?limit=10&page=2').expect(200)).body;
    expect(p2.data).toHaveLength(5);
    expect(p2.meta).toMatchObject({ hasNextPage: false, hasPreviousPage: true });
    const ids = new Set([...p1.data, ...p2.data].map((o: { id: string }) => o.id));
    expect(ids.size).toBe(15);

    const byNumber = (
      await get(
        'owner',
        `/orders?branchId=${main}&sortBy=orderNumber&sortOrder=asc&limit=10`,
      ).expect(200)
    ).body.data;
    expect(byNumber.map((o: { orderNumber: number }) => o.orderNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it('rejects invalid paging and sort parameters', async () => {
    await get('owner', '/orders?limit=7').expect(400);
    await get('owner', '/orders?limit=1000').expect(400);
    await get('owner', '/orders?page=0').expect(400);
    await get('owner', '/orders?sortBy=password_hash').expect(400);
    await get('owner', '/orders?sortBy=createdAt;drop').expect(400);
    await get('owner', '/orders?from=2026-02-01&to=2026-01-01').expect(400);
    await get('owner', '/orders?evil=1').expect(400);
  });

  it('filters and searches orders', async () => {
    const completed = (await get('owner', '/orders?status=completed').expect(200)).body;
    expect(completed.meta.total).toBe(4);
    const delivery = (await get('owner', '/orders?channel=delivery').expect(200)).body;
    expect(delivery.meta.total).toBe(3);
    const byNumber = (await get('owner', `/orders?branchId=${main}&search=%235`).expect(200)).body
      .data;
    expect(byNumber.map((o: { orderNumber: number }) => o.orderNumber)).toEqual([5]);
    const byPhone = (await get('owner', '/orders?search=90000').expect(200)).body.data;
    expect(byPhone).toHaveLength(1);
    expect(byPhone[0].customer).toEqual({ name: 'Ravi', phone: '9000000005' });
    const byTable = (await get('owner', '/orders?search=T1').expect(200)).body.meta.total;
    expect(byTable).toBe(4); // T1, T10, T11, T12
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    expect(
      (await get('owner', `/orders?from=${today}&to=${today}`).expect(200)).body.meta.total,
    ).toBe(15);
    expect(
      (await get('owner', '/orders?from=2020-01-01&to=2020-01-31').expect(200)).body.meta.total,
    ).toBe(0);
  });

  it('scopes orders to the branches a member can see', async () => {
    expect((await get('cashier', '/orders').expect(200)).body.meta.total).toBe(12);
    await get('cashier', `/orders?branchId=${second}`).expect(403);
    expect((await get('bravoOwner', '/orders').expect(200)).body.meta.total).toBe(0);
    await get('bravoOwner', `/orders?branchId=${main}`).expect(403);
  });

  it('pages payments with method and refund filters', async () => {
    const res = (
      await get('owner', '/payments?method=card&sortBy=amountMinor&sortOrder=desc').expect(200)
    ).body;
    expect(res.meta.total).toBe(4);
    expect(res.data[0]).toMatchObject({ method: 'card', orderNumber: 12, refundedMinor: 0 });
    expect((await get('owner', '/payments?refunded=yes').expect(200)).body.meta.total).toBe(0);
    // Cashiers hold order:read for their own branch only.
    expect((await get('cashier', '/payments').expect(200)).body.meta.total).toBe(4);
    await get('cashier', `/payments?branchId=${second}`).expect(403);
  });

  it('lists customers with order statistics for business-wide managers', async () => {
    const res = (await get('owner', '/customers?search=ravi').expect(200)).body;
    expect(res.data).toEqual([
      expect.objectContaining({
        name: 'Ravi',
        phone: '9000000005',
        orderCount: 0,
        totalSpentMinor: 0,
      }),
    ]);
    await get('cashier', '/customers').expect(403);
    expect((await get('bravoOwner', '/customers').expect(200)).body.meta.total).toBe(0);
  });

  it('pages menu items with filters and portions', async () => {
    const all = (await get('owner', '/menu/items?limit=10').expect(200)).body;
    expect(all.meta.total).toBe(4);
    // Category order, then the menu's own order within a category (import order).
    expect(all.data.map((i: { name: string }) => i.name)).toEqual([
      'Chai',
      'Lassi',
      'Paneer Tikka',
      'Chicken 65',
    ]);
    const soldOut = (await get('owner', '/menu/items?available=no').expect(200)).body.data;
    expect(soldOut.map((i: { name: string }) => i.name)).toEqual(['Lassi']);
    const found = (await get('owner', '/menu/items?search=tikka').expect(200)).body.data;
    expect(found[0].variants.map((v: { name: string }) => v.name)).toEqual(['Full', 'Half']);
    expect(found[0].categoryName).toBe('Starters');
    const nonVeg = (await get('cashier', '/menu/items?diet=non_veg').expect(200)).body.data;
    expect(nonVeg.map((i: { name: string }) => i.name)).toEqual(['Chicken 65']);
    const cats = (await get('owner', '/menu/categories').expect(200)).body.data;
    expect(cats).toMatchObject({ itemCount: 4, canManage: true });
    expect((await get('bravoOwner', '/menu/items').expect(200)).body.meta.total).toBe(0);
  });

  it('pages stock and the movement log', async () => {
    const low = (await get('owner', `/inventory/items?branchId=${main}&status=low`).expect(200))
      .body.data;
    expect(low.map((i: { name: string }) => i.name)).toEqual(['Rice']);
    const out = (await get('owner', `/inventory/items?branchId=${main}&status=out`).expect(200))
      .body.data;
    expect(out.map((i: { name: string }) => i.name)).toEqual(['Oil']);
    const summary = (await get('owner', `/inventory/summary?branchId=${main}`).expect(200)).body
      .data;
    expect(summary.counts).toEqual({ total: 2, low: 1, out: 1 });
    const moves = (
      await get('owner', `/inventory/movements?branchId=${main}&type=usage`).expect(200)
    ).body;
    expect(moves.meta.total).toBe(1);
    expect(moves.data[0]).toMatchObject({ itemName: 'Rice', quantityDelta: -16, quantityAfter: 4 });
    await get('cashier', '/inventory/items').expect(403);
  });
});
