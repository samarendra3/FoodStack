import {
  createTenantWorld,
  permissionId,
  systemRoleId,
  type TenantWorld,
} from '../support/fixtures';
import { inContext, openTestDatabase, PG, pgErrorCode, type TestDatabase } from '../support/db';

/**
 * Row-level security as seen by the runtime role (foodstack_app). Every query here goes through
 * the app pool with the same transaction-local settings the API will use.
 */
describe('tenant isolation (database layer)', () => {
  let db: TestDatabase;
  let a: TenantWorld;
  let b: TenantWorld;
  const ctxA = () => ({ tenantId: a.tenantId, userId: a.userId });

  beforeAll(async () => {
    db = openTestDatabase();
    a = await createTenantWorld(db.owner, 'alpha');
    b = await createTenantWorld(db.owner, 'bravo');
  });
  afterAll(() => db.close());

  const count = async (
    context: Parameters<typeof inContext>[1],
    sql: string,
    params: unknown[] = [],
  ) => inContext(db.app, context, async (c) => (await c.query(sql, params)).rowCount ?? 0);

  describe('without context', () => {
    it.each([
      'tenants',
      'restaurants',
      'branches',
      'tenant_memberships',
      'roles WHERE tenant_id IS NOT NULL',
      'user_role_assignments',
      'sessions',
      'refresh_tokens',
      'audit_logs',
      'platform_role_assignments',
    ])('sees no rows in %s', async (from) => {
      expect(await count({}, `SELECT 1 FROM ${from}`)).toBe(0);
    });
  });

  describe('tenant context', () => {
    it('sees only its own restaurants and branches', async () => {
      const ids = await inContext(db.app, ctxA(), async (c) => {
        const r = await c.query<{ id: string }>('SELECT id FROM restaurants');
        const br = await c.query<{ id: string }>('SELECT id FROM branches ORDER BY code');
        return { restaurants: r.rows.map((x) => x.id), branches: br.rows.map((x) => x.id) };
      });
      expect(ids.restaurants).toEqual([a.restaurantId]);
      expect(ids.branches.sort()).toEqual([a.branchId, a.otherBranchId].sort());
    });

    it('cannot read another tenant row by id', async () => {
      expect(await count(ctxA(), 'SELECT 1 FROM restaurants WHERE id = $1', [b.restaurantId])).toBe(
        0,
      );
      expect(await count(ctxA(), 'SELECT 1 FROM branches WHERE id = $1', [b.branchId])).toBe(0);
      expect(await count(ctxA(), 'SELECT 1 FROM tenants WHERE id = $1', [b.tenantId])).toBe(0);
    });

    it('cannot update or delete another tenant rows', async () => {
      expect(
        await count(ctxA(), "UPDATE restaurants SET name = 'pwned' WHERE id = $1", [
          b.restaurantId,
        ]),
      ).toBe(0);
      expect(await count(ctxA(), 'DELETE FROM branches WHERE id = $1', [b.otherBranchId])).toBe(0);
      const { rows } = await db.owner.query('SELECT name FROM restaurants WHERE id = $1', [
        b.restaurantId,
      ]);
      expect(rows[0].name).not.toBe('pwned');
    });

    it('cannot insert a row for another tenant', async () => {
      const code = await pgErrorCode(
        inContext(db.app, ctxA(), (c) =>
          c.query(
            `INSERT INTO restaurants (tenant_id, name, slug, currency_code, country_code, timezone)
             VALUES ($1, 'x', 'x-insert', 'INR', 'IN', 'UTC')`,
            [b.tenantId],
          ),
        ),
      );
      expect(code).toBe(PG.insufficientPrivilege);
    });

    it('cannot move its own row into another tenant', async () => {
      const code = await pgErrorCode(
        inContext(db.app, ctxA(), (c) =>
          c.query('UPDATE restaurants SET tenant_id = $1 WHERE id = $2', [
            b.tenantId,
            a.restaurantId,
          ]),
        ),
      );
      expect(code).toBe(PG.insufficientPrivilege);
    });

    it('cannot attach a branch to another tenant restaurant (composite FK)', async () => {
      const code = await pgErrorCode(
        inContext(db.app, ctxA(), (c) =>
          c.query(
            `INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone)
             VALUES ($1, $2, 'HIJACK', 'x', 'UTC')`,
            [a.tenantId, b.restaurantId],
          ),
        ),
      );
      expect(code).toBe(PG.foreignKeyViolation);
    });

    it('cannot delete a tenant', async () => {
      expect(await count(ctxA(), 'DELETE FROM tenants WHERE id = $1', [a.tenantId])).toBe(0);
    });

    it('can rename its tenant but not change its status', async () => {
      expect(
        await count(ctxA(), "UPDATE tenants SET name = 'Renamed' WHERE id = $1", [a.tenantId]),
      ).toBe(1);
      const code = await pgErrorCode(
        inContext(db.app, ctxA(), (c) =>
          c.query("UPDATE tenants SET status = 'active' WHERE id = $1", [a.tenantId]),
        ),
      );
      expect(code).toBe(PG.insufficientPrivilege);
    });
  });

  describe('memberships and tenants visible to a user', () => {
    it('lets a user see their own memberships and tenants before a tenant is chosen', async () => {
      const result = await inContext(db.app, { userId: a.userId }, async (c) => ({
        memberships: (await c.query('SELECT tenant_id FROM tenant_memberships')).rows,
        tenants: (await c.query('SELECT id FROM tenants')).rows,
      }));
      expect(result.memberships).toEqual([{ tenant_id: a.tenantId }]);
      expect(result.tenants).toEqual([{ id: a.tenantId }]);
    });

    it('does not let a user see other users memberships', async () => {
      expect(
        await count({ userId: a.userId }, 'SELECT 1 FROM tenant_memberships WHERE user_id = $1', [
          b.userId,
        ]),
      ).toBe(0);
    });
  });

  describe('roles and assignments', () => {
    it('sees system roles and its own custom roles only', async () => {
      const codes = await inContext(db.app, ctxA(), async (c) =>
        (
          await c.query<{ id: string }>('SELECT id FROM roles WHERE tenant_id IS NOT NULL')
        ).rows.map((r) => r.id),
      );
      expect(codes).toEqual([a.customRoleId]);
      expect(
        await count(ctxA(), "SELECT 1 FROM roles WHERE tenant_id IS NULL AND code = 'owner'"),
      ).toBe(1);
    });

    it('cannot modify a system role or its permissions', async () => {
      const owner = await systemRoleId(db.owner, 'owner');
      expect(await count(ctxA(), "UPDATE roles SET name = 'x' WHERE id = $1", [owner])).toBe(0);
      expect(await count(ctxA(), 'DELETE FROM role_permissions WHERE role_id = $1', [owner])).toBe(
        0,
      );
      const code = await pgErrorCode(
        inContext(db.app, ctxA(), async (c) =>
          c.query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)', [
            await systemRoleId(db.owner, 'waiter'),
            await permissionId(db.owner, 'role:manage'),
          ]),
        ),
      );
      expect(code).toBe(PG.insufficientPrivilege);
    });

    it('cannot create a platform-audience role', async () => {
      const code = await pgErrorCode(
        inContext(db.app, ctxA(), (c) =>
          c.query(
            "INSERT INTO roles (tenant_id, code, name, audience) VALUES ($1, 'sneaky', 'x', 'platform')",
            [a.tenantId],
          ),
        ),
      );
      // Rejected by the RLS write check or the roles_platform_global CHECK, whichever runs first.
      expect([PG.insufficientPrivilege, PG.checkViolation]).toContain(code);
    });

    it('cannot give a custom tenant role a platform permission', async () => {
      const code = await pgErrorCode(
        inContext(db.app, ctxA(), async (c) =>
          c.query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)', [
            a.customRoleId,
            await permissionId(db.owner, 'platform:tenants_manage'),
          ]),
        ),
      );
      expect(code).toBe(PG.checkViolation);
    });

    it('can assign a system role at its own branch', async () => {
      const waiter = await systemRoleId(db.owner, 'waiter');
      expect(
        await count(
          ctxA(),
          `INSERT INTO user_role_assignments (tenant_id, membership_id, role_id, scope_type, scope_id)
           VALUES ($1, $2, $3, 'branch', $4)`,
          [a.tenantId, a.membershipId, waiter, a.branchId],
        ),
      ).toBe(1);
    });

    it("cannot assign another tenant's custom role", async () => {
      const code = await pgErrorCode(
        inContext(db.app, ctxA(), (c) =>
          c.query(
            `INSERT INTO user_role_assignments (tenant_id, membership_id, role_id, scope_type)
             VALUES ($1, $2, $3, 'tenant')`,
            [a.tenantId, a.membershipId, b.customRoleId],
          ),
        ),
      );
      expect(code).toBe(PG.checkViolation);
    });

    it("cannot scope an assignment to another tenant's branch or restaurant", async () => {
      const waiter = await systemRoleId(db.owner, 'waiter');
      for (const [scopeType, scopeId] of [
        ['branch', b.branchId],
        ['restaurant', b.restaurantId],
      ] as const) {
        const code = await pgErrorCode(
          inContext(db.app, ctxA(), (c) =>
            c.query(
              `INSERT INTO user_role_assignments (tenant_id, membership_id, role_id, scope_type, scope_id)
               VALUES ($1, $2, $3, $4, $5)`,
              [a.tenantId, a.membershipId, waiter, scopeType, scopeId],
            ),
          ),
        );
        expect(code).toBe(PG.foreignKeyViolation);
      }
    });

    it('cannot assign a platform role as a tenant role, or any platform role from a tenant', async () => {
      const superAdmin = await systemRoleId(db.owner, 'super_admin');
      const tenantAssign = await pgErrorCode(
        inContext(db.app, ctxA(), (c) =>
          c.query(
            `INSERT INTO user_role_assignments (tenant_id, membership_id, role_id, scope_type)
             VALUES ($1, $2, $3, 'tenant')`,
            [a.tenantId, a.membershipId, superAdmin],
          ),
        ),
      );
      expect(tenantAssign).toBe(PG.checkViolation);
      const platformAssign = await pgErrorCode(
        inContext(db.app, ctxA(), (c) =>
          c.query('INSERT INTO platform_role_assignments (user_id, role_id) VALUES ($1, $2)', [
            a.userId,
            superAdmin,
          ]),
        ),
      );
      expect(platformAssign).toBe(PG.insufficientPrivilege);
    });
  });

  describe('sessions and refresh tokens', () => {
    it('lets a user see only their own sessions', async () => {
      const ids = await inContext(db.app, { userId: a.userId }, async (c) =>
        (await c.query<{ id: string }>('SELECT id FROM sessions')).rows.map((r) => r.id),
      );
      expect(ids).toEqual([a.sessionId]);
    });

    it('resolves a session by app.session_id alone (refresh), and nothing else', async () => {
      const ids = await inContext(db.app, { sessionId: b.sessionId }, async (c) =>
        (await c.query<{ id: string }>('SELECT id FROM sessions')).rows.map((r) => r.id),
      );
      expect(ids).toEqual([b.sessionId]);
    });

    it('hides refresh tokens of sessions the caller cannot see', async () => {
      await db.owner.query(
        `INSERT INTO refresh_tokens (session_id, token_hash, expires_at)
         VALUES ($1, decode(repeat('ab', 32), 'hex'), now() + interval '1 day')`,
        [b.sessionId],
      );
      expect(await count({ userId: a.userId }, 'SELECT 1 FROM refresh_tokens')).toBe(0);
      expect(await count({ sessionId: b.sessionId }, 'SELECT 1 FROM refresh_tokens')).toBe(1);
    });
  });

  describe('audit logs', () => {
    it('accepts events for the current tenant and rejects events for another', async () => {
      expect(
        await count(
          ctxA(),
          "INSERT INTO audit_logs (tenant_id, action) VALUES ($1, 'test.event')",
          [a.tenantId],
        ),
      ).toBe(1);
      const code = await pgErrorCode(
        inContext(db.app, ctxA(), (c) =>
          c.query("INSERT INTO audit_logs (tenant_id, action) VALUES ($1, 'test.event')", [
            b.tenantId,
          ]),
        ),
      );
      expect(code).toBe(PG.insufficientPrivilege);
    });

    it('is append-only for the app role and for the owner', async () => {
      const { rows } = await db.owner.query<{ id: string }>(
        "INSERT INTO audit_logs (tenant_id, action) VALUES ($1, 'test.kept') RETURNING id",
        [a.tenantId],
      );
      const id = rows[0]!.id;
      for (const sql of [
        "UPDATE audit_logs SET action = 'test.changed' WHERE id = $1",
        'DELETE FROM audit_logs WHERE id = $1',
      ]) {
        expect(await pgErrorCode(inContext(db.app, ctxA(), (c) => c.query(sql, [id])))).toBe(
          PG.insufficientPrivilege,
        );
        expect(await pgErrorCode(db.owner.query(sql, [id]))).toBe(PG.insufficientPrivilege);
      }
      expect(await pgErrorCode(db.owner.query('TRUNCATE audit_logs'))).toBe(
        PG.insufficientPrivilege,
      );
    });

    it('shows a tenant only its own events', async () => {
      await db.owner.query("INSERT INTO audit_logs (tenant_id, action) VALUES ($1, 'test.other')", [
        b.tenantId,
      ]);
      expect(
        await count(ctxA(), 'SELECT 1 FROM audit_logs WHERE tenant_id <> $1', [a.tenantId]),
      ).toBe(0);
    });
  });

  describe('platform context', () => {
    it('can read all tenants and change tenant status', async () => {
      const visible = await count({ platform: true }, 'SELECT 1 FROM tenants WHERE id = ANY($1)', [
        [a.tenantId, b.tenantId],
      ]);
      expect(visible).toBe(2);
      expect(
        await count({ platform: true }, "UPDATE tenants SET status = 'suspended' WHERE id = $1", [
          b.tenantId,
        ]),
      ).toBe(1);
    });

    it('cannot read tenant business tables (no impersonation in Phase 3)', async () => {
      expect(await count({ platform: true }, 'SELECT 1 FROM restaurants')).toBe(0);
      expect(await count({ platform: true }, 'SELECT 1 FROM branches')).toBe(0);
    });
  });
});
