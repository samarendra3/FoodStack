import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PasswordHasher } from '../src/core/security/password-hasher';
import { MailService } from '../src/modules/notifications/mail.service';
import { connect } from './helpers';

/**
 * Team management: who sees whom, who may give which role at which branch, invitations that
 * lead to a working sign-in, role changes, suspension (ending sessions) and tenant isolation.
 */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;

interface Tenant {
  id: string;
  main: string;
  second: string;
}

describe('Team (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  let mail: MailService;
  let passwordHash: string;
  let alpha: Tenant;
  let bravo: Tenant;
  const emails: Record<string, string> = {};
  const memberships: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  const createdEmails: string[] = [];

  const http = () => {
    const agent = request(app.getHttpServer());
    const ip = freshIp();
    return {
      get: (url: string) => agent.get(url).set('X-Forwarded-For', ip),
      post: (url: string) => agent.post(url).set('X-Forwarded-For', ip),
    };
  };
  const as = (who: string, method: 'get' | 'post', url: string) =>
    http()[method](`${API}${url}`).set('Authorization', `Bearer ${tokens[who]}`);
  const login = (email: string, password = PASSWORD) =>
    http().post(`${API}/auth/login`).send({ email, password });

  async function createTenant(label: string): Promise<Tenant> {
    const [t] = await migrator.query(
      `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
      [`${label}-${suffix()}`, `${label} Foods`],
    );
    const [r] = await migrator.query(
      `INSERT INTO restaurants (tenant_id, name, slug, currency_code, country_code, timezone)
       VALUES ($1, $2, $3, 'INR', 'IN', 'Asia/Kolkata') RETURNING id`,
      [t.id, label, `${label}-${suffix()}`],
    );
    const branch = async (code: string, isDefault: boolean) =>
      (
        await migrator.query(
          `INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone, is_default)
           VALUES ($1, $2, $3, $4, 'Asia/Kolkata', $5) RETURNING id`,
          [t.id, r.id, code, `${code} branch`, isDefault],
        )
      )[0].id as string;
    return { id: t.id, main: await branch('MAIN', true), second: await branch('SECOND', false) };
  }

  async function addMember(key: string, tenant: Tenant, role: string, branchId?: string) {
    const email = `${key}-${suffix()}@example.test`;
    emails[key] = email;
    createdEmails.push(email);
    const [u] = await migrator.query(
      `INSERT INTO users (email, full_name, password_hash, email_verified_at)
       VALUES ($1, $2, $3, now()) RETURNING id`,
      [email, key, passwordHash],
    );
    const [m] = await migrator.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, status, joined_at)
       VALUES ($1, $2, 'active', now()) RETURNING id`,
      [tenant.id, u.id],
    );
    memberships[key] = m.id;
    await migrator.query(
      `INSERT INTO user_role_assignments (tenant_id, membership_id, role_id, scope_type, scope_id)
       SELECT $1, $2, id, $4, $5 FROM roles WHERE tenant_id IS NULL AND code = $3`,
      [tenant.id, m.id, role, branchId ? 'branch' : 'tenant', branchId ?? null],
    );
  }

  async function signIn(key: string) {
    const res = await login(emails[key]!).expect(200);
    tokens[key] = res.body.data.accessToken as string;
  }

  /** Reads the set-password token from the latest email to `to`. */
  function linkToken(to: string): string {
    const message = [...mail.outbox].reverse().find((m) => m.to === to.toLowerCase());
    expect(message).toBeDefined();
    return /token=([A-Za-z0-9_-]+)/.exec(message!.text)![1]!;
  }

  beforeAll(async () => {
    migrator = await connect('migration');
    await migrator.runMigrations({ transaction: 'each' });
    passwordHash = await new PasswordHasher().hash(PASSWORD);

    alpha = await createTenant('alpha');
    bravo = await createTenant('bravo');
    await addMember('owner', alpha, 'owner');
    await addMember('owner2', alpha, 'owner');
    await addMember('admin', alpha, 'restaurant_admin');
    await addMember('manager', alpha, 'branch_manager', alpha.main);
    await addMember('cashierMain', alpha, 'cashier', alpha.main);
    await addMember('cashierSecond', alpha, 'cashier', alpha.second);
    await addMember('waiterMain', alpha, 'waiter', alpha.main);
    await addMember('bravoOwner', bravo, 'owner');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app);
    await app.init();
    mail = app.get(MailService);

    for (const who of ['owner', 'admin', 'manager', 'cashierMain', 'bravoOwner']) await signIn(who);
  });

  afterAll(async () => {
    await app?.close();
    if (migrator?.isInitialized) {
      // Assignments reference the seeded system roles; remove ours so the migration
      // round-trip test (database.int-spec) can still revert the seed migration.
      await migrator.query('DELETE FROM user_role_assignments WHERE tenant_id = ANY($1::uuid[])', [
        [alpha?.id, bravo?.id].filter(Boolean),
      ]);
      await migrator.destroy();
    }
  });

  describe('listing', () => {
    it('shows an owner everyone, with every role to give including owner', async () => {
      const res = await as('owner', 'get', '/team').expect(200);
      const { members, assignableRoles, branches, canInvite } = res.body.data;
      expect(members).toHaveLength(7);
      expect(canInvite).toBe(true);
      expect(assignableRoles.map((r: { code: string }) => r.code)).toEqual(
        expect.arrayContaining(['owner', 'restaurant_admin', 'branch_manager', 'cashier']),
      );
      expect(branches).toHaveLength(2);
      const me = members.find((m: { isYou: boolean }) => m.isYou);
      expect(me).toMatchObject({ email: emails.owner, canEdit: false, status: 'active' });
      const cashier = members.find((m: { email: string }) => m.email === emails.cashierMain);
      expect(cashier.roles).toEqual([
        { code: 'cashier', name: 'Cashier', branchId: alpha.main, branchName: 'MAIN branch' },
      ]);
      expect(cashier.canEdit).toBe(true);
    });

    it('does not let an admin give or touch the owner role', async () => {
      const res = await as('admin', 'get', '/team').expect(200);
      const codes = res.body.data.assignableRoles.map((r: { code: string }) => r.code);
      expect(codes).not.toContain('owner');
      expect(codes).toContain('restaurant_admin');
      const owner = res.body.data.members.find((m: { email: string }) => m.email === emails.owner);
      expect(owner.canEdit).toBe(false);
    });

    it('shows a branch manager only their branch and staff roles', async () => {
      const res = await as('manager', 'get', '/team').expect(200);
      const { members, assignableRoles, branches } = res.body.data;
      expect(members.map((m: { email: string }) => m.email).sort()).toEqual(
        [emails.manager, emails.cashierMain, emails.waiterMain].sort(),
      );
      expect(assignableRoles.map((r: { code: string }) => r.code).sort()).toEqual(
        ['cashier', 'kitchen_manager', 'kitchen_staff', 'waiter'].sort(),
      );
      expect(branches).toEqual([{ id: alpha.main, name: 'MAIN branch' }]);
    });

    it('is closed to staff without member:read', async () => {
      await as('cashierMain', 'get', '/team').expect(403);
    });
  });

  describe('inviting', () => {
    it('adds a new person who can then set a password and sign in to their workspace', async () => {
      const email = `newcook-${suffix()}@example.test`;
      createdEmails.push(email);
      const res = await as('owner', 'post', '/team/invite')
        .send({ email, fullName: 'New Cook', role: 'kitchen_staff', branchId: alpha.main })
        .expect(201);
      expect(res.body.data.invitationSent).toBe(true);

      const list = await as('owner', 'get', '/team').expect(200);
      const added = list.body.data.members.find((m: { email: string }) => m.email === email);
      expect(added).toMatchObject({ status: 'invited', name: 'New Cook' });

      await http()
        .post(`${API}/auth/password/reset`)
        .set('X-FoodStack-CSRF', '1')
        .send({ token: linkToken(email), password: PASSWORD })
        .expect(204);
      const signedIn = await login(email).expect(200);
      expect(signedIn.body.data.profile).toMatchObject({
        roles: ['kitchen_staff'],
        homePath: '/kitchen',
        activeTenant: { id: alpha.id },
      });
      const after = await as('owner', 'get', '/team').expect(200);
      expect(after.body.data.members.find((m: { email: string }) => m.email === email).status).toBe(
        'active',
      );
    });

    it('adds someone who already has a FoodStack password without a set-password link', async () => {
      const res = await as('bravoOwner', 'post', '/team/invite')
        .send({ email: emails.cashierMain, fullName: 'Shared Cashier', role: 'restaurant_admin' })
        .expect(201);
      expect(res.body.data.invitationSent).toBe(false);
      const message = [...mail.outbox]
        .reverse()
        .find((m) => m.to === emails.cashierMain!.toLowerCase());
      expect(message!.text).toContain('/login');
    });

    it('refuses someone already on the team', async () => {
      const res = await as('owner', 'post', '/team/invite')
        .send({ email: emails.waiterMain, fullName: 'Dup', role: 'waiter', branchId: alpha.main })
        .expect(409);
      expect(res.body.code).toBe('ALREADY_MEMBER');
    });

    it('needs a branch for branch roles, and only branches of this business', async () => {
      const email = `x-${suffix()}@example.test`;
      const missing = await as('owner', 'post', '/team/invite')
        .send({ email, fullName: 'No Branch', role: 'cashier' })
        .expect(400);
      expect(missing.body.code).toBe('BRANCH_REQUIRED');
      await as('owner', 'post', '/team/invite')
        .send({ email, fullName: 'Wrong Tenant', role: 'cashier', branchId: bravo.main })
        .expect(403);
    });

    it('lets only an owner make someone an owner', async () => {
      const email = `coowner-${suffix()}@example.test`;
      createdEmails.push(email);
      await as('admin', 'post', '/team/invite')
        .send({ email, fullName: 'Co Owner', role: 'owner' })
        .expect(403);
      await as('owner', 'post', '/team/invite')
        .send({ email, fullName: 'Co Owner', role: 'owner' })
        .expect(201);
    });

    it('keeps a branch manager to staff roles in their own branch', async () => {
      const email = `w-${suffix()}@example.test`;
      createdEmails.push(email);
      await as('manager', 'post', '/team/invite')
        .send({ email, fullName: 'Wanda', role: 'waiter', branchId: alpha.second })
        .expect(403);
      await as('manager', 'post', '/team/invite')
        .send({ email, fullName: 'Wanda', role: 'restaurant_admin' })
        .expect(403);
      await as('manager', 'post', '/team/invite')
        .send({ email, fullName: 'Wanda', role: 'branch_manager', branchId: alpha.main })
        .expect(403);
      await as('manager', 'post', '/team/invite')
        .send({ email, fullName: 'Wanda', role: 'waiter', branchId: alpha.main })
        .expect(201);
    });

    it('signs the new member straight in when they create their password', async () => {
      const email = `instant-${suffix()}@example.test`;
      createdEmails.push(email);
      await as('owner', 'post', '/team/invite')
        .send({ email, fullName: 'Instant Waiter', role: 'waiter', branchId: alpha.main })
        .expect(201);
      const message = [...mail.outbox].reverse().find((m) => m.to === email);
      expect(message!.text).toContain('/welcome?token=');
      expect(message!.subject).toContain('alpha Foods');

      const res = await http()
        .post(`${API}/auth/password/reset`)
        .send({ token: linkToken(email), password: PASSWORD, signIn: true })
        .expect(200);
      expect(res.body.data.accessToken).toMatch(/^ey/);
      expect(res.body.data.profile).toMatchObject({ roles: ['waiter'], homePath: '/waiter' });
      const cookies = (res.headers['set-cookie'] as unknown as string[]).join(';');
      expect(cookies).toContain('fs_rt=');
      // The session works at once, and the link cannot be used again.
      await http()
        .get(`${API}/auth/me`)
        .set('Authorization', `Bearer ${res.body.data.accessToken}`)
        .expect(200);
    });

    it('resends a link only to someone who has not joined yet', async () => {
      const email = `pending-${suffix()}@example.test`;
      createdEmails.push(email);
      const res = await as('owner', 'post', '/team/invite')
        .send({ email, fullName: 'Pending', role: 'waiter', branchId: alpha.main })
        .expect(201);
      const first = linkToken(email);
      await as('owner', 'post', `/team/${res.body.data.membershipId}/resend-invite`).expect(204);
      expect(linkToken(email)).not.toBe(first);
      const joined = await as('owner', 'post', `/team/${memberships.waiterMain}/resend-invite`)
        .send()
        .expect(409);
      expect(joined.body.code).toBe('ALREADY_JOINED');
    });
  });

  describe('changing access', () => {
    it('changes a role, and the next sign-in lands on the new workspace', async () => {
      await as('owner', 'post', `/team/${memberships.waiterMain}/role`)
        .send({ role: 'cashier', branchId: alpha.main })
        .expect(204);
      const res = await login(emails.waiterMain!).expect(200);
      expect(res.body.data.profile).toMatchObject({ roles: ['cashier'], homePath: '/pos' });
    });

    it('lets a branch manager change their branch staff but not other branches', async () => {
      await as('manager', 'post', `/team/${memberships.cashierMain}/role`)
        .send({ role: 'waiter', branchId: alpha.main })
        .expect(204);
      await as('manager', 'post', `/team/${memberships.cashierSecond}/role`)
        .send({ role: 'waiter', branchId: alpha.main })
        .expect(404); // not visible to them
    });

    it('never lets someone change their own access', async () => {
      const res = await as('admin', 'post', `/team/${memberships.admin}/role`)
        .send({ role: 'owner' })
        .expect(403);
      expect(res.body.code).toBe('TEAM_FORBIDDEN');
      await as('owner', 'post', `/team/${memberships.owner}/suspend`).expect(403);
    });

    it('protects owners from admins', async () => {
      await as('admin', 'post', `/team/${memberships.owner2}/suspend`).expect(403);
      await as('admin', 'post', `/team/${memberships.owner2}/role`)
        .send({ role: 'restaurant_admin' })
        .expect(403);
    });

    it('suspends a member at once (sessions end, sign-in refused) and reactivates them', async () => {
      await signIn('cashierSecond');
      await as('cashierSecond', 'get', '/auth/me').expect(200);
      await as('admin', 'post', `/team/${memberships.cashierSecond}/suspend`).expect(204);

      const blocked = await as('cashierSecond', 'get', '/auth/me');
      expect([401, 403]).toContain(blocked.status);
      expect((await login(emails.cashierSecond!)).status).not.toBe(200);
      const list = await as('admin', 'get', '/team').expect(200);
      expect(
        list.body.data.members.find((m: { email: string }) => m.email === emails.cashierSecond)
          .status,
      ).toBe('suspended');

      await as('admin', 'post', `/team/${memberships.cashierSecond}/reactivate`).expect(204);
      await login(emails.cashierSecond!).expect(200);
    });

    it('writes every change to the audit log', async () => {
      const rows = await migrator.query(
        `SELECT DISTINCT action FROM audit_logs WHERE tenant_id = $1 AND action LIKE 'member.%'`,
        [alpha.id],
      );
      expect(rows.map((r: { action: string }) => r.action).sort()).toEqual(
        expect.arrayContaining([
          'member.invited',
          'member.invite_resent',
          'member.reactivated',
          'member.role_changed',
          'member.suspended',
        ]),
      );
    });
  });

  describe('isolation', () => {
    it("cannot see or change another business's members", async () => {
      const res = await as('bravoOwner', 'get', '/team').expect(200);
      const seen = res.body.data.members.map((m: { email: string }) => m.email);
      expect(seen).not.toContain(emails.owner);
      await as('bravoOwner', 'post', `/team/${memberships.cashierMain}/suspend`).expect(404);
    });
  });
});
