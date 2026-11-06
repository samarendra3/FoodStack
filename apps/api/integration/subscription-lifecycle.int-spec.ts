import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import type { AppConfigService } from '../src/config/app-config.service';
import { PasswordHasher } from '../src/core/security/password-hasher';
import { hmacHex, PAYMENT_GATEWAY, RazorpayGateway } from '../src/modules/billing/payment-gateway';
import { SubscriptionLifecycleService } from '../src/modules/billing/subscription-lifecycle.service';
import { EXPIRED_MESSAGE } from '../src/modules/billing/subscription-state';
import { DbContext } from '../src/core/db/db-context';
import { connect } from './helpers';

/**
 * Trial and subscription lifecycle: 15-day trial created by the database, expiry enforced on
 * every request (without waiting for the sweep), idempotent background sweep, data kept,
 * online checkout with server-side signature verification, payment failure, automatic
 * reactivation, signed and de-duplicated webhooks, tenant isolation and Super Admin controls.
 */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const KEY_SECRET = 'test-key-secret';
const HOOK_SECRET = 'test-hook-secret';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;

/** Real Razorpay signature checks with fixed secrets; only order creation is faked (no network). */
class FakeGateway extends RazorpayGateway {
  orders = 0;
  constructor() {
    super({
      get: (k: string) =>
        ({
          RAZORPAY_KEY_ID: 'rzp_test_key',
          RAZORPAY_KEY_SECRET: KEY_SECRET,
          RAZORPAY_WEBHOOK_SECRET: HOOK_SECRET,
        })[k],
    } as unknown as AppConfigService);
  }
  override async createOrder() {
    this.orders++;
    return { orderId: `order_${suffix()}` };
  }
}

