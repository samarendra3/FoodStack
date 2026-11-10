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

/** Super Admin users, audit logs and platform settings (sign-up switch, announcement). */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;

describe('Platform admin (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  const emails: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  let tenantId = '';
  const http = () => request(app.getHttpServer());
  const call = (who: string, method: 'get' | 'post' | 'patch', url: string) =>
    http()
      [method](`${API}${url}`)
      .set('X-Forwarded-For', freshIp())
      .set('Authorization', `Bearer ${tokens[who]}`);

  beforeAll(async () => {
    migrator = await connect('migration');
    await migrator.runMigrations({ transaction: 'each' });
    const hash = await new PasswordHasher().hash(PASSWORD);
    const user = async (key: string) => {
      emails[key] = `${key}-${suffix()}@example.test`;
      const [u] = await migrator.query(
        `INSERT INTO users (email, full_name, password_hash, email_verified_at) VALUES ($1, $2, $3, now()) RETURNING id`,
        [emails[key], key, hash],
      );
      ids[key] = u.id;
      return u.id as string;
    };
    const [t] = await migrator.query(
      `INSERT INTO tenants (slug, name) VALUES ($1, 'Pa Foods') RETURNING id`,
      [`pa-${suffix()}`],
    );
    tenantId = t.id;
    const owner = await user('owner');
    const [m] = await migrator.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, status, joined_at) VALUES ($1, $2, 'active', now()) RETURNING id`,
      [t.id, owner],
    );
    await migrator.query(
      `INSERT INTO user_role_assignments (tenant_id, membership_id, role_id, scope_type)
       SELECT $1, $2, id, 'tenant' FROM roles WHERE tenant_id IS NULL AND code = 'owner'`,
      [t.id, m.id],
    );
    const admin = await user('admin');
    await migrator.query(
      `INSERT INTO platform_role_assignments (user_id, role_id) SELECT $1, id FROM roles WHERE tenant_id IS NULL AND code = 'super_admin'`,
      [admin],
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
    await migrator?.query(
      `UPDATE platform_settings SET signups_open = true, announcement = NULL, announcement_level = 'info', support_email = NULL, support_phone = NULL`,
    );
    await app?.close();
    if (migrator?.isInitialized) {
      await migrator.query(`DELETE FROM user_role_assignments WHERE tenant_id = $1`, [tenantId]);
      await migrator.query(`DELETE FROM platform_role_assignments WHERE user_id = $1`, [ids.admin]);
      await migrator.destroy();
    }
  });

  it('lists users only for the platform', async () => {
    await call('owner', 'get', '/platform/users').expect(403);
    const res = (
      await call(
        'admin',
        'get',
        `/platform/users?search=${encodeURIComponent(emails.owner!)}`,
      ).expect(200)
    ).body.data;
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({
      email: emails.owner,
      status: 'active',
      memberships: [expect.objectContaining({ tenant: 'Pa Foods' })],
    });
    const admins = (await call('admin', 'get', '/platform/users?kind=platform').expect(200)).body
      .data.rows;
    expect(admins.some((u: { id: string }) => u.id === ids.admin)).toBe(true);
  });

  it('disables a user (their session stops working at once) and enables them again', async () => {
    await call('admin', 'post', `/platform/users/${ids.admin}/disable`)
      .send({ reason: 'self test' })
      .expect(400);
    await call('admin', 'post', `/platform/users/${ids.owner}/disable`)
      .send({ reason: 'Fraud check' })
      .expect(204);
    await call('owner', 'get', '/account/profile').expect(401);
    await http()
      .post(`${API}/auth/login`)
      .set('X-Forwarded-For', freshIp())
      .send({ email: emails.owner, password: PASSWORD })
      .expect((r) => {
        if (r.status === 200) throw new Error('disabled user could sign in');
      });
    await call('admin', 'post', `/platform/users/${ids.owner}/enable`).expect(204);
    tokens.owner = (
      await http()
        .post(`${API}/auth/login`)
        .set('X-Forwarded-For', freshIp())
        .send({ email: emails.owner, password: PASSWORD })
        .expect(200)
    ).body.data.accessToken;
    const r = (
      await call('admin', 'post', `/platform/users/${ids.owner}/revoke-sessions`).expect(200)
    ).body.data;
    expect(r.revoked).toBeGreaterThanOrEqual(1);
    await call('owner', 'get', '/account/profile').expect(401);
  });

  it('pages the audit trail and filters by action', async () => {
    const page = (
      await call('admin', 'get', '/platform/audit-logs?action=platform.user').expect(200)
    ).body.data;
    const actions = page.rows.map((r: { action: string }) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(['platform.user_disabled', 'platform.user_enabled']),
    );
    expect(page.rows.every((r: { action: string }) => r.action.startsWith('platform.user'))).toBe(
      true,
    );
    const all = (await call('admin', 'get', '/platform/audit-logs').expect(200)).body.data;
    if (all.nextCursor) {
      const next = (
        await call(
          'admin',
          'get',
          `/platform/audit-logs?before=${encodeURIComponent(all.nextCursor)}`,
        ).expect(200)
      ).body.data;
      expect(next.rows[0].id).not.toBe(all.rows[0].id);
    }
    await call('admin', 'get', '/platform/audit-logs?before=garbage').expect(400);
  });

  it('pauses sign-ups and shows the announcement to restaurant users', async () => {
    const s = (await call('admin', 'get', '/platform/settings').expect(200)).body.data;
    expect(s.canManage).toBe(true);
    await call('admin', 'patch', '/platform/settings')
      .send({
        signupsOpen: false,
        announcement: 'Maintenance tonight 11pm',
        announcementLevel: 'warning',
        supportEmail: 'help@example.test',
      })
      .expect(204);
    await http()
      .post(`${API}/access-requests`)
      .set('X-Forwarded-For', freshIp())
      .set('X-Requested-With', 'XMLHttpRequest')
      .set('X-CSRF', '1')
      .send({
        restaurantName: 'New',
        contactName: 'Nia',
        email: `n-${suffix()}@example.test`,
        phone: '9876543210',
        city: 'Pune',
        branchCount: 1,
      })
      .expect((r) => {
        if (r.status !== 503 && r.status !== 403)
          throw new Error(`expected sign-up to be blocked, got ${r.status}`);
      });
    tokens.owner = (
      await http()
        .post(`${API}/auth/login`)
        .set('X-Forwarded-For', freshIp())
        .send({ email: emails.owner, password: PASSWORD })
        .expect(200)
    ).body.data.accessToken;
    const a = (await call('owner', 'get', '/announcement').expect(200)).body.data;
    expect(a).toMatchObject({
      message: 'Maintenance tonight 11pm',
      level: 'warning',
      supportEmail: 'help@example.test',
    });
    await call('owner', 'patch', '/platform/settings').send({ signupsOpen: true }).expect(403);
  });
});
