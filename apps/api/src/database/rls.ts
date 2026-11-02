import type { QueryRunner } from 'typeorm';

/** Session setting carrying the current tenant; set per transaction with `SET LOCAL`. */
export const TENANT_SETTING = 'app.tenant_id';

/**
 * Current tenant as uuid, or NULL when unset (rows then match nothing: fail closed).
 * NULLIF guards against '' which Postgres returns once the setting was used in the session.
 */
export const CURRENT_TENANT_SQL = `NULLIF(current_setting('${TENANT_SETTING}', true), '')::uuid`;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function quoteTable(table: string): string {
  const parts = table.split('.');
  if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part))) {
    throw new Error(`Invalid table name: ${table}`);
  }
  return parts.map((part) => `"${part}"`).join('.');
}

/** SQL statements that put a tenant table under row-level security. */
export function tenantIsolationSql(table: string): string[] {
  const t = quoteTable(table);
  return [
    `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY tenant_isolation ON ${t} USING (tenant_id = ${CURRENT_TENANT_SQL}) WITH CHECK (tenant_id = ${CURRENT_TENANT_SQL})`,
  ];
}

/** Reverse of `tenantIsolationSql`, for migration `down()`. */
export function dropTenantIsolationSql(table: string): string[] {
  const t = quoteTable(table);
  return [
    `DROP POLICY IF EXISTS tenant_isolation ON ${t}`,
    `ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`,
    `ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY`,
  ];
}

/** Call in a migration's `up()` right after creating a tenant-owned table. */
export async function enableTenantIsolation(queryRunner: QueryRunner, table: string) {
  for (const sql of tenantIsolationSql(table)) await queryRunner.query(sql);
}

export async function disableTenantIsolation(queryRunner: QueryRunner, table: string) {
  for (const sql of dropTenantIsolationSql(table)) await queryRunner.query(sql);
}

/** Scopes the current transaction to a tenant. Must run inside a transaction. */
export async function setTenantForTransaction(queryRunner: QueryRunner, tenantId: string) {
  await queryRunner.query(`SELECT set_config('${TENANT_SETTING}', $1, true)`, [tenantId]);
}
