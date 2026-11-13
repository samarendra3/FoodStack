import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { configureApp } from '../src/app.setup';
import { PasswordHasher } from '../src/core/security/password-hasher';
import { connect } from './helpers';

/**
 * Phase 6: customer online payments into the restaurant's OWN Razorpay account, against a local
 * fake Razorpay that authenticates and signs exactly like the real one.
 */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const KEY_ID = 'rzp_test_Abc123Def456';
const KEY_SECRET = 'test_secret_9f8e7d6c5b4a';
const WEBHOOK_SECRET = 'whsec_restaurant_only_123';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;
const hmac = (secret: string, data: string) =>
  createHmac('sha256', secret).update(data).digest('hex');

// ---------------------------------------------------------------- fake Razorpay
interface FakePayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: 'authorized' | 'captured' | 'failed';
}
const fake = {
  orders: new Map<string, { id: string; amount: number; currency: string }>(),
  payments: new Map<string, FakePayment>(),
  refunds: [] as { paymentId: string; amount: number }[],
  failRefunds: false,
};
function startFake(): Promise<Server> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const auth = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
      if (req.headers.authorization !== `Basic ${auth}`) {
        return send(401, {
          error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' },
        });
      }
      const url = new URL(req.url!, 'http://x');
      const json = body ? JSON.parse(body) : {};
      if (req.method === 'GET' && url.pathname === '/v1/orders') return send(200, { items: [] });
      if (req.method === 'POST' && url.pathname === '/v1/orders') {
        const o = {
          id: `order_${suffix()}${suffix()}`,
          amount: json.amount,
          currency: json.currency,
        };
        fake.orders.set(o.id, o);
        return send(200, { ...o, status: 'created' });
      }
      const m = /^\/v1\/payments\/([^/]+)(\/capture|\/refund)?$/.exec(url.pathname);
      const p = m ? fake.payments.get(m[1]!) : undefined;
      if (!m || !p) return send(404, { error: { description: 'not found' } });
      if (req.method === 'GET' && !m[2]) return send(200, p);
      if (req.method === 'POST' && m[2] === '/capture') {
        p.status = 'captured';
        return send(200, p);
      }
      if (req.method === 'POST' && m[2] === '/refund') {
        if (fake.failRefunds) return send(400, { error: { description: 'Refund not allowed' } });
        fake.refunds.push({ paymentId: p.id, amount: json.amount });
        return send(200, { id: `rfnd_${suffix()}`, amount: json.amount, status: 'processed' });
      }
      return send(404, {});
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}
/** The customer completes Checkout: the gateway records a payment for the order. */
function customerPays(
  gatewayOrderId: string,
  amount: number,
  status: FakePayment['status'] = 'captured',
) {
  const o = fake.orders.get(gatewayOrderId)!;
  const p: FakePayment = {
    id: `pay_${suffix()}${suffix()}`,
    order_id: o.id,
    amount,
    currency: o.currency,
    status,
  };
  fake.payments.set(p.id, p);
  return { paymentId: p.id, signature: hmac(KEY_SECRET, `${o.id}|${p.id}`) };
}

