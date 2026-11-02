import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Privileges for the runtime role `foodstack_app` (docs/phase-3-design.md §1).
 * The role itself is created outside migrations (infrastructure/docker/postgres/init/02-app-role.sh)
 * because it carries a password. Tables created by later migrations inherit these defaults;
 * tables that must be append-only or read-only revoke the extra privileges explicitly.
 *
 * Also adds the helpers every row-level security policy uses. A missing setting yields NULL,
 * which matches no rows, so a query without tenant context fails closed.
 */
export class AppRoleGrants1798000001000 implements MigrationInterface {
  name = 'AppRoleGrants1798000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'foodstack_app') THEN
          RAISE EXCEPTION 'Role foodstack_app does not exist. Run infrastructure/docker/postgres/init/02-app-role.sh first.';
        END IF;
      END $$
    `);
    await queryRunner.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await queryRunner.query('GRANT USAGE ON SCHEMA public TO foodstack_app');
    await queryRunner.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO foodstack_app
    `);
    await queryRunner.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT USAGE, SELECT ON SEQUENCES TO foodstack_app
    `);

    // Request context, set per transaction with SET LOCAL (see TenantTransaction).
    await queryRunner.query(`
      CREATE FUNCTION app_current_tenant() RETURNS uuid
        LANGUAGE sql STABLE PARALLEL SAFE
        AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$
    `);
    await queryRunner.query(`
      CREATE FUNCTION app_current_user() RETURNS uuid
        LANGUAGE sql STABLE PARALLEL SAFE
        AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$
    `);
    await queryRunner.query(`
      CREATE FUNCTION app_current_session() RETURNS uuid
        LANGUAGE sql STABLE PARALLEL SAFE
        AS $$ SELECT NULLIF(current_setting('app.session_id', true), '')::uuid $$
    `);
    await queryRunner.query(`
      CREATE FUNCTION app_is_platform() RETURNS boolean
        LANGUAGE sql STABLE PARALLEL SAFE
        AS $$ SELECT coalesce(current_setting('app.platform', true), '') = 'on' $$
    `);

    // Shared trigger for updated_at / version bookkeeping.
    await queryRunner.query(`
      CREATE FUNCTION set_updated_at() RETURNS trigger
        LANGUAGE plpgsql
        AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP FUNCTION set_updated_at()');
    await queryRunner.query('DROP FUNCTION app_is_platform()');
    await queryRunner.query('DROP FUNCTION app_current_session()');
    await queryRunner.query('DROP FUNCTION app_current_user()');
    await queryRunner.query('DROP FUNCTION app_current_tenant()');
    await queryRunner.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        REVOKE USAGE, SELECT ON SEQUENCES FROM foodstack_app
    `);
    await queryRunner.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM foodstack_app
    `);
    await queryRunner.query('REVOKE USAGE ON SCHEMA public FROM foodstack_app');
  }
}
