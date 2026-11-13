import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DbContext } from '../src/core/db/db-context';
import { PasswordHasher } from '../src/core/security/password-hasher';
import { seedOrderPacks } from '../src/database/seeds/order-packs';
import { SubscriptionLifecycleService } from '../src/modules/billing/subscription-lifecycle.service';
import { connect } from './helpers';

/**
 * Subscription add-ons end to end: the catalogue (seed, Super Admin CRUD and validation), the
 * monthly order limit with real orders (retries counted once, concurrent orders never exceeding
 * the allowance), buying an order pack (nothing granted while pending or after a failed payment,
 * capacity added the moment payment is verified), expiry with history kept, refunds revoking
 * capacity, and tenant isolation.
 */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;
const PLAN_ORDERS = 3;

describe('Subscription add-ons (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  const tenants: string[] = [];
  const users: string[] = [];
  const emails: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  const tag = suffix();
  let alpha: { id: string; main: string };
  let chai: string;
  let pack: { id: string };

  const http = () => request(app.getHttpServer());
  const call = (who: string, method: 'get' | 'post' | 'patch', url: string) =>
    http()
      [method](`${API}${url}`)
      .set('X-Forwarded-For', freshIp())
      .set('Authorization', `Bearer ${tokens[who]}`);
  const place = (who = 'cashier', key?: string) => {
    const req = call(who, 'post', '/orders').send({
      branchId: alpha.main,
      channel: 'takeaway',
      lines: [{ menuItemId: chai, quantity: 3 }], // 3 items, still one order
    });
    return key ? req.set('Idempotency-Key', key) : req;
  };
  const market = async (who = 'owner') =>
    (await call(who, 'get', '/billing/addons').expect(200)).body.data;

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
    const [b] = await migrator.query(
      `INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone, is_default)
       VALUES ($1, $2, 'MAIN', 'Main', 'Asia/Kolkata', true) RETURNING id`,
      [t.id, r.id],
    );
    return { id: t.id as string, main: b.id as string };
  }

  async function member(key: string, tenantId: string | null, role: string, hash: string) {
    emails[key] = `ad${key}-${suffix()}@example.test`;
    users.push(emails[key]);
    const [u] = await migrator.query(
      `INSERT INTO users (email, full_name, password_hash, email_verified_at) VALUES ($1, $2, $3, now()) RETURNING id`,
      [emails[key], key, hash],
    );
    if (!tenantId) {
      await migrator.query(
        `INSERT INTO platform_role_assignments (user_id, role_id) SELECT $1, id FROM roles WHERE tenant_id IS NULL AND code = $2`,
        [u.id, role],
      );
      return;
    }
    const [m] = await migrator.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, status, joined_at) VALUES ($1, $2, 'active', now()) RETURNING id`,
      [tenantId, u.id],
    );
    await migrator.query(
      `INSERT INTO user_role_assignments (tenant_id, membership_id, role_id, scope_type)
       SELECT $1, $2, id, 'tenant' FROM roles WHERE tenant_id IS NULL AND code = $3`,
      [tenantId, m.id, role],
    );
  }

  /** A paid subscription on the Starter plan, with a tiny order limit agreed in its snapshot. */
  async function paidWithOrderLimit(tenantId: string, ordersPerMonth: number | null) {
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
          limits: { branches: 1, staff: 10, ordersPerMonth, menuItems: null, storageMb: null },
          features: [],
          featureFlags: {},
        }),
      ],
    );
  }

  beforeAll(async () => {
    migrator = await connect('migration');
    await migrator.runMigrations({ transaction: 'each' });
    const hash = await new PasswordHasher().hash(PASSWORD);
    alpha = await tenant('adalpha');
    const bravo = await tenant('adbravo');
    await member('owner', alpha.id, 'owner', hash);
    await member('cashier', alpha.id, 'cashier', hash);
    await member('bravoOwner', bravo.id, 'owner', hash);
    await member('admin', null, 'super_admin', hash);
    await paidWithOrderLimit(alpha.id, PLAN_ORDERS);
    await paidWithOrderLimit(bravo.id, PLAN_ORDERS);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app);
    await app.init();

    const login = (who: string) =>
      http()
        .post(`${API}/auth/login`)
        .set('X-Forwarded-For', freshIp())
        .send({ email: emails[who], password: PASSWORD });
    for (const who of ['owner', 'cashier', 'bravoOwner'])
      tokens[who] = (await login(who).expect(200)).body.data.accessToken;
    const first = await login('admin').expect(202);
    const challengeToken = first.body.data.challengeToken as string;
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

    await call('owner', 'post', '/menu/import')
      .send({ rows: [{ category: 'Drinks', name: 'Chai', priceMinor: 5000, diet: 'veg' }] })
      .expect(201);
    chai = (await call('owner', 'get', '/menu').expect(200)).body.data.items[0].id;
  });

  afterAll(async () => {
    await app?.close();
    if (migrator?.isInitialized) {
      for (const t of [
        'addon_grants',
        'subscription_events',
        'subscription_invoices',
        'payments',
        'order_items',
        'invoices',
        'invoice_series',
        'orders',
        'branch_order_counters',
        'menu_item_variants',
        'menu_items',
        'menu_categories',
        'user_role_assignments',
      ]) {
        await migrator.query(`DELETE FROM ${t} WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
      }
      await migrator.query(`DELETE FROM addon_packages WHERE code LIKE $1`, [`ad${tag}%`]);
      await migrator.query(
        'DELETE FROM platform_role_assignments WHERE user_id IN (SELECT id FROM users WHERE email = ANY($1::citext[]))',
        [users],
      );
      await migrator.destroy();
    }
  });

  it('seeds the example order packs once (re-running changes nothing)', async () => {
    const q = `SELECT code::text, name, quantity, price_minor::int AS price, validity, updated_at
                 FROM addon_packages WHERE code IN ('orders-500', 'orders-1000', 'orders-2500') ORDER BY quantity`;
    const before = await migrator.query(q);
    expect(before.map((p: { quantity: number; price: number }) => [p.quantity, p.price])).toEqual([
      [500, 19_900],
      [1000, 34_900],
      [2500, 69_900],
    ]);
    expect(before.every((p: { validity: string }) => p.validity === 'current_cycle')).toBe(true);
    await seedOrderPacks(migrator);
    expect(await migrator.query(q)).toEqual(before);
  });

  it('lets only Super Admins manage add-ons, with validated validity policies', async () => {
    const body = {
      code: `ad${tag}-two`,
      name: `AD ${tag} two orders`,
      addonType: 'orders',
      quantity: 2,
      priceMinor: 10_000,
    };
    await call('owner', 'post', '/platform/billing/addons').send(body).expect(403);
    await call('admin', 'post', '/platform/billing/addons')
      .send({ ...body, code: `ad${tag}-bad`, validity: 'fixed_days' })
      .expect(400);
    await call('admin', 'post', '/platform/billing/addons')
      .send({
        ...body,
        code: `ad${tag}-past`,
        validity: 'custom',
        validUntil: '2020-01-01T00:00:00Z',
      })
      .expect(400);
    await call('admin', 'post', '/platform/billing/addons')
      .send({ ...body, currencyCode: 'USD', code: `ad${tag}-usd` })
      .expect(400);
    pack = (await call('admin', 'post', '/platform/billing/addons').send(body).expect(201)).body
      .data;
    const dupName = await call('admin', 'post', '/platform/billing/addons')
      .send({ ...body, code: `ad${tag}-other`, name: body.name.toUpperCase() })
      .expect(409);
    expect(dupName.body.code).toBe('ADDON_NAME_EXISTS');

    const hidden = (
      await call('admin', 'post', '/platform/billing/addons')
        .send({ ...body, code: `ad${tag}-hidden`, name: `AD ${tag} hidden` })
        .expect(201)
    ).body.data;
    await call('admin', 'post', `/platform/billing/addons/${hidden.id}/archive`).expect(200);
    const listed = (await market()).packages.map((p: { id: string }) => p.id);
    // Archiving is reversible: restore brings it back disabled; archive it again for the checks below.
    const restored = (
      await call('admin', 'post', `/platform/billing/addons/${hidden.id}/restore`).expect(200)
    ).body.data;
    expect(restored).toMatchObject({ archivedAt: null, isActive: false });
    await call('admin', 'post', `/platform/billing/addons/${hidden.id}/archive`).expect(200);
    expect(listed).toContain(pack.id);
    expect(listed).not.toContain(hidden.id);
    const page = await call(
      'admin',
      'get',
      `/platform/billing/addons?search=ad${tag}&status=archived`,
    ).expect(200);
    expect(page.body.data.map((p: { id: string }) => p.id)).toEqual([hidden.id]);
  });

  it('counts each order once and refuses orders past the monthly allowance', async () => {
    await place('cashier', `k-${tag}-1`).expect(201);
    await place('cashier', `k-${tag}-1`).expect((r) => expect([200, 201]).toContain(r.status)); // retry
    await place().expect(201);
    await place().expect(201);
    const m = await market();
    expect(m.orders).toMatchObject({
      planLimit: PLAN_ORDERS,
      addonOrders: 0,
      total: PLAN_ORDERS,
      used: PLAN_ORDERS,
      remaining: 0,
      warning: 100,
    });
    const refused = await place().expect(403);
    expect(refused.body.code).toBe('ORDER_LIMIT_REACHED');
    expect(refused.body.checks).toMatchObject({ limit: PLAN_ORDERS, addonsAvailable: true });
  });

  let invoiceId: string;

  it('grants nothing while a purchase is pending or after a failed payment', async () => {
    await call('cashier', 'post', `/billing/addons/${pack.id}/requests`).expect(403);
    const inv = (await call('owner', 'post', `/billing/addons/${pack.id}/requests`).expect(201))
      .body.data;
    invoiceId = inv.id;
    expect(inv).toMatchObject({
      kind: 'addon',
      status: 'pending',
      amountMinor: 10_000,
      planId: null,
      addon: { addonType: 'orders', quantity: 2 },
    });
    // One payment at a time: a second request (add-on or plan) waits for this one.
    await call('owner', 'post', `/billing/addons/${pack.id}/requests`).expect(409);
    await call('owner', 'post', '/billing/subscription/checkout/failed')
      .send({ invoiceId, reason: 'Card declined' })
      .expect(204);
    const m = await market();
    expect(m.orders.total).toBe(PLAN_ORDERS);
    expect(m.pendingInvoice).toMatchObject({ id: invoiceId, failureReason: 'Card declined' });
    await place().expect(403);
    // The restaurant cannot mark its own invoice paid.
    await call('owner', 'post', `/platform/billing/invoices/${invoiceId}/mark-paid`)
      .send({ paymentMethod: 'upi', paymentReference: 'self' })
      .expect(403);
  });

  it('adds capacity as soon as the payment is verified, and keeps concurrent orders within it', async () => {
    await call('admin', 'post', `/platform/billing/invoices/${invoiceId}/mark-paid`)
      .send({ paymentMethod: 'upi', paymentReference: `UTR${tag}` })
      .expect((r) => expect([200, 201]).toContain(r.status));
    const m = await market();
    expect(m.orders).toMatchObject({ total: PLAN_ORDERS + 2, used: PLAN_ORDERS, remaining: 2 });
    expect(m.purchases[0]).toMatchObject({
      invoiceId,
      quantity: 2,
      status: 'active',
      used: 0,
      remaining: 2,
    });

    // Five orders at once against two remaining slots: exactly two succeed.
    const results = await Promise.all(Array.from({ length: 5 }, () => place()));
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([201, 201, 403, 403, 403]);
    const after = await market();
    expect(after.orders).toMatchObject({ used: PLAN_ORDERS + 2, remaining: 0, warning: 100 });
    expect(after.purchases[0]).toMatchObject({ used: 2, remaining: 0 });
  });

  it('stops counting an add-on at expiry but keeps its history', async () => {
    const lifecycle = app.get(SubscriptionLifecycleService);
    await migrator.query(
      `UPDATE addon_grants SET starts_at = now() - interval '2 days', expires_at = now() - interval '1 minute'
        WHERE invoice_id = $1`,
      [invoiceId],
    );
    const m = await market();
    expect(m.orders.total).toBe(PLAN_ORDERS);
    expect(m.purchases[0]).toMatchObject({ invoiceId, status: 'expired', used: null });
    await place().expect(403);
    await app.get(DbContext).run({ platform: true }, (db) => lifecycle.recordAddonExpiries(db));
    const [evt] = await migrator.query(
      `SELECT event, metadata FROM subscription_events WHERE invoice_id = $1 AND event = 'addon_expired'`,
      [invoiceId],
    );
    expect(evt.metadata).toMatchObject({ quantity: 2, addonType: 'orders' });
    const [{ n }] = await migrator.query(
      `SELECT count(*)::int AS n FROM addon_grants WHERE invoice_id = $1`,
      [invoiceId],
    );
    expect(n).toBe(1);
  });

  it('revokes capacity on refund, once, and only for add-on invoices', async () => {
    const inv = (await call('owner', 'post', `/billing/addons/${pack.id}/requests`).expect(201))
      .body.data;
    await call('admin', 'post', `/platform/billing/invoices/${inv.id}/mark-paid`)
      .send({ paymentMethod: 'bank_transfer', paymentReference: `NEFT${tag}` })
      .expect((r) => expect([200, 201]).toContain(r.status));
    expect((await market()).orders.remaining).toBe(0); // 5 used of 3 + 2
    await place().expect(403);

    const refunded = await call('admin', 'post', `/platform/billing/invoices/${inv.id}/refund`)
      .send({ reason: 'Bought by mistake' })
      .expect(200);
    expect(refunded.body.data).toMatchObject({
      status: 'refunded',
      refundReason: 'Bought by mistake',
    });
    const m = await market();
    expect(m.orders.total).toBe(PLAN_ORDERS);
    expect(m.purchases.find((p: { invoiceId: string }) => p.invoiceId === inv.id)).toMatchObject({
      status: 'revoked',
      revokeReason: 'Bought by mistake',
    });
    await call('admin', 'post', `/platform/billing/invoices/${inv.id}/refund`)
      .send({ reason: 'again' })
      .expect(200);
    const [{ n }] = await migrator.query(
      `SELECT count(*)::int AS n FROM subscription_events WHERE invoice_id = $1 AND event = 'addon_revoked'`,
      [inv.id],
    );
    expect(n).toBe(1);
    await call('owner', 'post', `/platform/billing/invoices/${inv.id}/refund`)
      .send({ reason: 'self refund' })
      .expect(403);
  });

  it('keeps add-ons, purchases and payments within the restaurant', async () => {
    const bravo = await market('bravoOwner');
    expect(bravo.purchases).toEqual([]);
    expect(bravo.orders.total).toBe(PLAN_ORDERS);
    const inv = (await call('owner', 'post', `/billing/addons/${pack.id}/requests`).expect(201))
      .body.data;
    await call('bravoOwner', 'post', `/billing/invoices/${inv.id}/checkout`).expect((r) =>
      expect([400, 404]).toContain(r.status),
    );
    await call('bravoOwner', 'post', `/billing/invoices/${inv.id}/cancel`).expect((r) =>
      expect([400, 404]).toContain(r.status),
    );
    await call('owner', 'post', `/billing/invoices/${inv.id}/cancel`).expect(204);
  });

  it('refuses add-ons the plan does not need', async () => {
    await paidWithOrderLimit(alpha.id, null); // unlimited orders
    const res = await call('owner', 'post', `/billing/addons/${pack.id}/requests`).expect(400);
    expect(res.body.code).toBe('ADDON_NOT_NEEDED');
    expect((await market()).orders).toMatchObject({ total: null, remaining: null });
  });
});
