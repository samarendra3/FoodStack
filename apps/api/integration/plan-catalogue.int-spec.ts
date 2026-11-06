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
import { SubscriptionLifecycleService } from '../src/modules/billing/subscription-lifecycle.service';
import { connect } from './helpers';

/**
 * Plan catalogue as the single source of truth: Super Admin CRUD (with authorization), public
 * pricing that reflects edits immediately and only lists offered plans, the restaurant page
 * using the same plan view, frozen terms for existing subscribers (price, limits) after edits,
 * delete-vs-archive, custom pricing, downgrade fit checks, plan limits enforced on the backend,
 * and the trial length coming from the plan picked at signup.
 */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;

describe('Plan catalogue (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  const tenants: string[] = [];
  const users: string[] = [];
  const emails: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  const tag = suffix();
  let tenantId: string;
  let branchId: string;
  let created: { id: string; slug: string };

  const http = () => request(app.getHttpServer());
  const call = (who: string, method: 'get' | 'post' | 'patch' | 'delete', url: string) =>
    http()
      [method](`${API}${url}`)
      .set('X-Forwarded-For', freshIp())
      .set('Authorization', `Bearer ${tokens[who]}`);
  const publicPlans = async () =>
    (await http().get(`${API}/plans`).expect(200)).body.data as {
      slug: string;
      priceMonthlyMinor: number | null;
      [k: string]: unknown;
    }[];
  const mine = <T extends { slug: string }>(list: T[]) =>
    list.filter((p) => p.slug.startsWith(`pc${tag}`));
  const newPlan = (slug: string, extra: object = {}) =>
    call('admin', 'post', '/platform/billing/plans')
      .send({
        code: `pc${tag}-${slug}`,
        name: `PC ${slug}`,
        priceMonthlyMinor: 99900,
        priceYearlyMinor: 959000,
        maxBranches: 1,
        maxStaff: 5,
        maxOrdersPerMonth: null,
        maxMenuItems: null,
        ...extra,
      })
      .expect(201);

  async function user(key: string, hash: string) {
    emails[key] = `pc${key}-${suffix()}@example.test`;
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
      `INSERT INTO tenants (slug, name) VALUES ($1, 'pcrest') RETURNING id`,
      [`pcrest-${suffix()}`],
    );
    tenantId = t.id;
    tenants.push(tenantId);
    const [r] = await migrator.query(
      `INSERT INTO restaurants (tenant_id, name, slug, currency_code, country_code, timezone)
       VALUES ($1, 'pcrest', $2, 'INR', 'IN', 'Asia/Kolkata') RETURNING id`,
      [tenantId, `pcrest-${suffix()}`],
    );
    const [b] = await migrator.query(
      `INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone, is_default)
       VALUES ($1, $2, 'MAIN', 'Main', 'Asia/Kolkata', true) RETURNING id`,
      [tenantId, r.id],
    );
    branchId = b.id;
    const ownerId = await user('owner', hash);
    const [m] = await migrator.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, status, joined_at) VALUES ($1, $2, 'active', now()) RETURNING id`,
      [tenantId, ownerId],
    );
    await migrator.query(
      `INSERT INTO user_role_assignments (tenant_id, membership_id, role_id, scope_type)
       SELECT $1, $2, id, 'tenant' FROM roles WHERE tenant_id IS NULL AND code = 'owner'`,
      [tenantId, m.id],
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
      await migrator.query(`DELETE FROM access_requests WHERE plan_code LIKE $1`, [`pc${tag}%`]);
      await migrator.query(`DELETE FROM plans WHERE code LIKE $1`, [`pc${tag}%`]);
      await migrator.query(
        'DELETE FROM platform_role_assignments WHERE user_id IN (SELECT id FROM users WHERE email = ANY($1::citext[]))',
        [users],
      );
      await migrator.destroy();
    }
  });

  it('only lets Super Admins manage plans', async () => {
    const body = { code: `pc${tag}-x`, name: 'X', priceMonthlyMinor: 1, priceYearlyMinor: 1 };
    await http().post(`${API}/platform/billing/plans`).send(body).expect(401);
    await call('owner', 'post', '/platform/billing/plans').send(body).expect(403);
    await call('owner', 'get', '/platform/billing/plans').expect(403);
  });

  it('creates a plan that appears on public pricing with public fields only', async () => {
    const res = await newPlan('pro', {
      description: 'For growing restaurants',
      badge: 'popular',
      icon: 'rocket',
      trialDays: 21,
      features: ['Kitchen display'],
      featureFlags: { kitchen_display: true, api_access: false },
      sortOrder: 1,
    });
    created = { id: res.body.data.id, slug: res.body.data.slug };
    const p = mine(await publicPlans()).find((x) => x.slug === created.slug)!;
    expect(p).toMatchObject({
      name: 'PC pro',
      badge: 'popular',
      priceMonthlyMinor: 99900,
      priceYearlyMinor: 959000,
      yearlySavingsPercent: 20,
      trialDays: 21,
      limits: { branches: 1, staff: 5, ordersPerMonth: null },
      featureFlags: { kitchen_display: true, api_access: false },
    });
    for (const internal of ['isActive', 'isPublic', 'archivedAt', 'createdAt', 'updatedAt']) {
      expect(p).not.toHaveProperty(internal);
    }
    const one = (await http().get(`${API}/plans/${created.slug}`).expect(200)).body.data;
    expect(one.id).toBe(created.id);
  });

  it('validates plans (prices vs custom pricing, unknown feature keys)', async () => {
    await call('admin', 'post', '/platform/billing/plans')
      .send({ code: `pc${tag}-bad`, name: 'Bad', priceMonthlyMinor: 100 })
      .expect(400);
    await call('admin', 'post', '/platform/billing/plans')
      .send({
        code: `pc${tag}-bad`,
        name: 'Bad',
        customPricing: true,
        priceMonthlyMinor: 100,
        priceYearlyMinor: 100,
      })
      .expect(400);
    await newPlan('flags', { featureFlags: { teleport: true } }).catch(() => undefined);
    expect(mine(await publicPlans()).some((p) => p.slug.endsWith('-flags'))).toBe(false);
  });

  it('shows the restaurant exactly the public plans', async () => {
    const pub = mine(await publicPlans());
    const s = (await call('owner', 'get', '/billing/subscription').expect(200)).body.data;
    expect(mine(s.plans)).toEqual(pub);
  });

  it('reflects edits immediately and hides inactive or private plans', async () => {
    await call('admin', 'patch', `/platform/billing/plans/${created.id}`)
      .send({ priceMonthlyMinor: 129900, name: 'PC pro+' })
      .expect(200);
    let p = mine(await publicPlans()).find((x) => x.slug === created.slug)!;
    expect(p).toMatchObject({ name: 'PC pro+', priceMonthlyMinor: 129900 });

    await call('admin', 'patch', `/platform/billing/plans/${created.id}`)
      .send({ isActive: false })
      .expect(200);
    expect(mine(await publicPlans()).some((x) => x.slug === created.slug)).toBe(false);
    await http().get(`${API}/plans/${created.slug}`).expect(404);
    await call('owner', 'post', '/billing/subscription/requests')
      .send({ planId: created.id, billingCycle: 'monthly' })
      .expect(404);

    await call('admin', 'patch', `/platform/billing/plans/${created.id}`)
      .send({ isActive: true, isPublic: false })
      .expect(200);
    expect(mine(await publicPlans()).some((x) => x.slug === created.slug)).toBe(false);
    await call('admin', 'patch', `/platform/billing/plans/${created.id}`)
      .send({ isPublic: true, priceMonthlyMinor: 99900 })
      .expect(200);
    p = mine(await publicPlans()).find((x) => x.slug === created.slug)!;
    expect(p.priceMonthlyMinor).toBe(99900);
  });

  it('keeps an existing subscriber on the agreed price and limits after the plan changes', async () => {
    const inv = (
      await call('owner', 'post', '/billing/subscription/requests')
        .send({ planId: created.id, billingCycle: 'monthly' })
        .expect(201)
    ).body.data;
    expect(inv.amountMinor).toBe(99900);
    await call('admin', 'post', `/platform/billing/invoices/${inv.id}/mark-paid`)
      .send({ paymentMethod: 'upi', paymentReference: `UTR${suffix()}` })
      .expect(200);

    await call('admin', 'patch', `/platform/billing/plans/${created.id}`)
      .send({ priceMonthlyMinor: 199900, maxStaff: 50, name: 'PC renamed' })
      .expect(200);

    const s = (await call('owner', 'get', '/billing/subscription').expect(200)).body.data;
    expect(s).toMatchObject({ status: 'active', price: 99900, billingCycle: 'monthly' });
    expect(s.plan).toMatchObject({ name: 'PC pro+', limits: { staff: 5, branches: 1 } });
    expect(s.limits).toMatchObject({ staff: 5, branches: 1 });

    // Renewing the same plan and cycle keeps the agreed price; a cycle change uses today's price.
    const renewal = (
      await call('owner', 'post', '/billing/subscription/requests')
        .send({ planId: created.id, billingCycle: 'monthly' })
        .expect(201)
    ).body.data;
    expect(renewal).toMatchObject({ kind: 'renewal', amountMinor: 99900 });
    await call('owner', 'post', `/billing/invoices/${renewal.id}/cancel`).expect(204);
    const yearly = (
      await call('owner', 'post', '/billing/subscription/requests')
        .send({ planId: created.id, billingCycle: 'yearly' })
        .expect(201)
    ).body.data;
    expect(yearly).toMatchObject({ kind: 'cycle_change', amountMinor: 959000 });
    await call('owner', 'post', `/billing/invoices/${yearly.id}/cancel`).expect(204);
  });

  it('enforces the agreed staff and branch limits on the backend', async () => {
    // Agreed limit: 5 staff. The owner is 1; invite 4 more, then the 6th is refused.
    for (let i = 0; i < 4; i++) {
      await call('owner', 'post', '/team/invite')
        .send({
          email: `pcstaff${i}-${suffix()}@example.test`,
          fullName: `Staff ${i}`,
          role: 'cashier',
          branchId,
        })
        .expect(201);
    }
    const res = await call('owner', 'post', '/team/invite')
      .send({
        email: `pcstaff9-${suffix()}@example.test`,
        fullName: 'One too many',
        role: 'cashier',
        branchId,
      })
      .expect(403);
    expect(res.body).toMatchObject({ code: 'STAFF_LIMIT_REACHED' });

    const lifecycle = app.get(SubscriptionLifecycleService);
    await expect(
      app.get(DbContext).run({ tenantId }, (db) => lifecycle.assertCanAddBranch(db, tenantId)),
    ).rejects.toMatchObject({ response: { code: 'BRANCH_LIMIT_REACHED' } });
    await expect(
      app
        .get(DbContext)
        .run({ tenantId }, (db) => lifecycle.assertWithinLimit(db, tenantId, 'menuItems', 1000)),
    ).resolves.toBeUndefined(); // unlimited in this plan
  });

  it('refuses a downgrade the restaurant has outgrown', async () => {
    const small = (
      await newPlan('tiny', { maxStaff: 2, priceMonthlyMinor: 100, priceYearlyMinor: 1000 })
    ).body.data;
    const res = await call('owner', 'post', '/billing/subscription/requests')
      .send({ planId: small.id, billingCycle: 'monthly' })
      .expect(400);
    expect(res.body.code).toBe('PLAN_LIMITS_EXCEEDED');
  });

  it('shows custom-priced plans publicly but sends buyers to sales', async () => {
    const ent = (
      await newPlan('enterprise', {
        planType: 'enterprise',
        customPricing: true,
        priceMonthlyMinor: null,
        priceYearlyMinor: null,
        maxBranches: null,
        maxStaff: null,
      })
    ).body.data;
    const p = (await publicPlans()).find((x) => x.slug === ent.slug)!;
    expect(p).toMatchObject({
      customPricing: true,
      priceMonthlyMinor: null,
      priceYearlyMinor: null,
    });
    const res = await call('owner', 'post', '/billing/subscription/requests')
      .send({ planId: ent.id, billingCycle: 'monthly' })
      .expect(400);
    expect(res.body.code).toBe('PLAN_CUSTOM_PRICING');
  });

  it('deletes unused plans and archives used ones', async () => {
    const unused = (await newPlan('unused')).body.data;
    await call('admin', 'delete', `/platform/billing/plans/${unused.id}`).expect(204);
    const used = await call('admin', 'delete', `/platform/billing/plans/${created.id}`).expect(409);
    expect(used.body.code).toBe('PLAN_IN_USE');
    await call('admin', 'post', `/platform/billing/plans/${created.id}/archive`).expect(200);
    expect(mine(await publicPlans()).some((x) => x.slug === created.slug)).toBe(false);
    await call('admin', 'patch', `/platform/billing/plans/${created.id}`)
      .send({ isActive: true })
      .expect(400);
    // The subscriber keeps their plan and can still renew it on the agreed terms.
    const renewal = (
      await call('owner', 'post', '/billing/subscription/requests')
        .send({ planId: created.id, billingCycle: 'monthly' })
        .expect(201)
    ).body.data;
    expect(renewal.amountMinor).toBe(99900);
    await call('owner', 'post', `/billing/invoices/${renewal.id}/cancel`).expect(204);
  });

  it("starts a new restaurant's trial with the length of the plan picked at signup", async () => {
    const plan = (await newPlan('trial30', { trialDays: 30 })).body.data;
    const email = `pcsignup-${suffix()}@example.test`;
    users.push(email);
    await http()
      .post(`${API}/access-requests`)
      .set('X-FoodStack-CSRF', '1')
      .set('X-Forwarded-For', freshIp())
      .send({
        restaurantName: 'Signup Diner',
        contactName: 'Sam Signup',
        email,
        planCode: plan.slug,
      })
      .expect((r) => expect([201, 202, 204]).toContain(r.status));
    const [req] = await migrator.query(`SELECT id FROM access_requests WHERE email = $1`, [email]);
    const approved = await call('admin', 'post', `/platform/access-requests/${req.id}/approve`)
      .send({ slug: `pcsignup-${suffix()}` })
      .expect((r) => expect([200, 201]).toContain(r.status));
    const [t] = await migrator.query(
      `SELECT created_tenant_id AS id FROM access_requests WHERE id = $1`,
      [req.id],
    );
    expect(approved.status).toBeLessThan(300);
    tenants.push(t.id);
    const [s] = await migrator.query(
      `SELECT trial_started_at, trial_ends_at, status FROM subscriptions WHERE tenant_id = $1`,
      [t.id],
    );
    const days =
      (new Date(s.trial_ends_at).getTime() - new Date(s.trial_started_at).getTime()) / 864e5;
    expect(s.status).toBe('trialing');
    expect(days).toBeCloseTo(30, 3);
  });
});
