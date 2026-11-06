import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type Redis from 'ioredis';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PasswordHasher } from '../src/core/security/password-hasher';
import { CacheService } from '../src/shared/cache/cache.service';
import { REDIS_CLIENT } from '../src/shared/redis/redis.constants';
import { connect } from './helpers';

/**
 * Phase 6 analytics against hand-computed fixtures (all amounts in paise, Asia/Kolkata):
 *
 * Day D = 2025-03-10 (IST).
 *   O0  MAIN   2025-03-01 completed  C1  sub 1 000                 cash 1 050
 *   O1  MAIN   D 12:00   dine_in completed (12:30)  C1  sub 10 000 disc 1 000 tax 450 = 9 450
 *              cash 9 450; lines A×2 (active, disc 1 000) + B×1 (void)
 *   O2  MAIN   D 00:10 IST (= 03-09 18:40 UTC) takeaway completed C1 sub 20 000 tax 1 000 = 21 000
 *              upi 21 000, refunded 5 000 on 2025-03-12; lines B×4
 *   O3  MAIN   D 15:00   dine_in cancelled  table T1  sub 5 000
 *   O4  MAIN   D 16:00   dine_in open, kitchen preparing, table T2, card 3 000 of 10 500
 *   O5  MAIN   2025-03-11 00:10 IST (= D 18:40 UTC) delivery completed, card 10 500
 *   O6  SECOND D 13:00   dine_in completed  C3  sub 50 000 tax 2 500 = 52 500  cash; lines C×10
 *   Bravo tenant: one completed order on D of 999 900 that must never appear.
 */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const D = '2025-03-10';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;
const day = (d: string, extra = '') => `?preset=custom&from=${d}&to=${d}${extra}`;

