import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PasswordHasher } from '../src/core/security/password-hasher';
import { MailService } from '../src/modules/notifications/mail.service';
import { connect } from './helpers';

/**
 * "Get started" requests: public submission (CSRF, honeypot, duplicates), the Super Admin review
 * queue (permissions), approval creating a working restaurant account, and rejection.
 */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;

describe('Access requests (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  let mail: MailService;
  let adminToken: string;
  let ownerToken: string;
  const createdTenants: string[] = [];
  const createdUsers: string[] = [];

  const http = () => {
    const agent = request(app.getHttpServer());
    const ip = freshIp();
    return {
      get: (url: string) => agent.get(url).set('X-Forwarded-For', ip),
      post: (url: string) => agent.post(url).set('X-Forwarded-For', ip),
    };
  };
  const submit = (body: Record<string, unknown>) =>
    http().post(`${API}/access-requests`).set('X-FoodStack-CSRF', '1').send(body);
  const asAdmin = (method: 'get' | 'post', url: string) =>
    http()[method](`${API}${url}`).set('Authorization', `Bearer ${adminToken}`);

  async function createUser(key: string): Promise<{ id: string; email: string }> {
    const email = `${key}-${suffix()}@example.test`;
    const hash = await new PasswordHasher().hash(PASSWORD);
    const [row] = await migrator.query(
      `INSERT INTO users (email, full_name, password_hash, email_verified_at)
       VALUES ($1, $2, $3, now()) RETURNING id`,
      [email, key, hash],
    );
    createdUsers.push(email);
    return { id: row.id as string, email };
  }

  const newRequest = (overrides: Record<string, unknown> = {}) => ({
    restaurantName: `Spice Hub ${suffix()}`,
    contactName: 'Priya Shah',
    email: `priya-${suffix()}@example.test`,
    phone: '+91 98765 43210',
    city: 'Bhubaneswar',
    branchCount: 2,
    message: 'We run two outlets.',
    ...overrides,
  });

  async function pendingIdFor(email: string): Promise<string> {
    const res = await asAdmin('get', '/platform/access-requests?status=pending').expect(200);
    const row = (res.body.data as { id: string; email: string }[]).find((r) => r.email === email);
    expect(row).toBeDefined();
    return row!.id;
  }

  beforeAll(async () => {
    migrator = await connect('migration');
    await migrator.runMigrations({ transaction: 'each' });

    const admin = await createUser('reqAdmin');
    await migrator.query(
      `INSERT INTO platform_role_assignments (user_id, role_id)
       SELECT $1, id FROM roles WHERE tenant_id IS NULL AND code = 'super_admin'`,
      [admin.id],
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app);
    await app.init();
    mail = app.get(MailService);

    // Super Admin session (TOTP enrolment on first sign-in).
    const first = await http()
      .post(`${API}/auth/login`)
      .send({ email: admin.email, password: PASSWORD })
      .expect(202);
    const challengeToken = first.body.data.challengeToken as string;
    const setup = await http()
      .post(`${API}/auth/mfa/enroll/start`)
      .send({ challengeToken })
      .expect(200);
    const totp = new TOTP({ secret: Secret.fromBase32(setup.body.data.manualKey) });
    const done = await http()
      .post(`${API}/auth/mfa/enroll/confirm`)
      .send({ challengeToken, code: totp.generate() })
      .expect(200);
    adminToken = done.body.data.accessToken as string;
  });

  afterAll(async () => {
    // Let the best-effort admin notification from the last submission finish first.
    await new Promise((r) => setTimeout(r, 500));
    await app?.close();
    if (migrator?.isInitialized) {
      // Remove role assignments that reference the seeded system roles, so the migration
      // round-trip test (database.int-spec) can still revert the seed migration.
      await migrator.query('DELETE FROM user_role_assignments WHERE tenant_id = ANY($1::uuid[])', [
        createdTenants,
      ]);
      await migrator.query(
        'DELETE FROM platform_role_assignments WHERE user_id IN (SELECT id FROM users WHERE email = ANY($1::citext[]))',
        [createdUsers],
      );
      await migrator.destroy();
    }
  });

  describe('public submission', () => {
    it('stores a request and tells Super Admins', async () => {
      const body = newRequest();
      mail.outbox.length = 0;
      const res = await submit(body).expect(202);
      expect(res.body.data).toEqual({ status: 'received' });
      const [row] = await migrator.query(
        'SELECT status, restaurant_name, branch_count, ip FROM access_requests WHERE email = $1',
        [body.email],
      );
      expect(row).toMatchObject({
        status: 'pending',
        restaurant_name: body.restaurantName,
        branch_count: 2,
      });
      expect(row.ip).not.toBeNull();
      // Notification is best-effort and asynchronous.
      await new Promise((r) => setTimeout(r, 300));
      expect(mail.outbox.some((m) => m.subject.includes(body.restaurantName as string))).toBe(true);
    });

    it('requires the CSRF header', async () => {
      await http().post(`${API}/access-requests`).send(newRequest()).expect(403);
    });

    it('validates input', async () => {
      const res = await submit(newRequest({ email: 'not-an-email', restaurantName: 'X' })).expect(
        400,
      );
      expect(res.body.code).toBe('VALIDATION_FAILED');
      await submit({ ...newRequest(), isAdmin: true }).expect(400); // unknown keys rejected
    });

    it('answers a bot (honeypot filled) the same way without storing it', async () => {
      const body = newRequest({ website: 'http://spam.example' });
      await submit(body).expect(202);
      const rows = await migrator.query('SELECT 1 FROM access_requests WHERE email = $1', [
        body.email,
      ]);
      expect(rows).toHaveLength(0);
    });

    it('keeps one open request per email', async () => {
      const body = newRequest();
      await submit(body).expect(202);
      await submit({ ...body, restaurantName: 'Another name' }).expect(202);
      const rows = await migrator.query('SELECT 1 FROM access_requests WHERE email = $1', [
        body.email,
      ]);
      expect(rows).toHaveLength(1);
    });
  });

  describe('review queue', () => {
    it('is closed to anonymous callers and tenant users', async () => {
      await http().get(`${API}/platform/access-requests`).expect(401);
      const owner = await createUser('reqOwner');
      const t = (
        await migrator.query(`INSERT INTO tenants (slug, name) VALUES ($1, 'Owned') RETURNING id`, [
          `owned-${suffix()}`,
        ])
      )[0].id as string;
      createdTenants.push(t);
      const [m] = await migrator.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, status, joined_at)
         VALUES ($1, $2, 'active', now()) RETURNING id`,
        [t, owner.id],
      );
      await migrator.query(
        `INSERT INTO user_role_assignments (tenant_id, membership_id, role_id, scope_type)
         SELECT $1, $2, id, 'tenant' FROM roles WHERE tenant_id IS NULL AND code = 'owner'`,
        [t, m.id],
      );
      const login = await http()
        .post(`${API}/auth/login`)
        .send({ email: owner.email, password: PASSWORD })
        .expect(200);
      ownerToken = login.body.data.accessToken as string;
      await http()
        .get(`${API}/platform/access-requests`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(403);
    });

    it('lists pending requests with a suggested web address, and counts them', async () => {
      const body = newRequest({ restaurantName: 'Café Délice & Grill' });
      await submit(body).expect(202);
      const res = await asAdmin('get', '/platform/access-requests').expect(200);
      const row = (res.body.data as Record<string, unknown>[]).find((r) => r.email === body.email);
      expect(row).toMatchObject({ status: 'pending', suggestedSlug: 'cafe-delice-grill' });
      const count = await asAdmin('get', '/platform/access-requests/pending-count').expect(200);
      expect(count.body.data.pending).toBeGreaterThanOrEqual(1);
    });
  });

  describe('approval', () => {
    it('creates the restaurant on trial, invites the owner, and the owner can sign in', async () => {
      const body = newRequest();
      await submit(body).expect(202);
      const id = await pendingIdFor(body.email as string);
      const slug = `spice-${suffix()}`;
      mail.outbox.length = 0;

      const res = await asAdmin('post', `/platform/access-requests/${id}/approve`)
        .send({ slug })
        .expect(201);
      expect(res.body.data).toMatchObject({ slug, ownerEmail: body.email, ownerInvited: true });
      createdTenants.push(res.body.data.tenantId);
      createdUsers.push(body.email as string);

      const [tenant] = await migrator.query(
        `SELECT t.status, t.trial_ends_at IS NOT NULL AS trial,
                (SELECT count(*)::int FROM branches b WHERE b.tenant_id = t.id) AS branches
           FROM tenants t WHERE t.slug = $1`,
        [slug],
      );
      expect(tenant).toMatchObject({ status: 'trial', trial: true, branches: 1 });
      const [req] = await migrator.query(
        'SELECT status, created_tenant_id, reviewed_at FROM access_requests WHERE id = $1',
        [id],
      );
      expect(req).toMatchObject({ status: 'approved', created_tenant_id: res.body.data.tenantId });

      // Owner sets a password from the emailed link, then lands on the restaurant dashboard.
      const message = mail.outbox.find((m) => m.to === body.email);
      expect(message!.text).toContain('/welcome?token=');
      const token = /token=([A-Za-z0-9_-]+)/.exec(message!.text)![1]!;
      await http()
        .post(`${API}/auth/password/reset`)
        .set('X-FoodStack-CSRF', '1')
        .send({ token, password: PASSWORD })
        .expect(204);
      const login = await http()
        .post(`${API}/auth/login`)
        .send({ email: body.email, password: PASSWORD })
        .expect(200);
      expect(login.body.data.profile).toMatchObject({
        audience: 'tenant',
        roles: ['owner'],
        homePath: '/restaurant/dashboard',
        activeTenant: { slug },
      });

      // A decided request cannot be decided again.
      const again = await asAdmin('post', `/platform/access-requests/${id}/reject`)
        .send({})
        .expect(409);
      expect(again.body.code).toBe('ALREADY_REVIEWED');
    });

    it('refuses a web address that is already taken, leaving the request pending', async () => {
      const first = newRequest();
      const second = newRequest();
      await submit(first).expect(202);
      await submit(second).expect(202);
      const slug = `taken-${suffix()}`;
      const ok = await asAdmin(
        'post',
        `/platform/access-requests/${await pendingIdFor(first.email as string)}/approve`,
      )
        .send({ slug })
        .expect(201);
      createdTenants.push(ok.body.data.tenantId);
      createdUsers.push(first.email as string);

      const secondId = await pendingIdFor(second.email as string);
      const res = await asAdmin('post', `/platform/access-requests/${secondId}/approve`)
        .send({ slug })
        .expect(409);
      expect(res.body.code).toBe('SLUG_TAKEN');
      const [row] = await migrator.query('SELECT status FROM access_requests WHERE id = $1', [
        secondId,
      ]);
      expect(row.status).toBe('pending');
    });

    it('rejects a malformed web address', async () => {
      const body = newRequest();
      await submit(body).expect(202);
      const id = await pendingIdFor(body.email as string);
      await asAdmin('post', `/platform/access-requests/${id}/approve`)
        .send({ slug: 'Bad Slug!' })
        .expect(400);
    });

    it('is not allowed for tenant users', async () => {
      const body = newRequest();
      await submit(body).expect(202);
      const id = await pendingIdFor(body.email as string);
      await http()
        .post(`${API}/platform/access-requests/${id}/approve`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ slug: `nope-${suffix()}` })
        .expect(403);
    });
  });

  describe('rejection', () => {
    it('marks the request rejected and emails the requester', async () => {
      const body = newRequest();
      await submit(body).expect(202);
      const id = await pendingIdFor(body.email as string);
      mail.outbox.length = 0;
      await asAdmin('post', `/platform/access-requests/${id}/reject`)
        .send({ note: 'Outside our service area' })
        .expect(204);
      const [row] = await migrator.query(
        'SELECT status, review_note FROM access_requests WHERE id = $1',
        [id],
      );
      expect(row).toEqual({ status: 'rejected', review_note: 'Outside our service area' });
      expect(mail.outbox.some((m) => m.to === body.email)).toBe(true);
      // The same person can ask again later.
      await submit(body).expect(202);
      const rows = await migrator.query(
        "SELECT 1 FROM access_requests WHERE email = $1 AND status = 'pending'",
        [body.email],
      );
      expect(rows).toHaveLength(1);
    });
  });
});
