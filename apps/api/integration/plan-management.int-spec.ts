import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PasswordHasher } from '../src/core/security/password-hasher';
import { seedLaunchPlans } from '../src/database/seeds/launch-plans';
import { connect } from './helpers';

/**
 * Super Admin plan management: the launch catalogue (seeded once, idempotent), duplicate
 * name/slug protection, one Free Trial plan, cross-field rules on create and edit, the paged
 * admin table, duplicating, internal notes kept private, purchase rules (no buying the Free
 * Trial, only offered cycles), and new restaurants starting on the Free Trial plan's terms.
 */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;
const LAUNCH = ['free-trial', 'starter', 'professional', 'business'];

describe('Plan management (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  const tenants: string[] = [];
  const users: string[] = [];
  const emails: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  const tag = suffix();

  const http = () => request(app.getHttpServer());
  const call = (who: string, method: 'get' | 'post' | 'patch' | 'delete', url: string) =>
    http()
      [method](`${API}${url}`)
      .set('X-Forwarded-For', freshIp())
      .set('Authorization', `Bearer ${tokens[who]}`);
  const body = (slug: string, extra: object = {}) => ({
    code: `pm${tag}-${slug}`,
    name: `PM ${tag} ${slug}`,
    priceMonthlyMinor: 99_900,
    priceYearlyMinor: 999_900,
    maxBranches: 2,
    maxStaff: 10,
    maxOrdersPerMonth: null,
    maxMenuItems: null,
    ...extra,
  });
  const create = (slug: string, extra: object = {}) =>
    call('admin', 'post', '/platform/billing/plans').send(body(slug, extra));

  async function user(key: string, hash: string) {
    emails[key] = `pm${key}-${suffix()}@example.test`;
    users.push(emails[key]);
    const [u] = await migrator.query(
      `INSERT INTO users (email, full_name, password_hash, email_verified_at) VALUES ($1, $2, $3, now()) RETURNING id`,
      [emails[key], key, hash],
    );
    return u.id as string;
  }

  beforeAll(async () => {
    migrator = await connect('migration');
    await migrator.runMigrations({ transaction: 'each' });
    const hash = await new PasswordHasher().hash(PASSWORD);
    const [t] = await migrator.query(
      `INSERT INTO tenants (slug, name) VALUES ($1, 'pmrest') RETURNING id`,
      [`pmrest-${suffix()}`],
    );
    tenants.push(t.id);
    const [r] = await migrator.query(
      `INSERT INTO restaurants (tenant_id, name, slug, currency_code, country_code, timezone)
       VALUES ($1, 'pmrest', $2, 'INR', 'IN', 'Asia/Kolkata') RETURNING id`,
      [t.id, `pmrest-${suffix()}`],
    );
    await migrator.query(
      `INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone, is_default)
       VALUES ($1, $2, 'MAIN', 'Main', 'Asia/Kolkata', true)`,
      [t.id, r.id],
    );
    const ownerId = await user('owner', hash);
    const [m] = await migrator.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, status, joined_at) VALUES ($1, $2, 'active', now()) RETURNING id`,
      [t.id, ownerId],
    );
    await migrator.query(
      `INSERT INTO user_role_assignments (tenant_id, membership_id, role_id, scope_type)
       SELECT $1, $2, id, 'tenant' FROM roles WHERE tenant_id IS NULL AND code = 'owner'`,
      [t.id, m.id],
    );
    const adminId = await user('admin', hash);
    await migrator.query(
      `INSERT INTO platform_role_assignments (user_id, role_id) SELECT $1, id FROM roles WHERE tenant_id IS NULL AND code = 'super_admin'`,
      [adminId],
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
    tokens.owner = (await login('owner').expect(200)).body.data.accessToken;
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
      await migrator.query(`DELETE FROM plans WHERE code LIKE $1`, [`pm${tag}%`]);
      await migrator.query(
        'DELETE FROM platform_role_assignments WHERE user_id IN (SELECT id FROM users WHERE email = ANY($1::citext[]))',
        [users],
      );
      await migrator.destroy();
    }
  });

  it('seeds the launch catalogue once, and re-running the seed changes nothing', async () => {
    const before = await migrator.query(
      `SELECT code::text, updated_at FROM plans WHERE code = ANY($1) ORDER BY code`,
      [LAUNCH],
    );
    expect(before.map((p: { code: string }) => p.code).sort()).toEqual([...LAUNCH].sort());
    await seedLaunchPlans(migrator);
    await seedLaunchPlans(migrator);
    const after = await migrator.query(
      `SELECT code::text, updated_at FROM plans WHERE code = ANY($1) ORDER BY code`,
      [LAUNCH],
    );
    expect(after).toEqual(before);
    const [{ n }] = await migrator.query(
      `SELECT count(*)::int AS n FROM plans WHERE lower(name) IN ('free trial', 'starter', 'professional', 'business')`,
    );
    expect(n).toBe(4);
  });

  it('publishes the launch plans with prices, limits and included/excluded features', async () => {
    const plans = (await http().get(`${API}/plans`).expect(200)).body.data as {
      slug: string;
      [k: string]: unknown;
    }[];
    const by = (slug: string) => plans.find((p) => p.slug === slug)!;
    expect(by('free-trial')).toMatchObject({
      planType: 'free_trial',
      priceMonthlyMinor: 0,
      priceYearlyMinor: 0,
      trialDays: 15,
      limits: { branches: 1, staff: 3, ordersPerMonth: 200, menuItems: 50 },
    });
    expect(by('starter')).toMatchObject({
      priceMonthlyMinor: 49_900,
      priceYearlyMinor: 499_900,
      limits: { branches: 1, staff: 5, ordersPerMonth: 1000, menuItems: 100 },
    });
    expect(by('professional')).toMatchObject({
      priceMonthlyMinor: 99_900,
      priceYearlyMinor: 999_900,
      badge: 'popular',
      limits: { branches: 3, staff: 15, ordersPerMonth: 5000, menuItems: 500 },
    });
    expect(by('business')).toMatchObject({
      priceMonthlyMinor: 199_900,
      priceYearlyMinor: 1_999_900,
      badge: 'best_value',
      limits: { branches: 5, staff: 40, ordersPerMonth: 15_000, menuItems: null },
    });
    expect(by('free-trial').featureItems).toEqual(
      expect.arrayContaining([
        { label: 'POS & Billing', enabled: true },
        { label: 'Inventory Management', enabled: false },
      ]),
    );
    expect(by('business').featureItems).toContainEqual({
      label: 'Priority Support',
      enabled: true,
    });
    // Public pricing never exposes internal notes.
    expect(Object.keys(by('starter'))).not.toContain('adminNotes');
  });

  it('rejects duplicate names (any case) and slugs, and a second Free Trial plan', async () => {
    await create('dup').expect(201);
    const sameSlug = await create('dup', { name: `PM ${tag} other` }).expect(409);
    expect(sameSlug.body.code).toBe('PLAN_EXISTS');
    const sameName = await create('dup2', { name: `pm ${tag} DUP` }).expect(409);
    expect(sameName.body.code).toBe('PLAN_NAME_EXISTS');
    const trial = await create('trial2', {
      planType: 'free_trial',
      priceMonthlyMinor: 0,
      priceYearlyMinor: 0,
    }).expect(409);
    expect(trial.body.code).toBe('FREE_TRIAL_EXISTS');
  });

  it('validates plan type rules on create and on edit', async () => {
    await create('ft-priced', { planType: 'free_trial' }).expect(400);
    await create('custom-paid', {
      customPricing: true,
      priceMonthlyMinor: null,
      priceYearlyMinor: null,
    }).expect(400);
    await create('dupe-feature', {
      featureItems: [
        { label: 'POS', enabled: true },
        { label: 'pos', enabled: false },
      ],
    }).expect(400);
    const paid = (await create('edit-rules').expect(201)).body.data;
    // A priced plan cannot become a Free Trial (₹0) plan through a partial edit.
    const bad = await call('admin', 'patch', `/platform/billing/plans/${paid.id}`)
      .send({ planType: 'free_trial' })
      .expect(400);
    expect(bad.body.code).toBe('PLAN_INVALID');
  });

  it('keeps feature lines and the included list in sync, and internal notes for admins only', async () => {
    const p = (
      await create('features', {
        featureItems: [
          { label: 'POS & Billing', enabled: true },
          { label: 'Priority Support', enabled: false },
        ],
        adminNotes: 'Negotiated launch price',
        ctaLabel: 'Choose Features',
        billingCycles: 'yearly',
      }).expect(201)
    ).body.data;
    expect(p).toMatchObject({
      features: ['POS & Billing'],
      adminNotes: 'Negotiated launch price',
      ctaLabel: 'Choose Features',
      billingCycles: 'yearly',
    });
    const viewed = (await call('admin', 'get', `/platform/billing/plans/${p.id}`).expect(200)).body
      .data;
    expect(viewed.adminNotes).toBe('Negotiated launch price');
    await call('owner', 'get', `/platform/billing/plans/${p.id}`).expect(403);
  });

  it('pages, searches, filters and sorts the admin plan table', async () => {
    for (const s of ['tbl-a', 'tbl-b', 'tbl-c']) await create(s).expect(201);
    const hidden = (await create('tbl-hidden', { isPublic: false }).expect(201)).body.data;
    await call('admin', 'patch', `/platform/billing/plans/${hidden.id}`)
      .send({ isActive: false })
      .expect(200);

    const page = await call(
      'admin',
      'get',
      `/platform/billing/plans/page?search=pm${tag}-tbl&limit=10&sortBy=name&sortOrder=desc`,
    ).expect(200);
    expect(page.body.meta).toMatchObject({ total: 4, page: 1 });
    const names = page.body.data.map((p: { name: string }) => p.name);
    expect(names).toEqual([...names].sort().reverse());

    const inactive = await call(
      'admin',
      'get',
      `/platform/billing/plans/page?search=pm${tag}-tbl&status=inactive&visibility=hidden`,
    ).expect(200);
    expect(inactive.body.data.map((p: { id: string }) => p.id)).toEqual([hidden.id]);

    const trials = await call(
      'admin',
      'get',
      `/platform/billing/plans/page?planType=free_trial`,
    ).expect(200);
    expect(trials.body.data.map((p: { slug: string }) => p.slug)).toEqual(['free-trial']);
    await call('admin', 'get', '/platform/billing/plans/page?limit=7').expect(400);
  });

  it('duplicates a plan as a hidden, inactive draft with a unique name and slug', async () => {
    const src = (await create('copyme').expect(201)).body.data;
    const a = (
      await call('admin', 'post', `/platform/billing/plans/${src.id}/duplicate`).expect(201)
    ).body.data;
    const b = (
      await call('admin', 'post', `/platform/billing/plans/${src.id}/duplicate`).expect(201)
    ).body.data;
    expect(a).toMatchObject({
      slug: `${src.slug}-copy`,
      name: `${src.name} (copy)`,
      isActive: false,
      isPublic: false,
      priceMonthlyMinor: src.priceMonthlyMinor,
      limits: src.limits,
    });
    expect(b).toMatchObject({ slug: `${src.slug}-copy-2`, name: `${src.name} (copy 2)` });
    const publicSlugs = (await http().get(`${API}/plans`).expect(200)).body.data.map(
      (p: { slug: string }) => p.slug,
    );
    expect(publicSlugs).not.toContain(a.slug);
  });

  it('archives a plan reversibly: restore brings it back inactive and hidden', async () => {
    const p = (await create('restore-me').expect(201)).body.data;
    const url = `/platform/billing/plans/${p.id}`;
    await call('admin', 'post', `${url}/archive`).expect(200);
    // Archived plans cannot be switched back on directly...
    await call('admin', 'patch', url).send({ isActive: true }).expect(400);
    // ...they are restored first, as a draft the Super Admin publishes explicitly.
    const restored = (await call('admin', 'post', `${url}/restore`).expect(200)).body.data;
    expect(restored).toMatchObject({ archivedAt: null, isActive: false, isPublic: false });
    await call('admin', 'post', `${url}/restore`).expect(404); // not archived any more
    await call('owner', 'post', `${url}/restore`).expect(403);
    const live = (
      await call('admin', 'patch', url).send({ isActive: true, isPublic: true }).expect(200)
    ).body.data;
    expect(live).toMatchObject({ isActive: true, isPublic: true });
  });

  it('never sells the Free Trial plan, and only sells the billing cycles a plan offers', async () => {
    const [trial] = await migrator.query(`SELECT id FROM plans WHERE code = 'free-trial'`);
    const noTrial = await call('owner', 'post', '/billing/subscription/requests')
      .send({ planId: trial.id, billingCycle: 'monthly' })
      .expect(400);
    expect(noTrial.body.code).toBe('PLAN_CYCLE_UNAVAILABLE');

    const yearlyOnly = (await create('yearly-only', { billingCycles: 'yearly' }).expect(201)).body
      .data;
    const monthly = await call('owner', 'post', '/billing/subscription/requests')
      .send({ planId: yearlyOnly.id, billingCycle: 'monthly' })
      .expect(400);
    expect(monthly.body.code).toBe('PLAN_CYCLE_UNAVAILABLE');
    const yearly = await call('owner', 'post', '/billing/subscription/requests')
      .send({ planId: yearlyOnly.id, billingCycle: 'yearly' })
      .expect(201);
    // A request is only a pending invoice: nothing activates until payment is verified.
    expect(yearly.body.data).toMatchObject({ status: 'pending', paidAt: null });
    await call('owner', 'post', `/billing/invoices/${yearly.body.data.id}/cancel`).expect(204);
  });

  it('keeps the trial while Professional is requested, and makes it current only after verified payment', async () => {
    const [tenant] = await migrator.query(
      `SELECT m.tenant_id AS id FROM tenant_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1`,
      [emails.owner],
    );
    const [pro] = await migrator.query(`SELECT id FROM plans WHERE code = 'professional'`);
    const sub = async () =>
      (await migrator.query(`SELECT * FROM subscriptions WHERE tenant_id = $1`, [tenant.id]))[0];
    const adminRow = async () =>
      (
        await call(
          'admin',
          'get',
          `/platform/billing/subscriptions?search=pmrest&limit=100`,
        ).expect(200)
      ).body.data.find((r: { tenantId: string }) => r.tenantId === tenant.id);
    const trial = await sub();
    expect(trial.status).toBe('trialing');

    // 1–3: requesting Professional creates a pending request; the trial stays current.
    const inv = (
      await call('owner', 'post', '/billing/subscription/requests')
        .send({ planId: pro.id, billingCycle: 'monthly' })
        .expect(201)
    ).body.data;
    expect(inv).toMatchObject({
      status: 'pending',
      paymentStatus: 'awaiting_payment',
      amountMinor: 99_900,
    });
    expect((await sub()).status).toBe('trialing');
    expect(await adminRow()).toMatchObject({
      status: 'trialing',
      currentPlan: { name: 'Free Trial' },
      requested: {
        planName: 'Professional',
        billingCycle: 'monthly',
        paymentStatus: 'awaiting_payment',
      },
    });

    // 7: a failed attempt changes nothing.
    await call('owner', 'post', '/billing/subscription/checkout/failed')
      .send({ invoiceId: inv.id, reason: 'Card declined' })
      .expect(204);
    expect((await sub()).status).toBe('trialing');
    expect((await adminRow()).requested).toMatchObject({ paymentStatus: 'payment_failed' });

    // 4: verified payment activates Professional with its limits and fresh dates.
    await call('admin', 'post', `/platform/billing/invoices/${inv.id}/mark-paid`)
      .send({ paymentMethod: 'upi', paymentReference: `UTR-${tag}` })
      .expect((r) => expect([200, 201]).toContain(r.status));
    const active = await sub();
    expect(active).toMatchObject({ status: 'active', plan_id: pro.id, billing_cycle: 'monthly' });
    expect(active.plan_snapshot).toMatchObject({
      name: 'Professional',
      priceMinor: 99_900,
      limits: { branches: 3, staff: 15, ordersPerMonth: 5000, menuItems: 500 },
    });
    const days =
      (new Date(active.current_period_end).getTime() -
        new Date(active.current_period_start).getTime()) /
      864e5;
    expect(days).toBeGreaterThanOrEqual(28);
    expect(days).toBeLessThanOrEqual(31);

    // 5: Super Admin shows Professional · Active · Paid, with no open request.
    expect(await adminRow()).toMatchObject({
      status: 'active',
      currentPlan: { name: 'Professional', billingCycle: 'monthly', priceMinor: 99_900 },
      requested: null,
      lastInvoice: { paymentStatus: 'paid', transactionId: `UTR-${tag}` },
    });
    const activeTab = await call(
      'admin',
      'get',
      '/platform/billing/subscriptions?group=active&search=pmrest',
    ).expect(200);
    expect(activeTab.body.data.map((r: { tenantId: string }) => r.tenantId)).toContain(tenant.id);

    // 6: Restaurant Admin shows Professional as the current plan.
    const overview = (await call('owner', 'get', '/billing/subscription').expect(200)).body.data;
    expect(overview).toMatchObject({
      status: 'active',
      plan: { name: 'Professional' },
      billingCycle: 'monthly',
      limits: { branches: 3, staff: 15, ordersPerMonth: 5000 },
      pendingInvoice: null,
    });

    // 8: processing the same payment again is refused; one activation in the history.
    await call('admin', 'post', `/platform/billing/invoices/${inv.id}/mark-paid`)
      .send({ paymentMethod: 'upi', paymentReference: `UTR-${tag}` })
      .expect(400);
    const [{ n }] = await migrator.query(
      `SELECT count(*)::int AS n FROM subscription_events WHERE invoice_id = $1 AND event = 'payment_succeeded'`,
      [inv.id],
    );
    expect(n).toBe(1);

    // 9: the trial is kept as history.
    expect(new Date(active.trial_started_at).getTime()).toBe(
      new Date(trial.trial_started_at).getTime(),
    );
    expect(new Date(active.trial_ends_at).getTime()).toBe(new Date(trial.trial_ends_at).getTime());
    const [evt] = await migrator.query(
      `SELECT from_status, to_status FROM subscription_events WHERE invoice_id = $1 AND event = 'payment_succeeded'`,
      [inv.id],
    );
    expect(evt).toMatchObject({ from_status: 'trialing', to_status: 'active' });
  });

  it("starts a newly registered restaurant on the Free Trial plan's terms", async () => {
    const email = `pmsignup-${suffix()}@example.test`;
    users.push(email);
    await http()
      .post(`${API}/access-requests`)
      .set('X-FoodStack-CSRF', '1')
      .set('X-Forwarded-For', freshIp())
      .send({ restaurantName: 'Trial Diner', contactName: 'Tara Trial', email })
      .expect((r) => expect([201, 202, 204]).toContain(r.status));
    const [req] = await migrator.query(`SELECT id FROM access_requests WHERE email = $1`, [email]);
    await call('admin', 'post', `/platform/access-requests/${req.id}/approve`)
      .send({ slug: `pmsignup-${suffix()}` })
      .expect((r) => expect([200, 201]).toContain(r.status));
    const [t] = await migrator.query(
      `SELECT created_tenant_id AS id FROM access_requests WHERE id = $1`,
      [req.id],
    );
    tenants.push(t.id);
    const [s] = await migrator.query(
      `SELECT status, plan_id, plan_snapshot, trial_started_at, trial_ends_at
         FROM subscriptions WHERE tenant_id = $1`,
      [t.id],
    );
    const days =
      (new Date(s.trial_ends_at).getTime() - new Date(s.trial_started_at).getTime()) / 864e5;
    expect(s.status).toBe('trialing');
    expect(s.plan_id).toBeNull(); // nothing purchased
    expect(days).toBeCloseTo(15, 3);
    expect(s.plan_snapshot).toMatchObject({
      code: 'free-trial',
      priceMinor: 0,
      limits: { branches: 1, staff: 3, ordersPerMonth: 200, menuItems: 50 },
    });
  });
});