describe('Subscription lifecycle (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  let lifecycle: SubscriptionLifecycleService;
  const gateway = new FakeGateway();
  const tenants: string[] = [];
  const users: string[] = [];
  const emails: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  let alpha: string;
  let bravo: string;
  let plan: string;

  const call = (who: string, method: 'get' | 'post', url: string) =>
    request(app.getHttpServer())
      [method](`${API}${url}`)
      .set('X-Forwarded-For', freshIp())
      .set('Authorization', `Bearer ${tokens[who]}`);
  const login = (who: string) =>
    request(app.getHttpServer())
      .post(`${API}/auth/login`)
      .set('X-Forwarded-For', freshIp())
      .send({ email: emails[who], password: PASSWORD });
  const subRow = async (tenantId: string) =>
    (await migrator.query(`SELECT * FROM subscriptions WHERE tenant_id = $1`, [tenantId]))[0];
  const events = async (tenantId: string): Promise<string[]> =>
    (
      await migrator.query(
        `SELECT event FROM subscription_events WHERE tenant_id = $1 ORDER BY created_at, id`,
        [tenantId],
      )
    ).map((r: { event: string }) => r.event);
  /** Moves the trial end into the past without touching tenants (as the clock would). */
  const endTrial = (tenantId: string) =>
    migrator.query(
      `UPDATE subscriptions SET current_period_start = now() - interval '16 days',
              trial_ends_at = now() - interval '1 hour', current_period_end = now() - interval '1 hour'
        WHERE tenant_id = $1`,
      [tenantId],
    );
  const webhook = (body: object, opts: { secret?: string; eventId?: string } = {}) => {
    const raw = JSON.stringify(body);
    return request(app.getHttpServer())
      .post(`${API}/billing/webhooks/razorpay`)
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', hmacHex(opts.secret ?? HOOK_SECRET, raw))
      .set('X-Razorpay-Event-Id', opts.eventId ?? `evt_${suffix()}`)
      .send(raw);
  };

  async function user(key: string, hash: string) {
    emails[key] = `lc${key}-${suffix()}@example.test`;
    users.push(emails[key]);
    const [u] = await migrator.query(
      `INSERT INTO users (email, full_name, password_hash, email_verified_at) VALUES ($1, $2, $3, now()) RETURNING id`,
      [emails[key], key, hash],
    );
    return u.id as string;
  }

  async function tenant(label: string, owner: string, hash: string) {
    // No trial_ends_at: the database sets the 15-day trial and creates the subscription.
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
    const uid = await user(owner, hash);
    const [m] = await migrator.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, status, joined_at) VALUES ($1, $2, 'active', now()) RETURNING id`,
      [t.id, uid],
    );
    await migrator.query(
      `INSERT INTO user_role_assignments (tenant_id, membership_id, role_id, scope_type)
       SELECT $1, $2, id, 'tenant' FROM roles WHERE tenant_id IS NULL AND code = 'owner'`,
      [t.id, m.id],
    );
    return t.id as string;
  }

  beforeAll(async () => {
    migrator = await connect('migration');
    await migrator.runMigrations({ transaction: 'each' });
    const hash = await new PasswordHasher().hash(PASSWORD);
    alpha = await tenant('lcalpha', 'alphaOwner', hash);
    bravo = await tenant('lcbravo', 'bravoOwner', hash);
    const [p] = await migrator.query(
      `INSERT INTO plans (code, name, price_monthly_minor, price_yearly_minor, max_branches)
       VALUES ($1, 'LC Growth', 149900, 1499000, 3) RETURNING id`,
      [`test-lc-${suffix()}`],
    );
    plan = p.id;
    const adminId = await user('Admin', hash);
    await migrator.query(
      `INSERT INTO platform_role_assignments (user_id, role_id) SELECT $1, id FROM roles WHERE tenant_id IS NULL AND code = 'super_admin'`,
      [adminId],
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PAYMENT_GATEWAY)
      .useValue(gateway)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app);
    await app.init();
    lifecycle = app.get(SubscriptionLifecycleService);

    for (const who of ['alphaOwner', 'bravoOwner']) {
      tokens[who] = (await login(who).expect(200)).body.data.accessToken;
    }
    const first = await login('Admin').expect(202);
    const challengeToken = first.body.data.challengeToken as string;
    const setup = await request(app.getHttpServer())
      .post(`${API}/auth/mfa/enroll/start`)
      .set('X-Forwarded-For', freshIp())
      .send({ challengeToken })
      .expect(200);
    const totp = new TOTP({ secret: Secret.fromBase32(setup.body.data.manualKey) });
    tokens.admin = (
      await request(app.getHttpServer())
        .post(`${API}/auth/mfa/enroll/confirm`)
        .set('X-Forwarded-For', freshIp())
        .send({ challengeToken, code: totp.generate() })
        .expect(200)
    ).body.data.accessToken;
  });

  afterAll(async () => {
    await app?.close();
    if (migrator?.isInitialized) {
      for (const t of [
        'subscription_events',
        'subscription_invoices',
        'subscriptions',
        'user_role_assignments',
      ]) {
        await migrator.query(`DELETE FROM ${t} WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
      }
      await migrator.query(`DELETE FROM plans WHERE code LIKE 'test-lc-%'`);
      await migrator.query(
        'DELETE FROM platform_role_assignments WHERE user_id IN (SELECT id FROM users WHERE email = ANY($1::citext[]))',
        [users],
      );
      await migrator.destroy();
    }
  });

  it('starts every new restaurant on a 15-day trial from the database clock', async () => {
    const s = await subRow(alpha);
    expect(s.status).toBe('trialing');
    expect(s.plan_id).toBeNull();
    const days =
      (new Date(s.trial_ends_at).getTime() - new Date(s.trial_started_at).getTime()) / 864e5;
    expect(days).toBeCloseTo(15, 3);
    const e = (await call('alphaOwner', 'get', '/billing/entitlement').expect(200)).body.data;
    expect(e).toMatchObject({
      status: 'trialing',
      hasAccess: true,
      isTrial: true,
      remainingDays: 15,
      branchLimit: 1,
      reminder: null,
    });
  });

  it('allows operations during the trial but only one branch', async () => {
    await call('alphaOwner', 'get', '/team').expect(200);
    const db = app.get(DbContext);
    await expect(
      db.run({ tenantId: alpha }, (tx) => lifecycle.assertCanAddBranch(tx, alpha)),
    ).rejects.toMatchObject({ response: { code: 'BRANCH_LIMIT_REACHED' } });
  });

  it('shows the 3-day reminder near the end of the trial', async () => {
    await migrator.query(
      `UPDATE subscriptions SET trial_ends_at = now() + interval '2 days 1 hour',
              current_period_end = now() + interval '2 days 1 hour' WHERE tenant_id = $1`,
      [alpha],
    );
    const e = (await call('alphaOwner', 'get', '/billing/entitlement').expect(200)).body.data;
    expect(e).toMatchObject({ status: 'trialing', remainingDays: 3, reminder: 3 });
  });

  it('blocks operational APIs the moment the trial ends, before any sweep runs', async () => {
    await endTrial(alpha);
    expect((await subRow(alpha)).status).toBe('trialing'); // stored status not yet swept
    const res = await call('alphaOwner', 'get', '/team').expect(402);
    expect(res.body).toMatchObject({ code: 'SUBSCRIPTION_EXPIRED', detail: EXPIRED_MESSAGE });
    for (const url of ['/orders', '/inventory/items', '/menu/categories']) {
      expect((await call('alphaOwner', 'get', url)).status).toBe(402);
    }
  });

  it('keeps auth, account, subscription and billing reachable, and keeps all data', async () => {
    await call('alphaOwner', 'get', '/auth/me').expect(200);
    await call('alphaOwner', 'get', '/account/profile').expect(200);
    const s = (await call('alphaOwner', 'get', '/billing/subscription').expect(200)).body.data;
    expect(s).toMatchObject({ status: 'expired', hasAccess: false, reminder: 'expired' });
    await call('alphaOwner', 'get', '/billing/invoices').expect(200);
    const [kept] = await migrator.query(
      `SELECT (SELECT count(*) FROM branches WHERE tenant_id = $1)::int AS branches,
              (SELECT status FROM tenants WHERE id = $1) AS tenant_status`,
      [alpha],
    );
    expect(kept).toEqual({ branches: 1, tenant_status: 'trial' });
  });

  it('sweeps expired trials idempotently', async () => {
    await endTrial(bravo);
    await lifecycle.sweep();
    expect((await subRow(bravo)).status).toBe('expired');
    expect((await subRow(alpha)).status).toBe('expired');
    const before = await events(bravo);
    expect(before.filter((e: string) => e === 'trial_expired')).toHaveLength(1);
    expect(await lifecycle.sweep()).toBe(0);
    expect(await events(bravo)).toEqual(before);
  });

  it('records a failed payment and keeps access blocked', async () => {
    const co = (
      await call('alphaOwner', 'post', '/billing/subscription/checkout')
        .send({ planId: plan, billingCycle: 'monthly' })
        .expect(201)
    ).body.data;
    expect(co).toMatchObject({ gateway: 'razorpay', keyId: 'rzp_test_key', amountMinor: 149900 });
    expect((await subRow(alpha)).status).toBe('pending_payment');
    expect((await call('alphaOwner', 'get', '/team').expect(402)).body.code).toBe(
      'SUBSCRIPTION_PAYMENT_PENDING',
    );

    // A forged signature never activates anything.
    await call('alphaOwner', 'post', '/billing/subscription/checkout/verify')
      .send({
        invoiceId: co.invoice.id,
        orderId: co.orderId,
        paymentId: 'pay_x',
        signature: 'a'.repeat(64),
      })
      .expect(400);
    await call('alphaOwner', 'post', '/billing/subscription/checkout/failed')
      .send({ invoiceId: co.invoice.id, reason: 'Card declined' })
      .expect(204);
    expect((await subRow(alpha)).status).toBe('expired');
    const [inv] = await migrator.query(`SELECT * FROM subscription_invoices WHERE id = $1`, [
      co.invoice.id,
    ]);
    expect(inv).toMatchObject({ status: 'pending', failure_reason: 'Card declined' });
    await call('alphaOwner', 'get', '/team').expect(402);
  });

  it('does not let another tenant confirm this payment', async () => {
    const co = (
      await call('alphaOwner', 'post', '/billing/subscription/checkout')
        .send({ planId: plan, billingCycle: 'monthly' })
        .expect(201)
    ).body.data;
    const sig = hmacHex(KEY_SECRET, `${co.orderId}|pay_bravo`);
    await call('bravoOwner', 'post', '/billing/subscription/checkout/verify')
      .send({
        invoiceId: co.invoice.id,
        orderId: co.orderId,
        paymentId: 'pay_bravo',
        signature: sig,
      })
      .expect(404);
    expect((await subRow(alpha)).status).toBe('pending_payment');
    expect((await subRow(bravo)).status).toBe('expired');
  });

  it('activates the plan after a verified payment and restores access automatically', async () => {
    const co = (
      await call('alphaOwner', 'post', '/billing/subscription/checkout')
        .send({ planId: plan, billingCycle: 'monthly' })
        .expect(201)
    ).body.data;
    const orders = gateway.orders;
    const paymentId = `pay_${suffix()}`;
    const body = {
      invoiceId: co.invoice.id,
      orderId: co.orderId,
      paymentId,
      signature: hmacHex(KEY_SECRET, `${co.orderId}|${paymentId}`),
    };
    const paid = (
      await call('alphaOwner', 'post', '/billing/subscription/checkout/verify')
        .send(body)
        .expect(200)
    ).body.data;
    expect(paid).toMatchObject({
      status: 'paid',
      paymentMethod: 'online',
      paymentReference: paymentId,
    });
    // Replaying the same confirmation is harmless.
    await call('alphaOwner', 'post', '/billing/subscription/checkout/verify')
      .send(body)
      .expect(200);
    expect(gateway.orders).toBe(orders);

    const s = await subRow(alpha);
    expect(s).toMatchObject({ status: 'active', plan_id: plan, billing_cycle: 'monthly' });
    expect(new Date(s.current_period_end).getTime()).toBeGreaterThan(Date.now() + 27 * 864e5);
    await call('alphaOwner', 'get', '/team').expect(200);
    const [t] = await migrator.query(`SELECT status FROM tenants WHERE id = $1`, [alpha]);
    expect(t.status).toBe('active');
    expect(await events(alpha)).toEqual(
      expect.arrayContaining([
        'trial_expired',
        'checkout_started',
        'payment_failed',
        'payment_succeeded',
      ]),
    );
    const e = (await call('alphaOwner', 'get', '/billing/entitlement').expect(200)).body.data;
    expect(e).toMatchObject({ status: 'active', hasAccess: true, reminder: null });
  });

  it('accepts only signed, matching webhooks and ignores replays', async () => {
    const co = (
      await call('bravoOwner', 'post', '/billing/subscription/checkout')
        .send({ planId: plan, billingCycle: 'yearly' })
        .expect(201)
    ).body.data;
    const captured = (amount: number) => ({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: { id: `pay_${suffix()}`, order_id: co.orderId, amount, currency: 'INR' },
        },
      },
    });
    await webhook(captured(1499000), { secret: 'wrong' }).expect(401);
    await webhook(captured(100)).expect(200); // amount mismatch: ignored
    expect((await subRow(bravo)).status).toBe('pending_payment');

    const eventId = `evt_${suffix()}`;
    await webhook(captured(1499000), { eventId }).expect(200);
    expect((await subRow(bravo)).status).toBe('active');
    await webhook(captured(1499000), { eventId }).expect(200);
    const [n] = await migrator.query(
      `SELECT count(*)::int AS n FROM subscription_events WHERE tenant_id = $1 AND event = 'payment_succeeded'`,
      [bravo],
    );
    expect(n.n).toBe(1);
    await call('bravoOwner', 'get', '/team').expect(200);
  });

  describe('subscription requests and payment sessions', () => {
    const checkout = async (who: string) =>
      (
        await call(who, 'post', '/billing/subscription/checkout')
          .send({ planId: plan, billingCycle: 'monthly' })
          .expect(201)
      ).body.data as { invoice: { id: string }; orderId: string };
    const pending = async (who: string) =>
      (await call(who, 'get', '/billing/subscription').expect(200)).body.data.pendingInvoice;
    const succeeded = async (tenantId: string) =>
      (
        await migrator.query(
          `SELECT count(*)::int AS n FROM subscription_events WHERE tenant_id = $1 AND event = 'payment_succeeded'`,
          [tenantId],
        )
      )[0].n as number;

    it('shows a failed attempt as payment failed and lets the owner retry the same request', async () => {
      const co = await checkout('alphaOwner');
      expect(await pending('alphaOwner')).toMatchObject({ paymentStatus: 'pending_payment' });
      await call('alphaOwner', 'post', '/billing/subscription/checkout/failed')
        .send({ invoiceId: co.invoice.id, reason: 'Insufficient funds' })
        .expect(204);
      expect(await pending('alphaOwner')).toMatchObject({
        id: co.invoice.id,
        paymentStatus: 'payment_failed',
        failureReason: 'Insufficient funds',
      });
      // Retrying reuses the same request and gateway order, and restarts the session window.
      await migrator.query(
        `UPDATE subscription_invoices SET checkout_started_at = now() - interval '2 hours' WHERE id = $1`,
        [co.invoice.id],
      );
      const retry = await checkout('alphaOwner');
      expect(retry).toMatchObject({ invoice: { id: co.invoice.id }, orderId: co.orderId });
      const [inv] = await migrator.query(
        `SELECT checkout_started_at > now() - interval '1 minute' AS fresh FROM subscription_invoices WHERE id = $1`,
        [co.invoice.id],
      );
      expect(inv.fresh).toBe(true);

      const before = await succeeded(alpha);
      const paymentId = `pay_${suffix()}`;
      const paid = (
        await call('alphaOwner', 'post', '/billing/subscription/checkout/verify')
          .send({
            invoiceId: co.invoice.id,
            orderId: co.orderId,
            paymentId,
            signature: hmacHex(KEY_SECRET, `${co.orderId}|${paymentId}`),
          })
          .expect(200)
      ).body.data;
      expect(paid).toMatchObject({ paymentStatus: 'paid', transactionId: paymentId });

      // The gateway then reports the same payment twice more (different event ids): no second
      // activation, no second history entry.
      const captured = (event: string) => ({
        event,
        payload: {
          payment: {
            entity: {
              id: paymentId,
              order_id: co.orderId,
              amount: paid.amountMinor,
              currency: 'INR',
            },
          },
        },
      });
      await webhook(captured('payment.captured')).expect(200);
      await webhook(captured('order.paid')).expect(200);
      expect(await succeeded(alpha)).toBe(before + 1);
      expect(await pending('alphaOwner')).toBeNull();
    });

    it('expires an abandoned checkout, frees the slot, and still applies a late verified payment', async () => {
      const co = await checkout('bravoOwner');
      await migrator.query(
        `UPDATE subscription_invoices SET checkout_started_at = now() - interval '25 hours' WHERE id = $1`,
        [co.invoice.id],
      );
      // An offline request (no gateway order) is never expired by the sweep.
      const db = app.get(DbContext);
      expect(await db.run({ platform: true }, (d) => lifecycle.expireAbandonedCheckouts(d))).toBe(
        1,
      );
      const [inv] = await migrator.query(`SELECT * FROM subscription_invoices WHERE id = $1`, [
        co.invoice.id,
      ]);
      expect(inv.status).toBe('expired');
      expect(await events(bravo)).toContain('checkout_expired');
      expect(await pending('bravoOwner')).toBeNull();
      // Running the sweep again changes nothing.
      expect(await db.run({ platform: true }, (d) => lifecycle.expireAbandonedCheckouts(d))).toBe(
        0,
      );

      // The customer did pay at the bank: the verified webhook still activates, exactly once.
      const before = await succeeded(bravo);
      const late = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: `pay_${suffix()}`,
              order_id: co.orderId,
              amount: Number(inv.amount_minor),
              currency: 'INR',
            },
          },
        },
      };
      await webhook(late).expect(200);
      await webhook(late).expect(200);
      const [after] = await migrator.query(`SELECT * FROM subscription_invoices WHERE id = $1`, [
        co.invoice.id,
      ]);
      expect(after).toMatchObject({ status: 'paid', expired_at: null });
      expect(await succeeded(bravo)).toBe(before + 1);
    });

    it('shows Super Admin every request with owner, plan, amount, payment status and transaction', async () => {
      const all = await call(
        'admin',
        'get',
        `/platform/billing/subscriptions?group=active&search=lcalpha&limit=10`,
      ).expect(200);
      const row = all.body.data.find((s: { tenantId: string }) => s.tenantId === alpha);
      expect(row).toMatchObject({
        status: 'active',
        ownerName: 'alphaOwner',
        ownerEmail: emails.alphaOwner,
        planName: expect.any(String),
        billingCycle: 'monthly',
        lastInvoice: {
          paymentStatus: 'paid',
          amountMinor: expect.any(Number),
          currencyCode: 'INR',
          transactionId: expect.stringMatching(/^pay_/),
        },
      });
      // A new request shows under Pending Requests, and failed attempts can be filtered.
      const co = await checkout('alphaOwner');
      await call('alphaOwner', 'post', '/billing/subscription/checkout/failed')
        .send({ invoiceId: co.invoice.id, reason: 'Timeout' })
        .expect(204);
      const pendingTab = await call(
        'admin',
        'get',
        `/platform/billing/subscriptions?group=pending&paymentStatus=payment_failed&search=lcalpha`,
      ).expect(200);
      expect(pendingTab.body.data.map((s: { tenantId: string }) => s.tenantId)).toEqual([alpha]);
      const failed = await call('admin', 'get', '/platform/billing/invoices?status=failed').expect(
        200,
      );
      expect(failed.body.data.map((i: { id: string }) => i.id)).toContain(co.invoice.id);
      expect(failed.body.data.find((i: { id: string }) => i.id === co.invoice.id)).toMatchObject({
        ownerName: 'alphaOwner',
        paymentStatus: 'payment_failed',
      });
      // Restaurants never see the platform list.
      await call('alphaOwner', 'get', '/platform/billing/subscriptions').expect(403);
      await call('alphaOwner', 'post', `/billing/invoices/${co.invoice.id}/cancel`).expect(204);
    });
  });

  describe('Super Admin controls', () => {
    it('is platform-only', async () => {
      await call('alphaOwner', 'get', '/platform/billing/subscriptions').expect(403);
    });

    it('lists subscriptions by status with trial dates', async () => {
      await endTrial(bravo);
      await migrator.query(
        `UPDATE subscriptions SET status = 'trialing', plan_id = NULL, billing_cycle = NULL WHERE tenant_id = $1`,
        [bravo],
      );
      const list = (
        await call(
          'admin',
          'get',
          '/platform/billing/subscriptions?status=expired&limit=100',
        ).expect(200)
      ).body;
      const row = list.data.find((r: { tenantId: string }) => r.tenantId === bravo);
      expect(row).toMatchObject({ status: 'expired', hasAccess: false, remainingDays: 0 });
      expect(row.trialEndsAt).toBeTruthy();
    });

    it('extends a trial, suspends and reinstates, with history', async () => {
      await call('admin', 'post', `/platform/billing/subscriptions/${bravo}/extend-trial`)
        .send({ days: 7, reason: 'Onboarding call' })
        .expect(200);
      expect((await subRow(bravo)).status).toBe('trialing');
      await call('bravoOwner', 'get', '/team').expect(200);

      await call('admin', 'post', `/platform/billing/subscriptions/${bravo}/suspend`)
        .send({ reason: 'Chargeback review' })
        .expect(200);
      expect((await call('bravoOwner', 'get', '/team').expect(402)).body.code).toBe(
        'SUBSCRIPTION_SUSPENDED',
      );
      await call('admin', 'post', `/platform/billing/subscriptions/${bravo}/reinstate`).expect(200);
      expect((await subRow(bravo)).status).toBe('trialing');

      const detail = (
        await call('admin', 'get', `/platform/billing/subscriptions/${bravo}`).expect(200)
      ).body.data;
      expect(detail.events.map((e: { event: string }) => e.event)).toEqual(
        expect.arrayContaining(['trial_extended', 'suspended', 'reinstated', 'payment_succeeded']),
      );
      expect(detail.invoices.length).toBeGreaterThan(0);
    });

    it('rejects invalid transitions', async () => {
      await call('admin', 'post', `/platform/billing/subscriptions/${bravo}/reinstate`).expect(400);
      await call('admin', 'post', `/platform/billing/subscriptions/${alpha}/extend-trial`)
        .send({ days: 5, reason: 'Not allowed on a paid plan' })
        .expect(400);
    });
  });
});
