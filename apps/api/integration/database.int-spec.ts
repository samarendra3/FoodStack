import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { rlsBypassReasons, type RoleAttributes } from '../src/database/database-role.check';
import { disableTenantIsolation, enableTenantIsolation } from '../src/database/rls';
import { asTenant, connect, loadMigrations, testEnv } from './helpers';

const PROBE = 'it_rls_probe';
const tenantA = randomUUID();
const tenantB = randomUUID();

describe('PostgreSQL (integration)', () => {
  let migrator: DataSource;
  let app: DataSource;

  beforeAll(async () => {
    expect(testEnv().DATABASE_MIGRATION_USER).toBeDefined();
    migrator = await connect('migration');
    await migrator.runMigrations({ transaction: 'each' });
    // One pooled connection, so every query below reuses the same session: proves
    // SET LOCAL does not leak from one transaction into the next.
    app = await connect('app', { poolMax: 1 });
  });

  afterAll(async () => {
    await migrator?.query(`DROP TABLE IF EXISTS "${PROBE}"`);
    await app?.destroy();
    await migrator?.destroy();
  });

  describe('migrations', () => {
    it('apply, fully revert and re-apply cleanly', async () => {
      const total = loadMigrations().length;
      for (let i = 0; i < total; i += 1) await migrator.undoLastMigration({ transaction: 'each' });
      expect(await migrator.showMigrations()).toBe(true); // pending again

      await migrator.runMigrations({ transaction: 'each' });
      expect(await migrator.showMigrations()).toBe(false);
      const extensions: { extname: string }[] = await migrator.query(
        `SELECT extname FROM pg_extension WHERE extname IN ('citext', 'pg_trgm') ORDER BY 1`,
      );
      expect(extensions.map((e) => e.extname)).toEqual(['citext', 'pg_trgm']);
    });
  });

  describe('roles', () => {
    it('connects the API as a role that cannot bypass row-level security', async () => {
      const [role] = (await app.query(
        'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      )) as RoleAttributes[];
      expect(role!.rolname).toBe(testEnv().DATABASE_USER);
      expect(rlsBypassReasons(role!)).toEqual([]);
    });

    it('does not let the API role change the schema', async () => {
      await expect(app.query('CREATE TABLE it_should_not_exist (id int)')).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  describe('tenant isolation (RLS)', () => {
    beforeAll(async () => {
      await migrator.query(`DROP TABLE IF EXISTS "${PROBE}"`);
      await migrator.query(`CREATE TABLE "${PROBE}" (
        "id" uuid PRIMARY KEY DEFAULT uuidv7(),
        "tenant_id" uuid NOT NULL,
        "note" text NOT NULL
      )`);
      const runner = migrator.createQueryRunner();
      try {
        await enableTenantIsolation(runner, PROBE);
      } finally {
        await runner.release();
      }
      // Rows are written through the API role, the way the application will write them.
      await asTenant(app, tenantA, (m) =>
        m.query(`INSERT INTO "${PROBE}" (tenant_id, note) VALUES ($1, 'a1'), ($1, 'a2')`, [
          tenantA,
        ]),
      );
      await asTenant(app, tenantB, (m) =>
        m.query(`INSERT INTO "${PROBE}" (tenant_id, note) VALUES ($1, 'b1')`, [tenantB]),
      );
    });

    it("returns only the current tenant's rows", async () => {
      const rows: { tenant_id: string }[] = await asTenant(app, tenantA, (m) =>
        m.query(`SELECT tenant_id FROM "${PROBE}"`),
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.tenant_id === tenantA)).toBe(true);
    });

    it('returns nothing when no tenant is set, even right after a scoped transaction', async () => {
      await asTenant(app, tenantB, (m) => m.query(`SELECT 1 FROM "${PROBE}"`));
      expect(await app.query(`SELECT * FROM "${PROBE}"`)).toEqual([]);
    });

    it('rejects writing or moving rows into another tenant', async () => {
      await expect(
        asTenant(app, tenantA, (m) =>
          m.query(`INSERT INTO "${PROBE}" (tenant_id, note) VALUES ($1, 'x')`, [tenantB]),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        asTenant(app, tenantA, (m) => m.query(`UPDATE "${PROBE}" SET tenant_id = $1`, [tenantB])),
      ).rejects.toThrow(/row-level security/);
    });

    it("cannot delete another tenant's rows", async () => {
      await asTenant(app, tenantA, (m) =>
        m.query(`DELETE FROM "${PROBE}" WHERE tenant_id = $1`, [tenantB]),
      );
      const remaining = await asTenant(app, tenantB, (m) => m.query(`SELECT 1 FROM "${PROBE}"`));
      expect(remaining).toHaveLength(1);
    });

    it('generates UUIDv7 primary keys in the database', async () => {
      const [row] = await asTenant(app, tenantA, (m) =>
        m.query(`SELECT id FROM "${PROBE}" LIMIT 1`),
      );
      expect(row.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it('can be removed again by the migration helper', async () => {
      const runner = migrator.createQueryRunner();
      try {
        await disableTenantIsolation(runner, PROBE);
      } finally {
        await runner.release();
      }
      const [table] = await migrator.query(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
        [PROBE],
      );
      expect(table).toEqual({ relrowsecurity: false, relforcerowsecurity: false });
    });
  });
});