describe('Online payments into the restaurant account (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  let fakeServer: Server;
  const tenants: string[] = [];
  const emails: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  let restaurantId: string;
  let alphaId: string;
  let table: string;
  let tableKey: string;
  let chai: string;
  let webhookPath: string;
  const saved = {
    enabled: process.env.ONLINE_PAYMENTS_ENABLED,
    base: process.env.RAZORPAY_API_BASE,
  };

  const call = (who: string, method: 'get' | 'post' | 'put' | 'delete', url: string) =>
    request(app.getHttpServer())
      [method](`${API}${url}`)
      .set('X-Forwarded-For', freshIp())
      .set('Authorization', `Bearer ${tokens[who]}`);
  const guest = (method: 'get' | 'post', url: string, token: string) =>
    request(app.getHttpServer())
      [method](`${API}/public/guest${url}`)
      .set('X-Forwarded-For', freshIp())
      .set('X-Guest-Token', token);

  async function member(key: string, tenantId: string, role: string, hash: string) {
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
       SELECT $1, $2, id, 'tenant', NULL FROM roles WHERE tenant_id IS NULL AND code = $3`,
      [tenantId, m.id, role],
    );
  }

  beforeAll(async () => {
    fakeServer = await startFake();
    process.env.ONLINE_PAYMENTS_ENABLED = 'true';
    process.env.RAZORPAY_API_BASE = `http://127.0.0.1:${(fakeServer.address() as AddressInfo).port}`;
    migrator = await connect('migration');
    await migrator.runMigrations({ transaction: 'each' });
    const hash = await new PasswordHasher().hash(PASSWORD);
    for (const label of ['payalpha', 'paybravo']) {
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
      await migrator.query(
        `INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone, is_default)
         VALUES ($1, $2, 'MAIN', 'Main', 'Asia/Kolkata', true)`,
        [t.id, r.id],
      );
      if (label === 'payalpha') {
        alphaId = t.id;
        restaurantId = r.id;
      }
      await member(label === 'payalpha' ? 'owner' : 'bravoOwner', t.id, 'owner', hash);
    }
    await member('waiter', alphaId, 'waiter', hash);

    // Imported after the env flags above: ConfigModule reads process.env at import time.
    const { AppModule } = await import('../src/app.module');
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
    await call('owner', 'post', '/menu/import')
      .send({ rows: [{ category: 'Drinks', name: 'Chai', priceMinor: 5000, diet: 'veg' }] })
      .expect(201);
    chai = (await call('owner', 'get', '/menu').expect(200)).body.data.items[0].id;
    const [b] = await migrator.query(`SELECT id FROM branches WHERE tenant_id = $1`, [alphaId]);
    table = (
      await call('owner', 'post', '/tables').send({ branchId: b.id, label: 'P1' }).expect(201)
    ).body.data.id;
    tableKey = (await migrator.query('SELECT qr_key FROM dining_tables WHERE id = $1', [table]))[0]
      .qr_key;
  });

  afterAll(async () => {
    await app?.close();
    fakeServer?.close();
    if (saved.enabled === undefined) delete process.env.ONLINE_PAYMENTS_ENABLED;
    else process.env.ONLINE_PAYMENTS_ENABLED = saved.enabled;
    if (saved.base === undefined) delete process.env.RAZORPAY_API_BASE;
    else process.env.RAZORPAY_API_BASE = saved.base;
    if (migrator?.isInitialized) {
      for (const t of [
        'invoices',
        'invoice_series',
        'refunds',
        'payments',
        'payment_intents',
        'gateway_events',
        'restaurant_payment_accounts',
        'order_items',
        'orders',
        'table_guests',
        'table_sessions',
        'dining_tables',
        'branch_order_counters',
        'menu_items',
        'menu_categories',
        'user_role_assignments',
      ]) {
        await migrator.query(`DELETE FROM ${t} WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
      }
      await migrator.destroy();
    }
  });

  async function guestWithOrder(qty = 1) {
    const token = (
      await request(app.getHttpServer())
        .post(`${API}/public/guest/join`)
        .set('X-Forwarded-For', freshIp())
        .send({ tenantId: alphaId, tableId: table, key: tableKey })
        .expect(200)
    ).body.data.token as string;
    const order = (
      await guest('post', '/orders', token)
        .set('Idempotency-Key', randomUUID())
        .send({ paymentPreference: 'online', lines: [{ menuItemId: chai, quantity: qty }] })
        .expect(201)
    ).body.data.order as { id: string; totalMinor: number };
    return { token, order };
  }
  const webhook = (
    event: string,
    payment: FakePayment,
    eventId = `evt_${suffix()}`,
    secret = WEBHOOK_SECRET,
  ) => {
    const body = JSON.stringify({ event, payload: { payment: { entity: payment } } });
    return request(app.getHttpServer())
      .post(webhookPath)
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', hmac(secret, body))
      .set('X-Razorpay-Event-Id', eventId)
      .send(body);
  };

  it('connects the restaurant account only with working keys, and never returns secrets', async () => {
    const put = (who: string, body: object) =>
      call(who, 'put', '/payments/gateway-account').send({ restaurantId, ...body });
    await put('owner', {
      keyId: 'not_a_key',
      keySecret: KEY_SECRET,
      webhookSecret: WEBHOOK_SECRET,
    }).expect(400);
    await put('owner', {
      keyId: KEY_ID,
      keySecret: 'wrong_secret_value',
      webhookSecret: WEBHOOK_SECRET,
    }).expect(400);
    await put('waiter', {
      keyId: KEY_ID,
      keySecret: KEY_SECRET,
      webhookSecret: WEBHOOK_SECRET,
    }).expect(403);
    const acc = (
      await put('owner', {
        keyId: KEY_ID,
        keySecret: KEY_SECRET,
        webhookSecret: WEBHOOK_SECRET,
      }).expect(200)
    ).body.data;
    expect(acc).toMatchObject({ provider: 'razorpay', keyId: KEY_ID, mode: 'test', enabled: true });
    webhookPath = acc.webhookPath;
    const shown = JSON.stringify(
      (
        await call('owner', 'get', `/payments/gateway-account?restaurantId=${restaurantId}`).expect(
          200,
        )
      ).body,
    );
    expect(shown).not.toContain(KEY_SECRET);
    expect(shown).not.toContain(WEBHOOK_SECRET);
    const [row] = await migrator.query(
      `SELECT key_secret_enc, webhook_secret_enc FROM restaurant_payment_accounts WHERE restaurant_id = $1`,
      [restaurantId],
    );
    expect(Buffer.from(row.key_secret_enc).toString('latin1')).not.toContain(KEY_SECRET);
    // Another tenant cannot read or replace it.
    const other = await call(
      'bravoOwner',
      'get',
      `/payments/gateway-account?restaurantId=${restaurantId}`,
    );
    expect([403, 404]).toContain(other.status);
  });

  it('pays a guest order: server amount, verified signature, gateway-confirmed, recorded once', async () => {
    const { token, order } = await guestWithOrder(2);
    expect((await guest('get', '', token).expect(200)).body.data.onlinePayment).toBe(true);
    const intent = (await guest('post', `/orders/${order.id}/pay`, token).expect(200)).body.data;
    expect(intent).toMatchObject({ keyId: KEY_ID, amountMinor: order.totalMinor, currency: 'INR' });
    expect(JSON.stringify(intent)).not.toContain(KEY_SECRET);

    const paid = customerPays(intent.gatewayOrderId, order.totalMinor);
    // A forged signature is refused and records nothing.
    await guest('post', '/payments/confirm', token)
      .send({ intentId: intent.intentId, paymentId: paid.paymentId, signature: 'a'.repeat(64) })
      .expect(400);
    const ok = (
      await guest('post', '/payments/confirm', token)
        .send({ intentId: intent.intentId, paymentId: paid.paymentId, signature: paid.signature })
        .expect(200)
    ).body.data;
    expect(ok.status).toBe('paid');
    // Browser retry + the gateway's webhook for the same payment: still one payment.
    await guest('post', '/payments/confirm', token)
      .send({ intentId: intent.intentId, paymentId: paid.paymentId, signature: paid.signature })
      .expect(200);
    await webhook('payment.captured', fake.payments.get(paid.paymentId)!).expect(200);
    const rows = await migrator.query(
      `SELECT method, amount_minor, gateway_payment_id FROM payments WHERE order_id = $1`,
      [order.id],
    );
    expect(rows).toEqual([
      {
        method: 'online',
        amount_minor: String(order.totalMinor),
        gateway_payment_id: paid.paymentId,
      },
    ]);
    const detail = (await call('owner', 'get', `/orders/${order.id}`).expect(200)).body.data;
    expect(detail).toMatchObject({ status: 'completed', paidMinor: order.totalMinor });
  });

  it('records a payment from the signed webhook alone, once per event and per payment', async () => {
    const { token, order } = await guestWithOrder();
    const intent = (await guest('post', `/orders/${order.id}/pay`, token).expect(200)).body.data;
    const paid = customerPays(intent.gatewayOrderId, order.totalMinor, 'authorized'); // capture needed
    const p = fake.payments.get(paid.paymentId)!;
    await webhook('payment.captured', p, 'evt_dup_1', 'wrong-secret').expect(400);
    expect((await webhook('payment.captured', p, 'evt_dup_1').expect(200)).body.data.status).toBe(
      'paid',
    );
    expect(p.status).toBe('captured'); // authorised payment was captured with the restaurant's keys
    expect((await webhook('payment.captured', p, 'evt_dup_1').expect(200)).body.data.status).toBe(
      'duplicate',
    );
    expect((await webhook('order.paid', p, 'evt_other').expect(200)).body.data.status).toBe(
      'already_paid',
    );
    const n = await migrator.query(`SELECT count(*)::int AS n FROM payments WHERE order_id = $1`, [
      order.id,
    ]);
    expect(n[0].n).toBe(1);
  });

  it('never trusts a mismatched amount; a failed payment leaves the bill payable at the counter', async () => {
    const a = await guestWithOrder();
    const ia = (await guest('post', `/orders/${a.order.id}/pay`, a.token).expect(200)).body.data;
    const short = customerPays(ia.gatewayOrderId, a.order.totalMinor - 100);
    const r = (
      await guest('post', '/payments/confirm', a.token)
        .send({ intentId: ia.intentId, paymentId: short.paymentId, signature: short.signature })
        .expect(200)
    ).body.data;
    expect(r.status).toBe('needs_review');
    expect(
      (
        await migrator.query(`SELECT count(*)::int AS n FROM payments WHERE order_id = $1`, [
          a.order.id,
        ])
      )[0].n,
    ).toBe(0);

    const b = await guestWithOrder();
    const ib = (await guest('post', `/orders/${b.order.id}/pay`, b.token).expect(200)).body.data;
    const failed: FakePayment = {
      id: `pay_${suffix()}${suffix()}`,
      order_id: ib.gatewayOrderId,
      amount: b.order.totalMinor,
      currency: 'INR',
      status: 'failed',
    };
    expect((await webhook('payment.failed', failed).expect(200)).body.data.status).toBe('failed');
    await call('owner', 'post', `/orders/${b.order.id}/payments`)
      .set('Idempotency-Key', randomUUID())
      .send({ method: 'cash', amountMinor: b.order.totalMinor })
      .expect(201);
  });

  it('refunds online payments through the restaurant gateway, or not at all', async () => {
    const { token, order } = await guestWithOrder();
    const intent = (await guest('post', `/orders/${order.id}/pay`, token).expect(200)).body.data;
    const paid = customerPays(intent.gatewayOrderId, order.totalMinor);
    await guest('post', '/payments/confirm', token)
      .send({ intentId: intent.intentId, paymentId: paid.paymentId, signature: paid.signature })
      .expect(200);
    const [pay] = await migrator.query(`SELECT id FROM payments WHERE order_id = $1`, [order.id]);

    fake.failRefunds = true;
    await call('owner', 'post', `/payments/${pay.id}/refunds`)
      .send({ amountMinor: 1000, reason: 'Cold' })
      .expect(503);
    expect(
      (
        await migrator.query(`SELECT count(*)::int AS n FROM refunds WHERE payment_id = $1`, [
          pay.id,
        ])
      )[0].n,
    ).toBe(0);
    fake.failRefunds = false;
    await call('owner', 'post', `/payments/${pay.id}/refunds`)
      .send({ amountMinor: 1000, reason: 'Cold' })
      .expect(201);
    expect(fake.refunds).toContainEqual({ paymentId: paid.paymentId, amount: 1000 });
  });

  it('lets a guest pay only their own orders', async () => {
    const a = await guestWithOrder();
    const b = await guestWithOrder();
    await guest('post', `/orders/${a.order.id}/pay`, b.token).expect(404);
  });

  // ---- Phase 7: billing desk and reconciliation ----

  describe('billing desk', () => {
    let branchId: string;
    beforeAll(async () => {
      branchId = (
        await migrator.query(`SELECT id FROM branches WHERE tenant_id = $1`, [alphaId])
      )[0].id;
    });
    const counterOrder = async () =>
      (
        await call('owner', 'post', '/orders')
          .set('Idempotency-Key', `o-${suffix()}${suffix()}`)
          .send({
            branchId,
            channel: 'dine_in',
            tableLabel: 'D1',
            lines: [{ menuItemId: chai, quantity: 2 }],
          })
          .expect(201)
      ).body.data as { id: string; totalMinor: number };

    it('never collects twice for a retried or double-tapped payment', async () => {
      const o = await counterOrder();
      const key = `pay-${suffix()}${suffix()}`;
      const pay = (orderId: string) =>
        call('owner', 'post', `/orders/${orderId}/payments`)
          .set('Idempotency-Key', key)
          .send({ method: 'cash', amountMinor: 1000 });
      const [a, b] = await Promise.all([pay(o.id), pay(o.id)]);
      expect([a.status, b.status]).toEqual([201, 201]);
      const rows = await migrator.query(
        `SELECT count(*)::int AS n FROM payments WHERE order_id = $1`,
        [o.id],
      );
      expect(rows[0].n).toBe(1);
      const other = await counterOrder();
      await pay(other.id).expect(409); // same key, different bill
    });

    it('lists bills by payment status with day totals', async () => {
      const o = await counterOrder();
      let desk = (await call('owner', 'get', `/billing/bills?branchId=${branchId}`).expect(200))
        .body.data;
      expect(desk.bills.find((b: { id: string }) => b.id === o.id)).toMatchObject({
        paymentStatus: 'pending',
        dueMinor: o.totalMinor,
      });
      await call('owner', 'post', `/orders/${o.id}/payments`)
        .set('Idempotency-Key', `p-${suffix()}${suffix()}`)
        .send({ method: 'card', amountMinor: 1000 })
        .expect(201);
      desk = (
        await call(
          'owner',
          'get',
          `/billing/bills?branchId=${branchId}&paymentStatus=partially_paid`,
        ).expect(200)
      ).body.data;
      expect(desk.bills.map((b: { id: string }) => b.id)).toContain(o.id);
      expect(
        desk.bills.every((b: { paymentStatus: string }) => b.paymentStatus === 'partially_paid'),
      ).toBe(true);
      expect(desk.totals.partially_paid.count).toBeGreaterThanOrEqual(1);
      const paid = (
        await call(
          'owner',
          'get',
          `/billing/bills?branchId=${branchId}&paymentStatus=paid,refunded,partially_refunded`,
        ).expect(200)
      ).body.data;
      expect(paid.bills.some((b: { methods: string[] }) => b.methods.includes('online'))).toBe(
        true,
      );
      // Waiters may view bills (order:read) but never collect money (needs pos:access).
      await call('waiter', 'get', `/billing/bills?branchId=${branchId}`).expect(200);
      await call('waiter', 'post', `/orders/${o.id}/payments`)
        .set('Idempotency-Key', `w-${suffix()}${suffix()}`)
        .send({ method: 'cash', amountMinor: 100 })
        .expect(403);
      const foreign = await call('bravoOwner', 'get', `/billing/bills?branchId=${branchId}`);
      expect(foreign.status).toBe(403);
    });

    it('reconciles collections, surfaces payments needing review, and checks integrity', async () => {
      const rec = (
        await call('owner', 'get', `/billing/reconciliation?branchId=${branchId}`).expect(200)
      ).body.data;
      const online = rec.methods.find((m: { method: string }) => m.method === 'online');
      expect(online.refundedMinor).toBe(1000); // the online refund made earlier
      expect(online.netMinor).toBe(online.collectedMinor - 1000);
      expect(rec.totalNetMinor).toBe(rec.totalCollectedMinor - rec.totalRefundedMinor);
      expect(rec.integrity).toEqual({
        paidMismatch: 0,
        completedUnpaid: 0,
        orphanOnlinePayments: 0,
        ok: true,
      });
      expect(rec.needsReview.length).toBeGreaterThanOrEqual(1);

      const review = rec.needsReview[0];
      await call('waiter', 'post', `/billing/payment-reviews/${review.intentId}/resolve`)
        .send({ note: 'Refunded in Razorpay dashboard' })
        .expect(403);
      await call('owner', 'post', `/billing/payment-reviews/${review.intentId}/resolve`)
        .send({ note: 'Refunded in Razorpay dashboard' })
        .expect(200);
      await call('owner', 'post', `/billing/payment-reviews/${review.intentId}/resolve`)
        .send({ note: 'again' })
        .expect(409);
      const after = (
        await call('owner', 'get', `/billing/reconciliation?branchId=${branchId}`).expect(200)
      ).body.data;
      expect(
        after.needsReview.some((r: { intentId: string }) => r.intentId === review.intentId),
      ).toBe(false);
    });

    it('derives payment status from the money and nothing else', async () => {
      const o = await counterOrder();
      const status = async () =>
        (await migrator.query(`SELECT payment_status FROM orders WHERE id = $1`, [o.id]))[0]
          .payment_status;
      expect(await status()).toBe('pending');
      const pay = (
        await call('owner', 'post', `/orders/${o.id}/payments`)
          .set('Idempotency-Key', `p-${suffix()}${suffix()}`)
          .send({ method: 'cash', amountMinor: o.totalMinor })
          .expect(201)
      ).body.data;
      expect(await status()).toBe('paid');
      await call('owner', 'post', `/payments/${pay.payments[0].id}/refunds`)
        .send({ amountMinor: 500, reason: 'Late' })
        .expect(201);
      expect(await status()).toBe('partially_refunded');
      await call('owner', 'post', `/payments/${pay.payments[0].id}/refunds`)
        .send({ amountMinor: o.totalMinor - 500, reason: 'Late' })
        .expect(201);
      expect(await status()).toBe('refunded');
    });
  });

  // ---- Phase 8: GST invoices ----

  describe('GST invoices', () => {
    let branchId: string;
    beforeAll(async () => {
      branchId = (
        await migrator.query(`SELECT id FROM branches WHERE tenant_id = $1`, [alphaId])
      )[0].id;
      await migrator.query(
        `UPDATE restaurants SET gstin = '29ABCDE1234F1Z5', state = 'Karnataka', address_line = '1 MG Road', city = 'Bengaluru'
          WHERE id = $1`,
        [restaurantId],
      );
    });
    const settled = async () => {
      const o = (
        await call('owner', 'post', '/orders')
          .set('Idempotency-Key', `o-${suffix()}${suffix()}`)
          .send({
            branchId,
            channel: 'dine_in',
            tableLabel: 'G1',
            lines: [{ menuItemId: chai, quantity: 3 }],
          })
          .expect(201)
      ).body.data as { id: string; totalMinor: number };
      await call('owner', 'post', `/orders/${o.id}/payments`)
        .set('Idempotency-Key', `p-${suffix()}${suffix()}`)
        .send({ method: 'upi', amountMinor: o.totalMinor, reference: 'UPI123' })
        .expect(201);
      return o;
    };
    const invoiceOf = async (orderId: string) =>
      (await call('owner', 'get', `/orders/${orderId}/invoice`).expect(200)).body.data;

    it('issues a GST tax invoice automatically when the bill is settled', async () => {
      const o = await settled();
      const inv = await invoiceOf(o.id);
      expect(inv.invoiceNumber).toMatch(/^MAIN\/\d{2}-\d{2}\/\d{5}$/);
      const s = inv.snapshot;
      expect(s).toMatchObject({
        title: 'TAX INVOICE',
        sac: '996331',
        placeOfSupply: 'Karnataka',
        seller: { gstin: '29ABCDE1234F1Z5' },
        totalMinor: o.totalMinor,
        paymentStatus: 'paid',
      });
      expect(s.taxSplit.map((t: { label: string }) => t.label)).toEqual(['CGST', 'SGST']);
      expect(
        s.taxSplit.reduce((a: number, t: { amountMinor: number }) => a + t.amountMinor, 0),
      ).toBe(s.taxMinor);
      expect(s.taxableMinor + s.taxMinor).toBe(s.totalMinor);
      expect(s.payments[0]).toMatchObject({ method: 'upi', reference: 'UPI123' });
    });

    it('numbers invoices consecutively without gaps, even when bills settle at the same time', async () => {
      const orders = await Promise.all(
        [1, 2, 3, 4, 5].map(() =>
          call('owner', 'post', '/orders')
            .set('Idempotency-Key', `o-${suffix()}${suffix()}`)
            .send({
              branchId,
              channel: 'dine_in',
              tableLabel: 'G2',
              lines: [{ menuItemId: chai, quantity: 1 }],
            })
            .expect(201)
            .then((r) => r.body.data as { id: string; totalMinor: number }),
        ),
      );
      await Promise.all(
        orders.map((o) =>
          call('owner', 'post', `/orders/${o.id}/payments`)
            .set('Idempotency-Key', `p-${suffix()}${suffix()}`)
            .send({ method: 'cash', amountMinor: o.totalMinor })
            .expect(201),
        ),
      );
      const all = (await migrator.query(
        `SELECT series_number FROM invoices WHERE branch_id = $1 ORDER BY series_number`,
        [branchId],
      )) as { series_number: number }[];
      const n = all.map((r) => r.series_number);
      expect(n).toEqual(Array.from({ length: n.length }, (_, i) => i + 1)); // 1..N, no gaps
    });

    it('is idempotent, refuses unpaid bills, and keeps the snapshot frozen', async () => {
      const o = await settled();
      const first = await invoiceOf(o.id);
      const again = (await call('owner', 'post', `/orders/${o.id}/invoice`).expect(200)).body.data;
      expect(again.id).toBe(first.id);
      const unpaid = (
        await call('owner', 'post', '/orders')
          .set('Idempotency-Key', `o-${suffix()}${suffix()}`)
          .send({ branchId, channel: 'dine_in', lines: [{ menuItemId: chai, quantity: 1 }] })
          .expect(201)
      ).body.data;
      await call('owner', 'post', `/orders/${unpaid.id}/invoice`).expect(409);
      expect(
        (await call('owner', 'get', `/orders/${unpaid.id}/invoice`).expect(200)).body.data,
      ).toBeNull();

      await migrator.query(`UPDATE restaurants SET name = 'Renamed Cafe' WHERE id = $1`, [
        restaurantId,
      ]);
      expect((await invoiceOf(o.id)).snapshot.seller.name).not.toBe('Renamed Cafe');
    });

    it('renders the PDF and keeps invoices to their restaurant', async () => {
      const o = await settled();
      const inv = await invoiceOf(o.id);
      const pdf = await call('owner', 'get', `/invoices/${inv.id}/pdf`)
        .buffer(true)
        .parse((res, cb) => {
          const parts: Buffer[] = [];
          res.on('data', (c: Buffer) => parts.push(c));
          res.on('end', () => cb(null, Buffer.concat(parts)));
        })
        .expect(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect((pdf.body as Buffer).length).toBeGreaterThan(1500);
      // Waiters can read bills; another restaurant cannot.
      await call('waiter', 'get', `/invoices/${inv.id}`).expect(200);
      const foreign = await call('bravoOwner', 'get', `/invoices/${inv.id}/pdf`);
      expect([403, 404]).toContain(foreign.status);
      const list = (await call('owner', 'get', `/invoices?branchId=${branchId}`).expect(200)).body
        .data;
      expect(list.some((x: { id: string }) => x.id === inv.id)).toBe(true);
    });

    it('invoices online payments with the gateway reference', async () => {
      const { token, order } = await guestWithOrder();
      const intent = (await guest('post', `/orders/${order.id}/pay`, token).expect(200)).body.data;
      const paid = customerPays(intent.gatewayOrderId, order.totalMinor);
      await guest('post', '/payments/confirm', token)
        .send({ intentId: intent.intentId, paymentId: paid.paymentId, signature: paid.signature })
        .expect(200);
      const inv = await invoiceOf(order.id);
      expect(inv.snapshot.payments[0]).toMatchObject({
        method: 'online',
        reference: paid.paymentId,
      });
    });
  });
});
