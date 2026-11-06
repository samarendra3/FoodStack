import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PasswordHasher } from '../src/core/security/password-hasher';
import { connect } from './helpers';

/**
 * Subscriptions and My Profile: server-computed status and remaining days, pending invoices that
 * never activate a plan on their own, Super Admin payment verification (new, renewal, upgrade),
 * usage counts, permissions, tenant isolation, profile edits, password change and sessions.
 */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;
const DAY = 86_400_000;

describe('Billing & account (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  const tenants: string[] = [];
  const users: string[] = [];
  const emails: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  let alphaId: string;
  let starter: string;
  let pro: string;

  const call = (who: string, method: 'get' | 'post' | 'patch', url: string) =>
    request(app.getHttpServer())
      [method](`${API}${url}`)
      .set('X-Forwarded-For', freshIp())
      .set('Authorization', `Bearer ${tokens[who]}`);
  const login = (who: string, password = PASSWORD) =>
    request(app.getHttpServer())
      .post(`${API}/auth/login`)
      .set('X-Forwarded-For', freshIp())
      .send({ email: emails[who], password });

  async function user(key: string, hash: string) {
    emails[key] = `${key}-${suffix()}@example.test`;
    users.push(emails[key]);
    const [u] = await migrator.query(
      `INSERT INTO users (email, full_name, password_hash, email_verified_at) VALUES ($1, $2, $3, now()) RETURNING id`,
      [emails[key], key, hash],
    );
    return u.id as string;
  }

  async function tenant(label: string) {
    const [t] = await migrator.query(
      `INSERT INTO tenants (slug, name, status, trial_ends_at) VALUES ($1, $2, 'trial', now() + interval '10 days') RETURNING id`,
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
    return { id: t.id as string, branch: b.id as string };
  }

  async function member(
    key: string,
    tenantId: string,
    role: string,
    hash: string,
    branchId?: string,
  ) {
    const uid = await user(key, hash);
    const [m] = await migrator.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, status, joined_at) VALUES ($1, $2, 'active', now()) RETURNING id`,
      [tenantId, uid],
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
    const alpha = await tenant('billalpha');
    const bravo = await tenant('billbravo');
    alphaId = alpha.id;
    await member('owner', alpha.id, 'owner', hash);
    await member('manager', alpha.id, 'branch_manager', hash, alpha.branch);
    await member('bravoOwner', bravo.id, 'owner', hash);
    const adminId = await user('billAdmin', hash);
    await migrator.query(
      `INSERT INTO platform_role_assignments (user_id, role_id) SELECT $1, id FROM roles WHERE tenant_id IS NULL AND code = 'super_admin'`,
      [adminId],
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app);
    await app.init();

    for (const who of ['owner', 'manager', 'bravoOwner']) {
      tokens[who] = (await login(who).expect(200)).body.data.accessToken;
    }
    const first = await login('billAdmin').expect(202);
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
      for (const t of ['subscription_invoices', 'subscriptions', 'user_role_assignments']) {
        await migrator.query(`DELETE FROM ${t} WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
      }
      await migrator.query(`DELETE FROM plans WHERE code LIKE 'test-%'`);
      await migrator.query(
        'DELETE FROM platform_role_assignments WHERE user_id IN (SELECT id FROM users WHERE email = ANY($1::citext[]))',
        [users],
      );
      await migrator.destroy();
    }
  });

  it('reports the trial with server-computed remaining days and real usage', async () => {
    const s = (await call('owner', 'get', '/billing/subscription').expect(200)).body.data;
    expect(s).toMatchObject({
      status: 'trialing',
      remainingDays: 10,
      alert: 'soon',
      plan: null,
      pendingInvoice: null,
      autoRenew: false,
      canManage: true,
      usage: { branches: 1, staff: 2, ordersThisMonth: 0, menuItems: 0 },
    });
  });

  it('lets Super Admins manage plans; owners cannot', async () => {
    const plan = (code: string, name: string, monthly: number, branches: number | null) => ({
      code,
      // Plan names are unique (and the launch catalogue already has Starter/Professional).
      name: `${name} ${code.slice(-8)}`,
      priceMonthlyMinor: monthly,
      priceYearlyMinor: monthly * 10,
      maxBranches: branches,
      maxStaff: 10,
      maxOrdersPerMonth: 1000,
      maxMenuItems: 200,
      features: ['POS', 'Kitchen display'],
    });
    starter = (
      await call('admin', 'post', '/platform/billing/plans')
        .send(plan(`test-starter-${suffix()}`, 'Starter', 99900, 1))
        .expect(201)
    ).body.data.id;
    pro = (
      await call('admin', 'post', '/platform/billing/plans')
        .send(plan(`test-pro-${suffix()}`, 'Professional', 249900, 5))
        .expect(201)
    ).body.data.id;
    await call('owner', 'post', '/platform/billing/plans')
      .send(plan('test-x', 'X', 1, 1))
      .expect(403);
    const s = (await call('owner', 'get', '/billing/subscription').expect(200)).body.data;
    expect(s.plans.map((p: { id: string }) => p.id)).toEqual(
      expect.arrayContaining([starter, pro]),
    );
  });

  it('creates a pending invoice that does not activate anything', async () => {
    await call('manager', 'post', '/billing/subscription/requests')
      .send({ planId: starter, billingCycle: 'monthly' })
      .expect(403);
    const inv = (
      await call('owner', 'post', '/billing/subscription/requests')
        .send({ planId: starter, billingCycle: 'monthly' })
        .expect(201)
    ).body.data;
    expect(inv).toMatchObject({
      status: 'pending',
      kind: 'new',
      amountMinor: 99900,
      planName: expect.stringMatching(/^Starter /),
      paidAt: null,
    });
    expect(inv.invoiceNumber).toMatch(/^FS-\d{4}-\d{6}$/);
    await call('owner', 'post', '/billing/subscription/requests')
      .send({ planId: pro, billingCycle: 'monthly' })
      .expect(409);
    const s = (await call('owner', 'get', '/billing/subscription').expect(200)).body.data;
    expect(s).toMatchObject({ status: 'trialing', plan: null, pendingInvoice: { id: inv.id } });
    await call('owner', 'post', `/billing/invoices/${inv.id}/cancel`).expect(204);
  });

  it('activates only on verified payment, then renews from the period end and upgrades from now', async () => {
    const inv = (
      await call('owner', 'post', '/billing/subscription/requests')
        .send({ planId: starter, billingCycle: 'monthly' })
        .expect(201)
    ).body.data;
    const pending = (
      await call('admin', 'get', '/platform/billing/invoices?status=pending').expect(200)
    ).body.data;
    expect(
      pending.some(
        (p: { id: string; tenantId: string }) => p.id === inv.id && p.tenantId === alphaId,
      ),
    ).toBe(true);
    await call('admin', 'post', `/platform/billing/invoices/${inv.id}/mark-paid`)
      .send({ paymentMethod: 'upi', paymentReference: 'UPI-1' })
      .expect(200);
    await call('admin', 'post', `/platform/billing/invoices/${inv.id}/mark-paid`)
      .send({ paymentMethod: 'upi', paymentReference: 'UPI-1' })
      .expect(400);

    let s = (await call('owner', 'get', '/billing/subscription').expect(200)).body.data;
    expect(s).toMatchObject({
      status: 'active',
      billingCycle: 'monthly',
      price: 99900,
      plan: { id: starter },
      pendingInvoice: null,
    });
    expect(s.remainingDays).toBeGreaterThanOrEqual(28);
    const firstEnd = Date.parse(s.periodEnd);
    const [t] = await migrator.query('SELECT status FROM tenants WHERE id = $1', [alphaId]);
    expect(t.status).toBe('active');

    const renewal = (
      await call('owner', 'post', '/billing/subscription/requests')
        .send({ planId: starter, billingCycle: 'monthly' })
        .expect(201)
    ).body.data;
    expect(renewal.kind).toBe('renewal');
    await call('admin', 'post', `/platform/billing/invoices/${renewal.id}/mark-paid`)
      .send({ paymentMethod: 'bank_transfer', paymentReference: 'NEFT-2' })
      .expect(200);
    s = (await call('owner', 'get', '/billing/subscription').expect(200)).body.data;
    expect(Date.parse(s.periodEnd)).toBeGreaterThan(firstEnd + 27 * DAY);

    const upgrade = (
      await call('owner', 'post', '/billing/subscription/requests')
        .send({ planId: pro, billingCycle: 'yearly' })
        .expect(201)
    ).body.data;
    expect(upgrade).toMatchObject({ kind: 'upgrade', amountMinor: 2499000 });
    await call('admin', 'post', `/platform/billing/invoices/${upgrade.id}/mark-paid`)
      .send({ paymentMethod: 'card', paymentReference: 'CARD-3' })
      .expect(200);
    s = (await call('owner', 'get', '/billing/subscription').expect(200)).body.data;
    expect(s).toMatchObject({ plan: { id: pro }, billingCycle: 'yearly', status: 'active' });
    expect(s.remainingDays).toBeGreaterThanOrEqual(364);

    const history = (await call('owner', 'get', '/billing/invoices?status=paid').expect(200)).body;
    expect(history.meta.total).toBe(3);
    expect(history.data[0]).toMatchObject({
      planName: expect.stringMatching(/^Professional /),
      paymentMethod: 'card',
      status: 'paid',
    });
  });

  it('never shows negative remaining days for an ended trial', async () => {
    await migrator.query(
      `UPDATE subscriptions SET trial_ends_at = now() - interval '5 days', current_period_end = now() - interval '5 days',
              current_period_start = now() - interval '20 days' WHERE tenant_id = $1`,
      [tenants[1]],
    );
    const s = (await call('bravoOwner', 'get', '/billing/subscription').expect(200)).body.data;
    expect(s).toMatchObject({ status: 'expired', remainingDays: 0, alert: 'expired' });
  });

  it('keeps tenants apart', async () => {
    const own = (await call('bravoOwner', 'get', '/billing/invoices').expect(200)).body;
    expect(own.meta.total).toBe(0);
    await call('bravoOwner', 'get', '/platform/billing/invoices').expect(403);
  });

  it('shows and edits the restaurant profile with validation and permissions', async () => {
    const p = (await call('owner', 'get', '/account/profile').expect(200)).body.data;
    expect(p).toMatchObject({
      restaurant: { name: 'billalpha', gstin: null },
      owner: { name: 'owner' },
      canEditRestaurant: true,
    });
    await call('owner', 'patch', '/account/restaurant').send({ gstin: 'NOTAGSTIN' }).expect(400);
    await call('owner', 'patch', '/account/restaurant')
      .send({ logoUrl: 'http://insecure.example/logo.png' })
      .expect(400);
    await call('owner', 'patch', '/account/restaurant')
      .send({
        gstin: '22aaaaa0000a1z5',
        phone: '+91 98765 43210',
        city: 'Bhubaneswar',
        logoUrl: 'https://cdn.example.com/logo.png',
      })
      .expect(204);
    const after = (await call('owner', 'get', '/account/profile').expect(200)).body.data.restaurant;
    expect(after).toMatchObject({
      gstin: '22AAAAA0000A1Z5',
      phone: '+919876543210',
      city: 'Bhubaneswar',
    });
    await call('manager', 'patch', '/account/restaurant').send({ city: 'X' }).expect(403);
    // Users outlive this suite, and phones are unique: use a fresh number each run.
    const phone = `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    await call('manager', 'patch', '/account/me')
      .send({ fullName: 'Mona Manager', phone })
      .expect(204);
    const me = (await call('manager', 'get', '/account/profile').expect(200)).body.data.me;
    expect(me).toMatchObject({ fullName: 'Mona Manager', phone });
  });

  it('changes the password and signs out other sessions', async () => {
    const other = (await login('manager').expect(200)).body.data.accessToken as string;
    const sessions = (await call('manager', 'get', '/account/sessions').expect(200)).body.data;
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    await call('manager', 'post', '/account/password')
      .send({ currentPassword: 'wrong-one', newPassword: 'New-Horse-4242' })
      .expect(400);
    const res = (
      await call('manager', 'post', '/account/password')
        .send({ currentPassword: PASSWORD, newPassword: 'New-Horse-4242' })
        .expect(200)
    ).body.data;
    expect(res.otherSessionsEnded).toBeGreaterThanOrEqual(1);
    await request(app.getHttpServer())
      .get(`${API}/account/profile`)
      .set('X-Forwarded-For', freshIp())
      .set('Authorization', `Bearer ${other}`)
      .expect(401);
    await call('manager', 'get', '/account/profile').expect(200);
    await login('manager').expect(401);
    await login('manager', 'New-Horse-4242').expect(200);
  });
});
