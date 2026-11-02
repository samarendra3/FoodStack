import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_MIGRATIONS } from '../../src/database/migration-list';
import { openTestDatabase, type TestDatabase } from '../support/db';

/**
 * Structural guarantees that must hold for every table, now and when later modules add tables
 * (docs/phase-3-design.md §2.2 "CI guard"). A new table fails here until it either has RLS or
 * is deliberately added to NON_TENANT_TABLES.
 */
const NON_TENANT_TABLES = [
  'access_requests',
  'login_attempts',
  'mfa_recovery_codes',
  'permissions',
  'typeorm_migrations',
  'user_tokens',
  'users',
];

describe('database structure', () => {
  let db: TestDatabase;

  beforeAll(() => {
    db = openTestDatabase();
  });
  afterAll(() => db.close());

  it('enables and forces RLS, with at least one policy, on every table with tenant_id', async () => {
    const { rows } = await db.owner.query<{
      table: string;
      rls: boolean;
      force: boolean;
      policies: number;
    }>(`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
             (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
      FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
        AND EXISTS (SELECT 1 FROM information_schema.columns col
                    WHERE col.table_schema = 'public' AND col.table_name = c.relname
                      AND col.column_name = 'tenant_id')
      ORDER BY 1
    `);
    expect(rows.length).toBeGreaterThan(0);
    const weak = rows.filter((r) => !r.rls || !r.force || r.policies === 0).map((r) => r.table);
    expect(weak).toEqual([]);
  });

  it('allows tables without RLS only from the explicit allow-list', async () => {
    const { rows } = await db.owner.query<{ table: string }>(`
      SELECT relname AS table FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND NOT relrowsecurity
      ORDER BY 1
    `);
    expect(rows.map((r) => r.table)).toEqual(NON_TENANT_TABLES);
  });

  it('gives the app role no superuser, no RLS bypass and no table ownership', async () => {
    const { rows } = await db.owner.query<{ super: boolean; bypass: boolean; owned: number }>(`
      SELECT r.rolsuper AS super, r.rolbypassrls AS bypass,
             (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid
                AND c.relnamespace = 'public'::regnamespace) AS owned
      FROM pg_roles r WHERE r.rolname = 'foodstack_app'
    `);
    expect(rows).toEqual([{ super: false, bypass: false, owned: 0 }]);
  });

  it.each([
    ['audit_logs', 'INSERT', true],
    ['audit_logs', 'SELECT', true],
    ['audit_logs', 'UPDATE', false],
    ['audit_logs', 'DELETE', false],
    ['audit_logs', 'TRUNCATE', false],
    ['login_attempts', 'INSERT', true],
    ['login_attempts', 'UPDATE', false],
    ['login_attempts', 'DELETE', false],
    ['permissions', 'SELECT', true],
    ['permissions', 'INSERT', false],
    ['permissions', 'UPDATE', false],
    ['typeorm_migrations', 'SELECT', false],
    ['access_requests', 'INSERT', true],
    ['access_requests', 'DELETE', false],
    ['tenants', 'DELETE', true], // granted, but no DELETE policy exists (checked in isolation tests)
  ])('app role privilege on %s %s is %s', async (table, privilege, expected) => {
    const { rows } = await db.owner.query<{ ok: boolean }>(
      'SELECT has_table_privilege($1, $2, $3) AS ok',
      ['foodstack_app', `public.${table}`, privilege],
    );
    expect(rows[0]!.ok).toBe(expected);
  });

  it('cannot create objects as the app role', async () => {
    const { rows } = await db.owner.query<{ ok: boolean }>(
      "SELECT has_schema_privilege('foodstack_app', 'public', 'CREATE') AS ok",
    );
    expect(rows[0]!.ok).toBe(false);
  });

  it('lists every migration file in migration-list.ts', () => {
    const files = readdirSync(join(__dirname, '../../src/database/migrations'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.replace(/\.ts$/, ''));
    const listed = ALL_MIGRATIONS.map((m) => {
      const name = m.name; // class name, e.g. Identity1798000003000
      const timestamp = name.match(/(\d{13})$/)![1];
      return `${timestamp}-${name.replace(/\d{13}$/, '')}`;
    });
    expect(listed).toEqual(files.sort());
  });
});
