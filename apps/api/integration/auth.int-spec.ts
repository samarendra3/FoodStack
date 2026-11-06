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
import { connect, deliverEmails, waitForEmail } from './helpers';

/**
 * End-to-end authentication against real PostgreSQL (as the RLS-restricted API role) and Redis:
 * sign-in, role-based landing pages, lockout, refresh rotation and reuse detection, CSRF,
 * Super Admin TOTP, platform access, tenant and branch isolation, suspension and password reset.
 */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';

interface Tenant {
  id: string;
  slug: string;
  mainBranch: string;
  otherBranch: string;
}

const suffix = () => randomBytes(4).toString('hex');
/** Unique client IP per call, so per-IP rate limits never couple tests (TRUST_PROXY=true). */
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;

function cookie(res: request.Response, name: string): { value: string; raw: string } | undefined {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  const raw = header?.find((c) => c.startsWith(`${name}=`));
  if (!raw) return undefined;
  return { value: decodeURIComponent(raw.slice(name.length + 1).split(';')[0]!), raw };
}

describe('Authentication (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  let mail: MailService;
  const hasher = new PasswordHasher();
  let passwordHash: string;
  let tenantA: Tenant;
  let tenantB: Tenant;
  const emails: Record<string, string> = {};

  /** Each call is a new client IP; tests that exercise the per-IP limit set their own. */
  const http = () => {
    const agent = request(app.getHttpServer());
    const ip = freshIp();
    return {
      get: (url: string) => agent.get(url).set('X-Forwarded-For', ip),
      post: (url: string) => agent.post(url).set('X-Forwarded-For', ip),
    };
  };

  const login = (email: string, password = PASSWORD, extra: Record<string, unknown> = {}) =>
    http()
      .post(`${API}/auth/login`)
      .set('X-Forwarded-For', freshIp())
      .send({ email, password, ...extra });

  async function token(who: string): Promise<string> {
    const res = await login(emails[who]!).expect(200);
    return res.body.data.accessToken as string;
  }

  const refresh = (rt: string) =>
    http()
      .post(`${API}/auth/refresh`)
      .set('X-Forwarded-For', freshIp())
      .set('X-FoodStack-CSRF', '1')
      .set('Cookie', `fs_rt=${rt}`);

  async function createUser(key: string, opts: { verified?: boolean } = {}) {
    const email = `${key}-${suffix()}@example.test`;
    emails[key] = email;
    const [row] = await migrator.query(
      `INSERT INTO users (email, full_name, password_hash, email_verified_at)
       VALUES ($1, $2, $3, CASE WHEN $4 THEN now() END) RETURNING id`,
      [email, key, passwordHash, opts.verified ?? true],
    );
    return row.id as string;
  }

  async function createTenant(label: string): Promise<Tenant> {
    const slug = `${label}-${suffix()}`;
    const [t] = await migrator.query(
      `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
      [slug, label],
    );
    const [r] = await migrator.query(
      `INSERT INTO restaurants (tenant_id, name, slug, currency_code, country_code, timezone)
       VALUES ($1, $2, $3, 'INR', 'IN', 'Asia/Kolkata') RETURNING id`,
      [t.id, `${label} Restaurant`, slug],
    );
    const branch = async (code: string, isDefault: boolean) =>
      (
        await migrator.query(
          `INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone, is_default)
           VALUES ($1, $2, $3, $5, 'Asia/Kolkata', $4) RETURNING id`,
          [t.id, r.id, code, isDefault, `${code} branch`],
        )
      )[0].id as string;
    return {
      id: t.id,
      slug,
      mainBranch: await branch('MAIN', true),
      otherBranch: await branch('SECOND', false),
    };
  }

  async function addMember(userId: string, tenant: Tenant, role: string, branchId?: string) {
    const [m] = await migrator.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, status, joined_at)
       VALUES ($1, $2, 'active', now()) RETURNING id`,
      [tenant.id, userId],
    );
    await migrator.query(
      `INSERT INTO user_role_assignments (tenant_id, membership_id, role_id, scope_type, scope_id)
       SELECT $1, $2, id, $4, $5 FROM roles WHERE tenant_id IS NULL AND code = $3`,
      [tenant.id, m.id, role, branchId ? 'branch' : 'tenant', branchId ?? null],
    );
  }

  beforeAll(async () => {
    migrator = await connect('migration');
    await migrator.runMigrations({ transaction: 'each' });
    passwordHash = await hasher.hash(PASSWORD);

    tenantA = await createTenant('alpha');
    tenantB = await createTenant('bravo');
    await addMember(await createUser('ownerA'), tenantA, 'owner');
    await addMember(await createUser('adminA'), tenantA, 'restaurant_admin');
    await addMember(await createUser('managerA'), tenantA, 'branch_manager', tenantA.mainBranch);
    await addMember(await createUser('cashierA'), tenantA, 'cashier', tenantA.mainBranch);
    await addMember(await createUser('kitchenA'), tenantA, 'kitchen_staff', tenantA.mainBranch);
    await addMember(await createUser('waiterA'), tenantA, 'waiter', tenantA.mainBranch);
    await addMember(await createUser('ownerB'), tenantB, 'owner');
    await addMember(
      await createUser('unverified', { verified: false }),
      tenantA,
      'cashier',
      tenantA.mainBranch,
    );
    await createUser('lonely');
    const adminId = await createUser('superAdmin');
    await migrator.query(
      `INSERT INTO platform_role_assignments (user_id, role_id)
       SELECT $1, id FROM roles WHERE tenant_id IS NULL AND code = 'super_admin'`,
      [adminId],
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app);
    await app.init();
    mail = app.get(MailService);
  });

  afterAll(async () => {
    await app?.close();
    // Role assignments reference the seeded system roles; remove ours so the migration
    // round-trip test (database.int-spec) can still revert the seed migration.
    if (migrator?.isInitialized) {
      await migrator.query('DELETE FROM user_role_assignments WHERE tenant_id = ANY($1::uuid[])', [
        [tenantA?.id, tenantB?.id].filter(Boolean),
      ]);
      await migrator.query(
        'DELETE FROM platform_role_assignments WHERE user_id IN (SELECT id FROM users WHERE email = ANY($1::citext[]))',
        [Object.values(emails)],
      );
      await migrator.destroy();
    }
  });

  describe('sign-in', () => {
    it('signs in, sets secure cookies and never returns secrets', async () => {
      const res = await login(emails.ownerA!, PASSWORD, { rememberMe: true }).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const { data } = res.body;
      expect(data.accessToken).toMatch(/^ey/);
      expect(data.profile).toMatchObject({
        audience: 'tenant',
        homePath: '/restaurant/dashboard',
        roles: ['owner'],
        activeTenant: { id: tenantA.id },
      });
      expect(JSON.stringify(data)).not.toMatch(/password|hash|fs_rt/i);

      const rt = cookie(res, 'fs_rt')!;
      expect(rt.raw).toMatch(/HttpOnly/);
      expect(rt.raw).toMatch(/SameSite=Strict/);
      expect(rt.raw).toMatch(/Path=\/api\/v1\/auth/);
      expect(rt.raw).toMatch(/Max-Age=\d+/);
      expect(cookie(res, 'fs_session')!.value).toBe('tenant');
    });

    it('uses browser-session cookies without "Remember me"', async () => {
      const res = await login(emails.ownerA!).expect(200);
      expect(cookie(res, 'fs_rt')!.raw).not.toMatch(/Max-Age|Expires/);
    });

    it.each([
      ['ownerA', '/restaurant/dashboard'],
      ['adminA', '/restaurant/dashboard'],
      ['managerA', '/restaurant/dashboard'],
      ['cashierA', '/pos'],
      ['kitchenA', '/kitchen'],
      ['waiterA', '/waiter'],
    ])('redirects %s to %s', async (who, path) => {
      const res = await login(emails[who]!).expect(200);
      expect(res.body.data.profile.homePath).toBe(path);
    });

    it('gives the same answer for a wrong password and an unknown email', async () => {
      const wrong = await login(emails.ownerA!, 'not-the-password').expect(401);
      const unknown = await login(`nobody-${suffix()}@example.test`).expect(401);
      for (const res of [wrong, unknown]) {
        expect(res.body).toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS', status: 401 });
      }
      expect(wrong.body.detail).toBe(unknown.body.detail);
    });

    it('validates input', async () => {
      const res = await login('not-an-email', '').expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual(
        expect.arrayContaining(['email', 'password']),
      );
    });

    it('locks the account after 5 failures, even for the right password', async () => {
      const email = emails.adminA!;
      for (let i = 0; i < 4; i += 1) await login(email, 'wrong-password').expect(401);
      await login(email, 'wrong-password').expect(401); // 5th failure locks
      const locked = await login(email).expect(423);
      expect(locked.body.code).toBe('AUTH_ACCOUNT_LOCKED');
      const [attempts] = await migrator.query(
        `SELECT count(*)::int AS n FROM login_attempts WHERE email = $1 AND reason = 'bad_credentials'`,
        [email],
      );
      expect(attempts.n).toBe(5);
      await migrator.query(
        'UPDATE users SET locked_until = NULL, failed_login_count = 0 WHERE email = $1',
        [email],
      );
    });

    it('rejects unverified accounts and users without any restaurant', async () => {
      expect((await login(emails.unverified!).expect(403)).body.code).toBe('AUTH_EMAIL_UNVERIFIED');
      expect((await login(emails.lonely!).expect(403)).body.code).toBe('AUTH_NO_ACCESS');
    });

    it('rate-limits sign-in per client IP', async () => {
      const ip = freshIp();
      const attempt = () =>
        http()
          .post(`${API}/auth/login`)
          .set('X-Forwarded-For', ip)
          .send({
            email: `rl-${suffix()}@example.test`,
            password: 'x',
          });
      for (let i = 0; i < 10; i += 1) await attempt().expect(401);
      const limited = await attempt().expect(429);
      expect(limited.headers['retry-after']).toBeDefined();
    });
  });

  describe('sessions', () => {
    it('requires a token for protected routes and returns the profile with one', async () => {
      expect((await http().get(`${API}/auth/me`).expect(401)).body.code).toBe(
        'AUTH_UNAUTHENTICATED',
      );
      await http().get(`${API}/auth/me`).set('Authorization', 'Bearer nonsense').expect(401);
      const cashierAToken = await token('cashierA');
      const me = await http()
        .get(`${API}/auth/me`)
        .set('Authorization', `Bearer ${cashierAToken}`)
        .expect(200);
      expect(me.body.data).toMatchObject({ homePath: '/pos', roles: ['cashier'] });
      expect(me.body.data.branches.map((b: { id: string }) => b.id)).toEqual([tenantA.mainBranch]);
    });

    it('rotates refresh tokens and revokes the session when an old one is replayed', async () => {
      const first = cookie(await login(emails.ownerA!).expect(200), 'fs_rt')!.value;
      const rotated = await refresh(first).expect(200);
      const second = cookie(rotated, 'fs_rt')!.value;
      expect(second).not.toBe(first);
      expect(rotated.body.data.profile.homePath).toBe('/restaurant/dashboard');

      // Move the first use outside the 10 s grace window for concurrent tabs.
      const [sessionId] = first.split('.');
      await migrator.query(
        `UPDATE refresh_tokens SET used_at = now() - interval '1 minute'
          WHERE session_id = $1 AND used_at IS NOT NULL`,
        [sessionId],
      );
      const replay = await refresh(first).expect(401);
      expect(replay.body.code).toBe('AUTH_REFRESH_REUSED');
      // The legitimate holder is signed out too: the token family is compromised.
      expect((await refresh(second).expect(401)).body.code).toBe('AUTH_SESSION_REVOKED');
      const [session] = await migrator.query('SELECT revoke_reason FROM sessions WHERE id = $1', [
        sessionId,
      ]);
      expect(session.revoke_reason).toBe('reuse_detected');
    });

    it('rejects cookie requests without the CSRF header or from a foreign origin', async () => {
      const rt = cookie(await login(emails.ownerA!).expect(200), 'fs_rt')!.value;
      const noHeader = await http().post(`${API}/auth/refresh`).set('Cookie', `fs_rt=${rt}`);
      expect(noHeader.status).toBe(403);
      expect(noHeader.body.code).toBe('AUTH_CSRF_FAILED');
      const foreign = await refresh(rt).set('Origin', 'https://evil.example');
      expect(foreign.status).toBe(403);
    });

    it('logs out: the access token stops working immediately', async () => {
      const res = await login(emails.waiterA!).expect(200);
      const access = res.body.data.accessToken as string;
      const rt = cookie(res, 'fs_rt')!.value;
      await http()
        .post(`${API}/auth/logout`)
        .set('X-FoodStack-CSRF', '1')
        .set('Cookie', `fs_rt=${rt}`)
        .expect(204);
      const after = await http().get(`${API}/auth/me`).set('Authorization', `Bearer ${access}`);
      expect(after.status).toBe(401);
      expect(after.body.code).toBe('AUTH_SESSION_REVOKED');
      await refresh(rt).expect(401);
    });
  });

  describe('tenant and branch isolation', () => {
    it("lists only the caller's own tenant and branches", async () => {
      const ownerAToken = await token('ownerA');
      const res = await http()
        .get(`${API}/restaurant/overview`)
        .set('Authorization', `Bearer ${ownerAToken}`)
        .expect(200);
      expect(res.body.data.tenant.id).toBe(tenantA.id);
      const ids = res.body.data.branches.map((b: { id: string }) => b.id).sort();
      expect(ids).toEqual([tenantA.mainBranch, tenantA.otherBranch].sort());
      expect(JSON.stringify(res.body)).not.toContain(tenantB.id);
    });

    it("answers 404 for another restaurant's branch (existence is not revealed)", async () => {
      const ownerA = await token('ownerA');
      await http()
        .get(`${API}/branches/${tenantA.mainBranch}`)
        .set('Authorization', `Bearer ${ownerA}`)
        .expect(200);
      for (const id of [tenantB.mainBranch, tenantB.otherBranch]) {
        const res = await http()
          .get(`${API}/branches/${id}`)
          .set('Authorization', `Bearer ${ownerA}`);
        expect(res.status).toBe(404);
      }
      const ownerB = await token('ownerB');
      await http()
        .get(`${API}/branches/${tenantA.mainBranch}`)
        .set('Authorization', `Bearer ${ownerB}`)
        .expect(404);
    });

    it('keeps branch staff inside their branch', async () => {
      const cashier = await token('cashierA');
      await http()
        .get(`${API}/branches/${tenantA.mainBranch}`)
        .set('Authorization', `Bearer ${cashier}`)
        .expect(200);
      const other = await http()
        .get(`${API}/branches/${tenantA.otherBranch}`)
        .set('Authorization', `Bearer ${cashier}`)
        .expect(403);
      expect(other.body.code).toBe('BRANCH_FORBIDDEN');
      const overview = await http()
        .get(`${API}/restaurant/overview`)
        .set('Authorization', `Bearer ${cashier}`)
        .expect(200);
      expect(overview.body.data.branches.map((b: { id: string }) => b.id)).toEqual([
        tenantA.mainBranch,
      ]);
      expect(overview.body.data.activeMembers).toBeNull(); // no member:read
    });

    it('blocks a suspended restaurant immediately, including open sessions', async () => {
      const ownerB = await token('ownerB');
      await migrator.transaction(async (m) => {
        await m.query(`SELECT set_config('app.platform', 'on', true)`);
        await m.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [tenantB.id]);
      });
      const me = await http().get(`${API}/auth/me`).set('Authorization', `Bearer ${ownerB}`);
      expect(me.status).toBe(403);
      expect(me.body.code).toBe('TENANT_INACTIVE');
      expect((await login(emails.ownerB!).expect(403)).body.code).toBe('TENANT_INACTIVE');
    });
  });

  describe('platform administration', () => {
    it('refuses restaurant users, whatever they ask for', async () => {
      const ownerA = await token('ownerA');
      const res = await http()
        .get(`${API}/platform/dashboard`)
        .set('Authorization', `Bearer ${ownerA}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AUTH_AUDIENCE_FORBIDDEN');
      const asked = await login(emails.ownerA!, PASSWORD, { audience: 'platform' }).expect(403);
      expect(asked.body.code).toBe('AUTH_PLATFORM_FORBIDDEN');
    });

    it('requires TOTP enrolment for Super Admin, then grants the platform dashboard', async () => {
      const first = await login(emails.superAdmin!).expect(202);
      expect(first.body.data).toMatchObject({ mfaRequired: true, mfaEnrollmentRequired: true });
      expect(cookie(first, 'fs_rt')).toBeUndefined(); // no session before the second factor

      const challengeToken = first.body.data.challengeToken as string;
      const setup = await http()
        .post(`${API}/auth/mfa/enroll/start`)
        .send({ challengeToken })
        .expect(200);
      expect(setup.body.data.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
      expect(setup.body.data.qrDataUrl).toMatch(/^data:image\/png;base64,/);
      const totp = new TOTP({ secret: Secret.fromBase32(setup.body.data.manualKey) });

      await http()
        .post(`${API}/auth/mfa/enroll/confirm`)
        .send({ challengeToken, code: '000000' === totp.generate() ? '111111' : '000000' })
        .expect(401);
      const code = totp.generate();
      const done = await http()
        .post(`${API}/auth/mfa/enroll/confirm`)
        .send({ challengeToken, code })
        .expect(200);
      expect(done.body.data.recoveryCodes).toHaveLength(10);
      expect(done.body.data.profile).toMatchObject({
        audience: 'platform',
        homePath: '/platform/dashboard',
        roles: ['super_admin'],
      });
      expect(cookie(done, 'fs_session')!.value).toBe('platform');
      const [stored] = await migrator.query(
        'SELECT mfa_enabled, mfa_secret_enc FROM users WHERE email = $1',
        [emails.superAdmin],
      );
      expect(stored.mfa_enabled).toBe(true);
      expect(stored.mfa_secret_enc.toString('utf8')).not.toContain(setup.body.data.manualKey);

      const access = done.body.data.accessToken as string;
      const dash = await http()
        .get(`${API}/platform/dashboard`)
        .set('Authorization', `Bearer ${access}`)
        .expect(200);
      expect(dash.body.data.tenants.total).toBeGreaterThanOrEqual(2);
      const tenants = await http()
        .get(`${API}/platform/tenants`)
        .set('Authorization', `Bearer ${access}`)
        .expect(200);
      expect(tenants.body.data.map((t: { id: string }) => t.id)).toEqual(
        expect.arrayContaining([tenantA.id, tenantB.id]),
      );
      // A platform session cannot use restaurant endpoints.
      await http()
        .get(`${API}/restaurant/overview`)
        .set('Authorization', `Bearer ${access}`)
        .expect(403);

      // Next sign-in: TOTP verification. The code just used cannot be replayed.
      const again = await login(emails.superAdmin!).expect(202);
      expect(again.body.data.mfaEnrollmentRequired).toBe(false);
      const replay = await http()
        .post(`${API}/auth/mfa/verify`)
        .send({ challengeToken: again.body.data.challengeToken, code })
        .expect(401);
      expect(replay.body.code).toBe('AUTH_MFA_INVALID');

      // A recovery code works once.
      const recovery = done.body.data.recoveryCodes[0] as string;
      await http()
        .post(`${API}/auth/mfa/verify`)
        .send({ challengeToken: again.body.data.challengeToken, recoveryCode: recovery })
        .expect(200);
      const third = await login(emails.superAdmin!).expect(202);
      await http()
        .post(`${API}/auth/mfa/verify`)
        .send({ challengeToken: third.body.data.challengeToken, recoveryCode: recovery })
        .expect(401);
    });
  });

  describe('password reset', () => {
    it('answers identically for unknown emails and sends nothing', async () => {
      await deliverEmails(app); // earlier tests' mail
      const before = mail.outbox.length;
      await http()
        .post(`${API}/auth/password/forgot`)
        .set('X-Forwarded-For', freshIp())
        .send({ email: `ghost-${suffix()}@example.test` })
        .expect(202);
      await deliverEmails(app);
      expect(mail.outbox.length).toBe(before);
    });

    it('resets the password, ends every session and the link works once', async () => {
      const old = await login(emails.kitchenA!).expect(200);
      await http()
        .post(`${API}/auth/password/forgot`)
        .set('X-Forwarded-For', freshIp())
        .send({ email: emails.kitchenA })
        .expect(202);
      const message = (await waitForEmail(app, (m) => m.to === emails.kitchenA!.toLowerCase()))!;
      const resetToken = /token=([A-Za-z0-9_-]+)/.exec(message.text)![1]!;

      const weak = await http()
        .post(`${API}/auth/password/reset`)
        .set('X-Forwarded-For', freshIp())
        .send({ token: resetToken, password: 'short' })
        .expect(400);
      expect(weak.body.code).toBe('VALIDATION_FAILED');

      const newPassword = 'A-much-better-passphrase-7';
      await http()
        .post(`${API}/auth/password/reset`)
        .set('X-Forwarded-For', freshIp())
        .send({ token: resetToken, password: newPassword })
        .expect(204);
      await http()
        .get(`${API}/auth/me`)
        .set('Authorization', `Bearer ${old.body.data.accessToken}`)
        .expect(401);
      await login(emails.kitchenA!).expect(401);
      expect(
        (await login(emails.kitchenA!, newPassword).expect(200)).body.data.profile.homePath,
      ).toBe('/kitchen');
      const reused = await http()
        .post(`${API}/auth/password/reset`)
        .set('X-Forwarded-For', freshIp())
        .send({ token: resetToken, password: newPassword })
        .expect(400);
      expect(reused.body.code).toBe('AUTH_RESET_TOKEN_INVALID');
    });

    it('signs straight in after a reset when asked, but a Super Admin still needs TOTP', async () => {
      const resetFor = async (email: string) => {
        await http()
          .post(`${API}/auth/password/forgot`)
          .set('X-Forwarded-For', freshIp())
          .send({ email })
          .expect(202);
        const message = (await waitForEmail(app, (m) => m.to === email.toLowerCase()))!;
        return /token=([A-Za-z0-9_-]+)/.exec(message.text)![1]!;
      };

      const staffToken = await resetFor(emails.waiterA!);
      const staff = await http()
        .post(`${API}/auth/password/reset`)
        .set('X-Forwarded-For', freshIp())
        .send({ token: staffToken, password: PASSWORD, signIn: true })
        .expect(200);
      expect(staff.headers['cache-control']).toBe('no-store');
      expect(staff.body.data.profile).toMatchObject({ homePath: '/waiter' });
      expect(cookie(staff, 'fs_rt')).toBeDefined();

      const adminToken = await resetFor(emails.superAdmin!);
      const admin = await http()
        .post(`${API}/auth/password/reset`)
        .set('X-Forwarded-For', freshIp())
        .send({ token: adminToken, password: PASSWORD, signIn: true })
        .expect(202);
      expect(admin.body.data).toMatchObject({ mfaRequired: true });
      expect(admin.body.data.accessToken).toBeUndefined();
      expect(cookie(admin, 'fs_rt')).toBeUndefined();
    });
  });
});
