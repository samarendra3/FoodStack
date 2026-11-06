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
 * Phase 2 regression suite (docs/PHASE_2_PERFORMANCE_REPORT.md): the monthly order counter
 * (concurrency never exceeds the limit, failed and cancelled orders free their slot, retries
 * count once, unlimited plans still count), bulk line/discount inserts keep order and totals,
 * index-friendly date filters stay time-zone correct, and tenant and branch isolation hold.
 */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;

describe('Order limits and order queries (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  const tenants: string[] = [];
  const emails: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  let alpha: { id: string; main: string; second: string };
  let bravo: { id: string; main: string; second: string };
  const menu: Record<string, { chai: string; tikka: string }> = {};

  const call = (who: string, method: 'get' | 'post', url: string) =>
    request(app.getHttpServer())
      [method](`${API}${url}`)
      .set('X-Forwarded-For', freshIp())
      .set('Authorization', `Bearer ${tokens[who]}`);
  const order = (who: string, branchId: string, tenantKey = 'alpha', extra: object = {}) =>
    call(who, 'post', '/orders').send({
      branchId,
      channel: 'takeaway',
      lines: [{ menuItemId: menu[tenantKey]!.chai, quantity: 2 }],
      ...extra,
    });
  const counter = async (tenantId: string) =>
    Number(
      (
        await migrator.query(
          `SELECT coalesce(sum(orders), 0) AS n FROM tenant_usage_counters WHERE tenant_id = $1`,
          [tenantId],
        )
      )[0].n,
    );
  const liveOrders = async (tenantId: string) =>
    Number(
      (
        await migrator.query(
          `SELECT count(*) AS n FROM orders WHERE tenant_id = $1 AND status <> 'cancelled'`,
          [tenantId],
        )
      )[0].n,
    );
  /** Paid plan with this monthly order limit (null = unlimited) agreed in its snapshot. */
  const setLimit = async (tenantId: string, ordersPerMonth: number | null) => {
    const [plan] = await migrator.query(`SELECT id FROM plans WHERE code = 'starter'`);
    await migrator.query(
      `UPDATE subscriptions SET status = 'active', plan_id = $2, billing_cycle = 'monthly',
              current_period_start = now(), current_period_end = now() + interval '30 days',
              plan_snapshot = $3
        WHERE tenant_id = $1`,
      [
        tenantId,
        plan.id,
        JSON.stringify({
          planId: plan.id,
          code: 'starter',
          name: 'Starter',
          currencyCode: 'INR',
          billingCycle: 'monthly',
          priceMinor: 49_900,
          limits: { branches: 5, staff: 50, ordersPerMonth, menuItems: null, storageMb: null },
          features: [],
          featureFlags: {},
        }),
      ],
    );
  };

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
    emails[key] = `ol${key}-${suffix()}@example.test`;
    const [u] = await migrator.query(
      `INSERT INTO users (email, full_name, password_hash, email_verified_at) VALUES ($1, $2, $3, now()) RETURNING id`,
      [emails[key], key, hash],
    );
    const [m] = await migrator.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, status, joined_at) VALUES ($1, $2, 'active', now()) RETURNING id`,
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
    alpha = await tenant('olalpha');
    bravo = await tenant('olbravo');
    await member('owner', alpha.id, 'owner', hash);
    await member('cashier', alpha.id, 'cashier', hash, alpha.main); // branch-scoped
    await member('bravoOwner', bravo.id, 'owner', hash);
    await setLimit(alpha.id, 5);
    await setLimit(bravo.id, 5);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app);
    await app.init();
    for (const who of Object.keys(emails)) {
      tokens[who] = (
        await request(app.getHttpServer())
          .post(`${API}/auth/login`)
          .set('X-Forwarded-For', freshIp())
          .send({ email: emails[who], password: PASSWORD })
          .expect(200)
      ).body.data.accessToken;
    }
    for (const [key, who] of [
      ['alpha', 'owner'],
      ['bravo', 'bravoOwner'],
    ] as const) {
      await call(who, 'post', '/menu/import')
        .send({
          rows: [
            { category: 'Drinks', name: 'Chai', priceMinor: 5000, diet: 'veg' },
            { category: 'Starters', name: 'Paneer Tikka', priceMinor: 30000, diet: 'veg' },
          ],
        })
        .expect(201);
      const items = (await call(who, 'get', '/menu').expect(200)).body.data.items as {
        id: string;
        name: string;
      }[];
      menu[key] = {
        chai: items.find((i) => i.name === 'Chai')!.id,
        tikka: items.find((i) => i.name === 'Paneer Tikka')!.id,
      };
    }
    await call('owner', 'post', '/promotions')
      .send({
        name: 'Flat 10',
        type: 'fixed_amount',
        value: 1000,
        couponCode: 'TEN',
        stackable: true,
      })
      .expect(201);
  });

  afterAll(async () => {
    await app?.close();
    if (migrator?.isInitialized) {
      for (const t of [
        'refunds',
        'payments',
        'order_discounts',
        'order_items',
        'orders',
        'branch_order_counters',
        'tenant_usage_counters',
        'customers',
        'promotion_items',
        'promotion_categories',
        'promotion_branches',
        'promotions',
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

  it('never exceeds the monthly limit under concurrent order creation', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => order(i % 2 ? 'owner' : 'cashier', alpha.main)),
    );
    const ok = results.filter((r) => r.status === 201).length;
    const refused = results.filter((r) => r.status === 403);
    expect(ok).toBe(5);
    expect(refused).toHaveLength(7);
    expect(refused.every((r) => r.body.code === 'ORDER_LIMIT_REACHED')).toBe(true);
    expect(await counter(alpha.id)).toBe(5);
    expect(await liveOrders(alpha.id)).toBe(5);
  });

  it('does not consume a slot when the order fails after the reservation', async () => {
    await call('owner', 'post', '/orders').send({
      branchId: alpha.main,
      channel: 'takeaway',
      lines: [{ menuItemId: menu.alpha!.chai, quantity: 1 }],
      couponCode: 'NOPE',
    });
    expect(await counter(alpha.id)).toBe(5);
  });

  it('gives the slot back when an order is cancelled', async () => {
    const [o] = await migrator.query(
      `SELECT id FROM orders WHERE tenant_id = $1 AND status = 'open' ORDER BY created_at LIMIT 1`,
      [alpha.id],
    );
    await call('owner', 'post', `/orders/${o.id}/cancel`)
      .send({ reason: 'Customer left' })
      .expect((r) => expect([200, 201]).toContain(r.status));
    expect(await counter(alpha.id)).toBe(4);
    await order('owner', alpha.main).expect(201);
    expect((await order('owner', alpha.main).expect(403)).body.code).toBe('ORDER_LIMIT_REACHED');
    expect(await counter(alpha.id)).toBe(await liveOrders(alpha.id));
  });

  it('counts concurrent retries of one request once and returns the same order', async () => {
    await setLimit(alpha.id, null); // unlimited: still counted for usage
    const before = await counter(alpha.id);
    const key = `retry-${suffix()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => order('owner', alpha.main).set('Idempotency-Key', key)),
    );
    expect(results.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
    expect(await counter(alpha.id)).toBe(before + 1);
    expect(await counter(alpha.id)).toBe(await liveOrders(alpha.id));
  });

  it('keeps each restaurant account on its own counter', async () => {
    await order('bravoOwner', bravo.main, 'bravo').expect(201);
    expect(await counter(bravo.id)).toBe(1);
    // Alpha's orders never appear in bravo's counter or lists.
    const list = await call('bravoOwner', 'get', '/orders?limit=100').expect(200);
    expect(list.body.meta.total).toBe(1);
    await call('bravoOwner', 'get', `/orders?branchId=${alpha.main}`).expect((r) =>
      expect([400, 403, 404]).toContain(r.status),
    );
  });

  it('keeps branch-scoped staff to their own branch', async () => {
    await order('owner', alpha.second).expect(201);
    const mine = await call('cashier', 'get', '/orders?limit=100').expect(200);
    expect(mine.body.data.every((o: { branchId: string }) => o.branchId === alpha.main)).toBe(true);
    await call('cashier', 'get', `/orders?branchId=${alpha.second}`).expect(403);
  });

  it('stores bulk-inserted lines and discounts in cart order with correct totals', async () => {
    const res = await call('owner', 'post', '/orders')
      .send({
        branchId: alpha.main,
        channel: 'dine_in',
        tableLabel: 'T9',
        couponCode: 'TEN',
        lines: [
          { menuItemId: menu.alpha!.tikka, quantity: 1, note: 'first' },
          { menuItemId: menu.alpha!.chai, quantity: 3, note: 'second' },
          { menuItemId: menu.alpha!.tikka, quantity: 2, note: 'third' },
        ],
      })
      .expect(201);
    const o = res.body.data;
    expect(o.items.map((i: { note: string }) => i.note)).toEqual(['first', 'second', 'third']);
    expect(o.items.map((i: { quantity: number }) => i.quantity)).toEqual([1, 3, 2]);
    expect(o.subtotalMinor).toBe(30000 + 15000 + 60000);
    expect(o.discountMinor).toBe(1000);
    expect(o.discounts).toEqual([
      expect.objectContaining({ couponCode: 'TEN', discountMinor: 1000 }),
    ]);
    const [{ n }] = await migrator.query(
      `SELECT count(*)::int AS n FROM order_discounts WHERE order_id = $1`,
      [o.id],
    );
    expect(n).toBe(1);
  });

  it('filters orders and payments by local day correctly across the time-zone boundary', async () => {
    const o = (await order('owner', alpha.main).expect(201)).body.data;
    // 19:00 UTC on 3 Nov is 00:30 on 4 Nov in Asia/Kolkata (UTC+5:30).
    await migrator.query(`UPDATE orders SET created_at = '2026-11-03T19:00:00Z' WHERE id = $1`, [
      o.id,
    ]);
    const ids = async (from: string, to: string) =>
      (
        await call(
          'owner',
          'get',
          `/orders?branchId=${alpha.main}&from=${from}&to=${to}&limit=100`,
        ).expect(200)
      ).body.data.map((r: { id: string }) => r.id);
    expect(await ids('2026-11-04', '2026-11-04')).toContain(o.id);
    expect(await ids('2026-11-03', '2026-11-03')).not.toContain(o.id);
    // 18:29:59 UTC is still 3 Nov locally (23:59:59).
    await migrator.query(`UPDATE orders SET created_at = '2026-11-03T18:29:59Z' WHERE id = $1`, [
      o.id,
    ]);
    expect(await ids('2026-11-03', '2026-11-03')).toContain(o.id);
    expect(await ids('2026-11-04', '2026-11-04')).not.toContain(o.id);
  });

  describe('restaurants in different time zones (one restaurant account)', () => {
    let kolkata: { restaurant: string; branch: string };
    let honolulu: { restaurant: string; branch: string };
    const period = async (tz: string) =>
      (
        await migrator.query(`SELECT date_trunc('month', now() AT TIME ZONE $1)::date::text AS p`, [
          tz,
        ])
      )[0].p as string;
    const rows = async () =>
      (await migrator.query(
        `SELECT restaurant_id, period::text AS period, orders FROM tenant_usage_counters
          WHERE tenant_id = $1 ORDER BY period, restaurant_id`,
        [bravo.id],
      )) as { restaurant_id: string; period: string; orders: number }[];
    const shownUsage = async () =>
      (await call('bravoOwner', 'get', '/billing/subscription').expect(200)).body.data.usage
        .ordersThisMonth as number;

    beforeAll(async () => {
      // Bravo gets a second restaurant in Honolulu (UTC−10) next to its Kolkata one (UTC+5:30).
      const [k] = await migrator.query(
        `SELECT r.id AS restaurant, b.id AS branch FROM restaurants r JOIN branches b ON b.restaurant_id = r.id
          WHERE r.tenant_id = $1 AND b.code = 'MAIN'`,
        [bravo.id],
      );
      kolkata = k;
      const [r] = await migrator.query(
        `INSERT INTO restaurants (tenant_id, name, slug, currency_code, country_code, timezone)
         VALUES ($1, 'Aloha', $2, 'USD', 'US', 'Pacific/Honolulu') RETURNING id`,
        [bravo.id, `aloha-${suffix()}`],
      );
      const [b] = await migrator.query(
        `INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone, is_default)
         VALUES ($1, $2, 'HNL', 'Honolulu', 'Pacific/Honolulu', true) RETURNING id`,
        [bravo.id, r.id],
      );
      honolulu = { restaurant: r.id, branch: b.id };
      // Fresh state: limit 4 for the whole account, no counted orders.
      await migrator.query(
        `UPDATE orders SET status = 'cancelled', cancelled_at = now() WHERE tenant_id = $1 AND status = 'open'`,
        [bravo.id],
      );
      await migrator.query(`DELETE FROM tenant_usage_counters WHERE tenant_id = $1`, [bravo.id]);
      await setLimit(bravo.id, 4);
      const [item] = await migrator.query(
        `INSERT INTO menu_items (tenant_id, restaurant_id, category_id, name, price_minor, currency_code, diet)
         SELECT $1, $2, category_id, 'Kona Coffee', 400, 'USD', 'veg'
           FROM menu_items WHERE tenant_id = $1 LIMIT 1 RETURNING id`,
        [bravo.id, r.id],
      );
      menu.aloha = { chai: item.id, tikka: item.id };
    });

    it("keeps each restaurant's month in its own time zone and sums them for the account", async () => {
      await order('bravoOwner', kolkata.branch, 'bravo').expect(201);
      await order('bravoOwner', honolulu.branch, 'aloha').expect(201);
      const r = await rows();
      expect(r).toEqual(
        expect.arrayContaining([
          { restaurant_id: kolkata.restaurant, period: await period('Asia/Kolkata'), orders: 1 },
          {
            restaurant_id: honolulu.restaurant,
            period: await period('Pacific/Honolulu'),
            orders: 1,
          },
        ]),
      );
      expect(await shownUsage()).toBe(2);
    });

    it('applies the account-wide limit across restaurants under concurrency', async () => {
      // 2 used of 4: eight simultaneous orders split across both restaurants → exactly 2 more.
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          i % 2
            ? order('bravoOwner', honolulu.branch, 'aloha')
            : order('bravoOwner', kolkata.branch, 'bravo'),
        ),
      );
      expect(results.filter((x) => x.status === 201)).toHaveLength(2);
      expect(results.filter((x) => x.status === 403)).toHaveLength(6);
      expect(await shownUsage()).toBe(4);
      expect((await rows()).reduce((n, x) => n + x.orders, 0)).toBe(4);
    });

    it("releases a cancelled order's slot from its own restaurant's month at the boundary", async () => {
      // 23:30 UTC on 31 Oct is already 1 Nov (05:00) in Kolkata but still 31 Oct (13:30) in Honolulu.
      const at = '2026-10-31T23:30:00Z';
      const [hnl] = await migrator.query(
        `SELECT id FROM orders WHERE tenant_id = $1 AND restaurant_id = $2 AND status = 'open' ORDER BY created_at LIMIT 1`,
        [bravo.id, honolulu.restaurant],
      );
      const [kol] = await migrator.query(
        `SELECT id FROM orders WHERE tenant_id = $1 AND restaurant_id = $2 AND status = 'open' ORDER BY created_at LIMIT 1`,
        [bravo.id, kolkata.restaurant],
      );
      await migrator.query(`UPDATE orders SET created_at = $2 WHERE id = ANY($1::uuid[])`, [
        [hnl.id, kol.id],
        at,
      ]);
      // Their slots live in the month each restaurant saw at that instant.
      await migrator.query(
        `INSERT INTO tenant_usage_counters (tenant_id, restaurant_id, period, orders)
         VALUES ($1, $2, '2026-10-01', 1), ($1, $3, '2026-11-01', 1)
         ON CONFLICT (tenant_id, restaurant_id, period) DO UPDATE SET orders = tenant_usage_counters.orders + 1`,
        [bravo.id, honolulu.restaurant, kolkata.restaurant],
      );
      const count = async (restaurant: string, p: string) =>
        Number(
          (
            await migrator.query(
              `SELECT coalesce(sum(orders), 0) AS n FROM tenant_usage_counters
                WHERE tenant_id = $1 AND restaurant_id = $2 AND period = $3`,
              [bravo.id, restaurant, p],
            )
          )[0].n,
        );
      const hnlOct = await count(honolulu.restaurant, '2026-10-01');
      const kolNov = await count(kolkata.restaurant, '2026-11-01');
      for (const id of [hnl.id, kol.id]) {
        await call('bravoOwner', 'post', `/orders/${id}/cancel`)
          .send({ reason: 'Boundary test' })
          .expect((x) => expect([200, 201]).toContain(x.status));
      }
      expect(await count(honolulu.restaurant, '2026-10-01')).toBe(hnlOct - 1);
      expect(await count(kolkata.restaurant, '2026-11-01')).toBe(kolNov - 1);
    });

    it('never lets a counter point at another account’s restaurant', async () => {
      await expect(
        migrator.query(
          `INSERT INTO tenant_usage_counters (tenant_id, restaurant_id, period, orders) VALUES ($1, $2, '2026-11-01', 1)`,
          [alpha.id, honolulu.restaurant],
        ),
      ).rejects.toThrow(/foreign key/);
    });
  });
});