describe('Analytics (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  const tenants: string[] = [];
  const emails: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let numbers = 0;

  const http = () => request(app.getHttpServer());
  const call = (who: string, method: 'get' | 'post', url: string) =>
    http()
      [method](`${API}${url}`)
      .set('X-Forwarded-For', freshIp())
      .set('Authorization', `Bearer ${tokens[who]}`);
  const get = async (who: string, url: string) =>
    (await call(who, 'get', url).expect(200)).body.data;

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
    const [c1] = await migrator.query(
      `INSERT INTO menu_categories (tenant_id, restaurant_id, name, sort_order) VALUES ($1, $2, 'Mains', 1) RETURNING id`,
      [t.id, r.id],
    );
    const [c2] = await migrator.query(
      `INSERT INTO menu_categories (tenant_id, restaurant_id, name, sort_order) VALUES ($1, $2, 'Drinks', 2) RETURNING id`,
      [t.id, r.id],
    );
    const item = async (name: string, category: string) =>
      (
        await migrator.query(
          `INSERT INTO menu_items (tenant_id, restaurant_id, category_id, name, price_minor, currency_code, diet, is_available, sort_order)
           VALUES ($1, $2, $3, $4, 5000, 'INR', 'veg', true, 1) RETURNING id`,
          [t.id, r.id, category, name],
        )
      )[0].id as string;
    return {
      id: t.id as string,
      restaurant: r.id as string,
      main: await branch('MAIN'),
      second: await branch('SECOND'),
      catMains: c1.id as string,
      catDrinks: c2.id as string,
      itemA: await item('Paneer Tikka', c1.id),
      itemB: await item('Dal Makhani', c1.id),
      itemC: await item('Masala Chai', c2.id),
      itemUnsold: await item('Gulab Jamun', c2.id),
    };
  }
  type T = Awaited<ReturnType<typeof tenant>>;

  async function member(
    key: string,
    tenantId: string,
    role: string,
    hash: string,
    branchId?: string,
  ) {
    emails[key] = `${key}-${suffix()}@example.test`;
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

  async function customer(t: T, phone: string) {
    return (
      await migrator.query(
        `INSERT INTO customers (tenant_id, name, phone) VALUES ($1, 'Guest', $2) RETURNING id`,
        [t.id, phone],
      )
    )[0].id as string;
  }

  interface OrderSpec {
    branch: string;
    channel: string;
    status: 'open' | 'completed' | 'cancelled';
    kitchen?: string;
    created: string;
    completed?: string;
    subtotal: number;
    discount?: number;
    tax?: number;
    customer?: string;
    table?: string;
    payments?: {
      method: string;
      amount: number;
      at: string;
      refund?: { amount: number; at: string };
    }[];
    lines?: { item: string; category: string; qty: number; discount?: number; void?: boolean }[];
  }

  async function order(t: T, o: OrderSpec) {
    const discount = o.discount ?? 0;
    const tax = o.tax ?? 0;
    const total = o.subtotal - discount + tax;
    const paid = (o.payments ?? []).reduce((s, p) => s + p.amount, 0);
    const refunded = (o.payments ?? []).reduce((s, p) => s + (p.refund?.amount ?? 0), 0);
    const [row] = await migrator.query(
      `INSERT INTO orders (tenant_id, restaurant_id, branch_id, order_number, channel, status, kitchen_status,
                           table_label, customer_id, currency_code, tax_rate_bp, subtotal_minor, discount_minor,
                           tax_minor, total_minor, paid_minor, refunded_minor, created_at, completed_at, cancelled_at,
                           cancel_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'INR', 500, $10, $11, $12, $13, $14, $15, $16::timestamptz,
               $17::timestamptz, CASE WHEN $6 = 'cancelled' THEN $16::timestamptz END,
               CASE WHEN $6 = 'cancelled' THEN 'test' END)
       RETURNING id`,
      [
        t.id,
        t.restaurant,
        o.branch,
        ++numbers,
        o.channel,
        o.status,
        o.kitchen ?? 'served',
        o.table ?? null,
        o.customer ?? null,
        o.subtotal,
        discount,
        tax,
        total,
        paid,
        refunded,
        o.created,
        o.completed ?? null,
      ],
    );
    for (const l of o.lines ?? []) {
      await migrator.query(
        `INSERT INTO order_items (tenant_id, order_id, menu_item_id, category_id, name, unit_price_minor, quantity,
                                  line_total_minor, discount_minor, status, voided_at, created_at)
         VALUES ($1, $2, $3, $4, 'snapshot', 5000, $5, $6, $7, $8, CASE WHEN $8 = 'void' THEN now() END, $9)`,
        [
          t.id,
          row.id,
          l.item,
          l.category,
          l.qty,
          5000 * l.qty,
          l.discount ?? 0,
          l.void ? 'void' : 'active',
          o.created,
        ],
      );
    }
    for (const p of o.payments ?? []) {
      const [pay] = await migrator.query(
        `INSERT INTO payments (tenant_id, order_id, branch_id, method, amount_minor, refunded_minor, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [t.id, row.id, o.branch, p.method, p.amount, p.refund?.amount ?? 0, p.at],
      );
      if (p.refund) {
        await migrator.query(
          `INSERT INTO refunds (tenant_id, payment_id, order_id, amount_minor, reason, created_at)
           VALUES ($1, $2, $3, $4, 'test', $5)`,
          [t.id, pay.id, row.id, p.refund.amount, p.refund.at],
        );
      }
    }
    return row.id as string;
  }

  beforeAll(async () => {
    migrator = await connect('migration');
    await migrator.runMigrations({ transaction: 'each' });
    const hash = await new PasswordHasher().hash(PASSWORD);
    const alpha = await tenant('analpha');
    const bravo = await tenant('anbravo');
    Object.assign(ids, {
      main: alpha.main,
      second: alpha.second,
      restaurant: alpha.restaurant,
      bravoMain: bravo.main,
      bravoRestaurant: bravo.restaurant,
    });
    await member('owner', alpha.id, 'owner', hash);
    await member('manager', alpha.id, 'branch_manager', hash, alpha.main);
    await member('cashier', alpha.id, 'cashier', hash, alpha.main);
    await member('bravoOwner', bravo.id, 'owner', hash);

    const c1 = await customer(alpha, '9000000001');
    const c3 = await customer(alpha, '9000000003');
    const IST = (local: string) => `${local}+05:30`;

    await order(alpha, {
      branch: alpha.main,
      channel: 'dine_in',
      status: 'completed',
      customer: c1,
      created: IST('2025-03-01 12:00'),
      completed: IST('2025-03-01 12:30'),
      subtotal: 1000,
      tax: 50,
      payments: [{ method: 'cash', amount: 1050, at: IST('2025-03-01 12:30') }],
      lines: [{ item: alpha.itemA, category: alpha.catMains, qty: 1, discount: 4000 }],
    });
    await order(alpha, {
      branch: alpha.main,
      channel: 'dine_in',
      status: 'completed',
      customer: c1,
      table: 'T9',
      created: IST(`${D} 12:00`),
      completed: IST(`${D} 12:30`),
      subtotal: 10000,
      discount: 1000,
      tax: 450,
      payments: [{ method: 'cash', amount: 9450, at: IST(`${D} 12:30`) }],
      lines: [
        { item: alpha.itemA, category: alpha.catMains, qty: 2, discount: 1000 },
        { item: alpha.itemB, category: alpha.catMains, qty: 1, void: true },
      ],
    });
    await order(alpha, {
      branch: alpha.main,
      channel: 'takeaway',
      status: 'completed',
      customer: c1,
      created: IST(`${D} 00:10`),
      completed: IST(`${D} 00:10`),
      subtotal: 20000,
      tax: 1000,
      payments: [
        {
          method: 'upi',
          amount: 21000,
          at: IST(`${D} 00:10`),
          refund: { amount: 5000, at: IST('2025-03-12 10:00') },
        },
      ],
      lines: [{ item: alpha.itemB, category: alpha.catMains, qty: 4 }],
    });
    await order(alpha, {
      branch: alpha.main,
      channel: 'dine_in',
      status: 'cancelled',
      kitchen: 'new',
      table: 'T1',
      created: IST(`${D} 15:00`),
      subtotal: 5000,
      tax: 250,
    });
    ids.o4 = await order(alpha, {
      branch: alpha.main,
      channel: 'dine_in',
      status: 'open',
      kitchen: 'preparing',
      table: 'T2',
      created: IST(`${D} 16:00`),
      subtotal: 10000,
      tax: 500,
      payments: [{ method: 'card', amount: 3000, at: IST(`${D} 16:05`) }],
    });
    await order(alpha, {
      branch: alpha.main,
      channel: 'delivery',
      status: 'completed',
      created: IST('2025-03-11 00:10'),
      completed: IST('2025-03-11 00:10'),
      subtotal: 10000,
      tax: 500,
      payments: [{ method: 'card', amount: 10500, at: IST('2025-03-11 00:10') }],
    });
    await order(alpha, {
      branch: alpha.second,
      channel: 'dine_in',
      status: 'completed',
      customer: c3,
      created: IST(`${D} 13:00`),
      completed: IST(`${D} 13:00`),
      subtotal: 50000,
      tax: 2500,
      payments: [{ method: 'cash', amount: 52500, at: IST(`${D} 13:00`) }],
      lines: [{ item: alpha.itemC, category: alpha.catDrinks, qty: 10 }],
    });
    await order(bravo, {
      branch: bravo.main,
      channel: 'dine_in',
      status: 'completed',
      created: IST(`${D} 13:00`),
      completed: IST(`${D} 13:00`),
      subtotal: 999900,
      tax: 0,
      payments: [{ method: 'cash', amount: 999900, at: IST(`${D} 13:00`) }],
      lines: [{ item: bravo.itemA, category: bravo.catMains, qty: 1 }],
    });

    emails.admin = `admin-${suffix()}@example.test`;
    const [admin] = await migrator.query(
      `INSERT INTO users (email, full_name, password_hash, email_verified_at) VALUES ($1, 'Admin', $2, now()) RETURNING id`,
      [emails.admin, hash],
    );
    await migrator.query(
      `INSERT INTO platform_role_assignments (user_id, role_id) SELECT $1, id FROM roles WHERE tenant_id IS NULL AND code = 'super_admin'`,
      [admin.id],
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app);
    await app.init();
    const login = (who: string) =>
      http()
        .post(`${API}/auth/login`)
        .set('X-Forwarded-For', freshIp())
        .send({ email: emails[who], password: PASSWORD });
    for (const who of ['owner', 'manager', 'cashier', 'bravoOwner']) {
      tokens[who] = (await login(who).expect(200)).body.data.accessToken;
    }
    const challengeToken = (await login('admin').expect(202)).body.data.challengeToken as string;
    const setup = await http()
      .post(`${API}/auth/mfa/enroll/start`)
      .set('X-Forwarded-For', freshIp())
      .send({ challengeToken })
      .expect(200);
    const totp = new TOTP({ secret: Secret.fromBase32(setup.body.data.manualKey) });
    tokens.admin = (
      await http()
        .post(`${API}/auth/mfa/enroll/confirm`)
        .set('X-Forwarded-For', freshIp())
        .send({ challengeToken, code: totp.generate() })
        .expect(200)
    ).body.data.accessToken;
  });

  afterAll(async () => {
    await app?.close();
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
        await migrator.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
      }
      await migrator.destroy();
    }
  });

  describe('revenue and orders', () => {
    it('separates gross, net, billed, collected and refunds for a local day', async () => {
      const r = await get('owner', `/analytics/summary${day(D)}`);
      expect(r.timezone).toBe('Asia/Kolkata');
      expect(r.branchIds).toHaveLength(2);
      expect(r.revenue.grossSales.value).toBe(80000);
      expect(r.revenue.discounts.value).toBe(1000);
      expect(r.revenue.netSales.value).toBe(79000);
      expect(r.revenue.tax.value).toBe(3950);
      expect(r.revenue.billedTotal.value).toBe(82950);
      // 9 450 + 21 000 + 3 000 (partial, open order) + 52 500; O5's payment is the next local day.
      expect(r.revenue.collected.value).toBe(85950);
      expect(r.revenue.refunds.value).toBe(0);
      expect(r.revenue.netCollected.value).toBe(85950);
      expect(r.kpis.totalRevenue).toEqual({ value: 79000, previous: 0, changePct: null });
      expect(r.kpis.averageOrderValue.value).toBe(26333);
      expect(r.byMethod).toEqual([
        { method: 'cash', collectedMinor: 61950, refundsMinor: 0, netMinor: 61950, orders: 2 },
        { method: 'card', collectedMinor: 3000, refundsMinor: 0, netMinor: 3000, orders: 1 },
        { method: 'upi', collectedMinor: 21000, refundsMinor: 0, netMinor: 21000, orders: 1 },
      ]);
      expect(r.byChannel.find((c: { channel: string }) => c.channel === 'dine_in')).toMatchObject({
        orders: 4,
        completedOrders: 2,
        netSalesMinor: 59000,
      });
    });

    it('dates refunds by refund time and never double-counts them', async () => {
      const r = await get('owner', `/analytics/summary${day('2025-03-12')}`);
      expect(r.revenue.refunds.value).toBe(5000);
      expect(r.revenue.collected.value).toBe(0);
      expect(r.revenue.netCollected.value).toBe(-5000);
      expect(r.revenue.netSales.value).toBe(0);
      expect(r.byMethod.find((m: { method: string }) => m.method === 'upi').refundsMinor).toBe(
        5000,
      );
      const span = await get('owner', `/analytics/summary?preset=custom&from=${D}&to=2025-03-12`);
      // Once from the refunds table — not again from payments.refunded_minor or orders.refunded_minor.
      expect(span.revenue.refunds.value).toBe(5000);
      expect(span.revenue.collected.value).toBe(85950 + 10500);
    });

    it('counts orders by billing and kitchen status', async () => {
      const r = await get('owner', `/analytics/summary${day(D)}`);
      expect(r.orders).toEqual({
        total: 5,
        open: 1,
        completed: 3,
        cancelled: 1,
        pending: 0,
        preparing: 1,
        ready: 0,
        served: 3,
      });
      expect(r.kpis.activeTables.value).toBe(1);
    });

    it('uses restaurant-local day boundaries, not UTC', async () => {
      // O2 (00:10 IST) is 03-09 in UTC but D locally; O5 (00:10 IST on 03-11) is D in UTC.
      const prev = await get('owner', `/analytics/summary${day('2025-03-09')}`);
      expect(prev.revenue.netSales.value).toBe(0);
      const next = await get('owner', `/analytics/summary${day('2025-03-11')}`);
      expect(next.revenue.netSales.value).toBe(10000);
      // Previous-period comparison: D vs 03-09 → 0; 03-11 vs D → change against 79 000.
      expect(next.kpis.totalRevenue.previous).toBe(79000);
      expect(next.kpis.totalRevenue.changePct).toBeCloseTo(-87.3, 1);
    });

    it('buckets the trend by local hour with zero-filled gaps', async () => {
      const r = await get('owner', `/analytics/trend${day(D)}`);
      expect(r.granularity).toBe('hour');
      expect(r.points).toHaveLength(24);
      expect(r.points[0]).toMatchObject({ bucket: `${D}T00:00`, netSales: 20000, ordersPlaced: 1 });
      expect(r.points.reduce((s: number, p: { netSales: number }) => s + p.netSales, 0)).toBe(
        79000,
      );
      expect(r.points[15]).toMatchObject({ ordersPlaced: 1, cancelled: 1, netSales: 0 });
      const month = await get(
        'owner',
        '/analytics/trend?preset=custom&from=2025-03-01&to=2025-03-31',
      );
      expect(month.granularity).toBe('day');
      expect(month.points).toHaveLength(31);
    });

    it('applies order type and payment method filters', async () => {
      const take = await get('owner', `/analytics/summary${day(D, '&channel=takeaway')}`);
      expect(take.revenue.netSales.value).toBe(20000);
      expect(take.orders.total).toBe(1);
      expect(take.kpis.activeTables.value).toBe(0);
      const upi = await get('owner', `/analytics/summary${day(D, '&method=upi')}`);
      expect(upi.revenue.netSales.value).toBe(20000);
      expect(upi.revenue.collected.value).toBe(21000);
      const cash = await get('owner', `/analytics/summary${day(D, '&method=cash')}`);
      expect(cash.revenue.netSales.value).toBe(59000);
      expect(cash.revenue.collected.value).toBe(61950);
    });

    it('returns zeros, not invented numbers, for an empty period', async () => {
      const r = await get('owner', `/analytics/summary${day('2020-01-01')}`);
      expect(r.revenue.netSales).toEqual({ value: 0, previous: 0, changePct: null });
      expect(r.kpis.averageOrderValue).toEqual({ value: null, previous: null, changePct: null });
      expect(r.kpis.totalCustomers.value).toBe(0);
      const menu = await get('owner', `/analytics/menu${day('2020-01-01')}`);
      expect(menu.topSelling).toEqual([]);
      expect(menu.lowPerforming).toBeNull();
      const c = await get('owner', `/analytics/customers${day('2020-01-01')}`);
      expect(c.repeatPurchaseRatePct).toBeNull();
      expect(c.averageSpendMinor).toBeNull();
    });
  });

  describe('menu, customers and branches', () => {
    it('ranks items from active order lines of completed orders', async () => {
      const r = await get('owner', `/analytics/menu${day(D)}`);
      expect(
        r.topSelling.map((i: { name: string; quantity: number }) => [i.name, i.quantity]),
      ).toEqual([
        ['Masala Chai', 10],
        ['Dal Makhani', 4],
        ['Paneer Tikka', 2],
      ]);
      expect(r.bestPerforming[0]).toMatchObject({ name: 'Masala Chai', revenue: 50000 });
      expect(r.totals).toEqual({ itemsSold: 16, distinctItems: 3, revenueMinor: 79000 });
      expect(r.categories).toEqual([
        expect.objectContaining({ name: 'Drinks', quantity: 10, revenue: 50000, sharePct: 63.3 }),
        expect.objectContaining({ name: 'Mains', quantity: 6, revenue: 29000, sharePct: 36.7 }),
      ]);
      expect(r.unsold.map((u: { name: string }) => u.name)).toEqual(['Gulab Jamun']);
      expect(r.lowPerforming).toBeNull();
      const paged = await get(
        'owner',
        `/analytics/menu${day(D, '&sort=quantity&page=2&pageSize=2')}`,
      );
      expect(paged.items).toMatchObject({ total: 3, page: 2 });
      expect(paged.items.rows.map((i: { name: string }) => i.name)).toEqual(['Paneer Tikka']);
    });

    it('counts identified customers only, new vs returning', async () => {
      const r = await get('owner', `/analytics/customers${day(D)}`);
      expect(r).toMatchObject({
        totalCustomers: { value: 2 },
        newCustomers: 1, // C3
        returningCustomers: 1, // C1 (first order on 03-01)
        repeatCustomers: 1, // C1 ordered twice on D
        repeatPurchaseRatePct: 50,
        averageSpendMinor: 39500,
        identifiedOrders: 3,
        completedOrders: 3,
        identifiedOrderSharePct: 100,
      });
      const s = await get('owner', `/analytics/summary${day(D)}`);
      expect(s.kpis.totalCustomers.value).toBe(2);
    });

    it('compares branches for owners', async () => {
      const r = await get('owner', `/analytics/branches${day(D)}`);
      expect(
        r.rows.map((b: { id: string; rank: number; netSales: { value: number } }) => [
          b.id,
          b.rank,
          b.netSales.value,
        ]),
      ).toEqual([
        [ids.second, 1, 50000],
        [ids.main, 2, 29000],
      ]);
      expect(r.rows[1]).toMatchObject({
        completedOrders: 2,
        cancelledOrders: 1,
        averageOrderValueMinor: 14500,
      });
    });
  });

  describe('authorization and isolation', () => {
    it('limits branch managers to their branch', async () => {
      const r = await get('manager', `/analytics/summary${day(D)}`);
      expect(r.branchIds).toEqual([ids.main]);
      expect(r.branches).toHaveLength(1);
      expect(r.revenue.netSales.value).toBe(29000);
      const b = await get('manager', `/analytics/branches${day(D)}`);
      expect(b.rows).toHaveLength(1);
      await call('manager', 'get', `/analytics/summary${day(D, `&branchId=${ids.second}`)}`).expect(
        403,
      );
      await call('manager', 'get', `/analytics/menu${day(D, `&branchId=${ids.second}`)}`).expect(
        403,
      );
    });

    it('blocks roles without report:view', async () => {
      await call('cashier', 'get', `/analytics/summary${day(D)}`).expect(403);
      await call('cashier', 'get', `/analytics/trend${day(D)}`).expect(403);
    });

    it('never returns another tenant’s data, even for its ids', async () => {
      const own = await get('bravoOwner', `/analytics/summary${day(D)}`);
      expect(own.revenue.netSales.value).toBe(999900);
      await call(
        'bravoOwner',
        'get',
        `/analytics/summary${day(D, `&branchId=${ids.main}`)}`,
      ).expect(403);
      await call(
        'bravoOwner',
        'get',
        `/analytics/summary${day(D, `&restaurantId=${ids.restaurant}`)}`,
      ).expect(403);
      await call(
        'owner',
        'get',
        `/analytics/summary${day(D, `&branchId=${ids.bravoMain}`)}`,
      ).expect(403);
      const alpha = await get('owner', `/analytics/summary${day(D)}`);
      expect(alpha.revenue.netSales.value).toBe(79000);
    });

    it('validates filters', async () => {
      await call('owner', 'get', '/analytics/summary?preset=custom&from=2025-03-10').expect(400);
      await call(
        'owner',
        'get',
        '/analytics/summary?preset=today&from=2025-03-10&to=2025-03-10',
      ).expect(400);
      await call(
        'owner',
        'get',
        '/analytics/summary?preset=custom&from=2025-03-12&to=2025-03-10',
      ).expect(400);
      await call(
        'owner',
        'get',
        '/analytics/summary?preset=custom&from=2020-01-01&to=2025-01-01',
      ).expect(400);
      await call('owner', 'get', '/analytics/summary?preset=forever').expect(400);
      await call('owner', 'get', '/analytics/summary?channel=drive_thru').expect(400);
      await call('owner', 'get', '/analytics/summary?branchId=not-a-uuid').expect(400);
      await call('owner', 'get', '/analytics/summary?tenantId=x').expect(400);
    });

    it('accepts every preset', async () => {
      for (const preset of [
        'today',
        'yesterday',
        'last7',
        'last30',
        'thisMonth',
        'lastMonth',
        'thisYear',
      ]) {
        const r = await get('owner', `/analytics/summary?preset=${preset}`);
        expect(r.range.from <= r.range.to).toBe(true);
      }
    });
  });

  describe('caching', () => {
    const entries = () => app.get(CacheService).metrics.snapshot().entries;

    it('hits the cache on repeat and keeps branch scopes apart', async () => {
      const url = `/analytics/summary${day('2025-03-02')}`;
      const before = entries()['analytics:core:scope'] ?? { hits: 0, misses: 0 };
      const first = await get('owner', url);
      const second = await get('owner', url);
      const after = entries()['analytics:core:scope']!;
      expect(after.misses).toBe(before.misses + 1);
      expect(after.hits).toBe(before.hits + 1);
      expect(second.revenue).toEqual(first.revenue);
      // Same filters, narrower authorised scope → its own entry, its own (smaller) numbers.
      const mgr = await get('manager', `/analytics/summary${day(D)}`);
      const owner = await get('owner', `/analytics/summary${day(D)}`);
      expect(mgr.revenue.netSales.value).toBe(29000);
      expect(owner.revenue.netSales.value).toBe(79000);
    });

    it('invalidates after a committed order write, even for closed ranges', async () => {
      const before = await get('owner', `/analytics/summary${day(D)}`);
      expect(before.orders.preparing).toBe(1);
      await call('owner', 'post', `/kitchen/tickets/${ids.o4}/status`)
        .send({ to: 'ready' })
        .expect(200);
      const after = await get('owner', `/analytics/summary${day(D)}`);
      expect(after.orders).toMatchObject({ preparing: 0, ready: 1 });
    });

    it('falls back to PostgreSQL when Redis fails', async () => {
      const redis = app.get<Redis>(REDIS_CLIENT);
      const spy = jest.spyOn(redis, 'mget').mockRejectedValue(new Error('redis down'));
      try {
        const r = await get('owner', `/analytics/summary${day(D, '&channel=dine_in')}`);
        expect(r.revenue.netSales.value).toBe(59000);
      } finally {
        spy.mockRestore();
      }
    });

    it('serves concurrent dashboards consistently', async () => {
      const url = `/analytics/summary${day('2025-03-03')}`;
      const results = await Promise.all(Array.from({ length: 20 }, () => get('owner', url)));
      for (const r of results) expect(r.revenue).toEqual(results[0].revenue);
    });
  });

  describe('platform analytics', () => {
    it('is Super Admin only and contains no tenant sales', async () => {
      await call('owner', 'get', '/platform/analytics').expect(403);
      const r = await get('admin', '/platform/analytics');
      expect(r.tenants.total).toBeGreaterThanOrEqual(2);
      expect(r.months).toHaveLength(12);
      expect(r.months.at(-1).newTenants).toBeGreaterThanOrEqual(2);
      expect(Array.isArray(r.subscriptionsByPlan)).toBe(true);
      expect(JSON.stringify(r)).not.toContain('999900');
    });
  });
});
