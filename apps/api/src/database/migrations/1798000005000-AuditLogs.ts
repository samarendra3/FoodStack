import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Append-only audit log (docs/phase-3-design.md §2.1, §6.7).
 *
 * Enforced twice: the app role has no UPDATE/DELETE/TRUNCATE privilege, and triggers reject
 * those statements for every role, including the owner. tenant_id NULL marks a platform event
 * (or a pre-tenant event such as a failed login for an unknown account).
 */
export class AuditLogs1798000005000 implements MigrationInterface {
  name = 'AuditLogs1798000005000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE audit_logs (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid REFERENCES tenants (id),
        actor_user_id uuid REFERENCES users (id),
        actor_session_id uuid,
        actor_audience text,
        action text NOT NULL,
        entity_type text,
        entity_id uuid,
        branch_id uuid,
        before jsonb,
        after jsonb,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        ip inet,
        user_agent text,
        request_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT audit_logs_action_format CHECK (action ~ '^[a-z_]+(\\.[a-z_]+)+$'),
        CONSTRAINT audit_logs_actor_audience_check CHECK (actor_audience IN ('tenant', 'platform', 'system')),
        CONSTRAINT audit_logs_user_agent_length CHECK (char_length(user_agent) <= 512)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX audit_logs_entity_idx ON audit_logs (tenant_id, entity_type, entity_id)',
    );
    await queryRunner.query(
      'CREATE INDEX audit_logs_tenant_time_idx ON audit_logs (tenant_id, created_at DESC)',
    );
    await queryRunner.query(
      'CREATE INDEX audit_logs_created_brin ON audit_logs USING brin (created_at)',
    );

    await queryRunner.query('REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM foodstack_app');
    await queryRunner.query(`
      CREATE FUNCTION audit_logs_append_only() RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RAISE EXCEPTION 'audit_logs is append-only (% rejected)', TG_OP
            USING ERRCODE = 'insufficient_privilege';
        END $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER audit_logs_no_update_delete BEFORE UPDATE OR DELETE ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only()
    `);
    await queryRunner.query(`
      CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
        FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_append_only()
    `);

    await queryRunner.query('ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY');
    await queryRunner.query('ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY');
    // Tenants read their own events; the platform reads everything.
    await queryRunner.query(`
      CREATE POLICY audit_logs_select ON audit_logs FOR SELECT
        USING (tenant_id = app_current_tenant() OR app_is_platform())
    `);
    // Writes: into the current tenant, or tenant-less (platform / pre-tenant) events.
    await queryRunner.query(`
      CREATE POLICY audit_logs_insert ON audit_logs FOR INSERT
        WITH CHECK (tenant_id IS NULL OR tenant_id = app_current_tenant())
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Row and TRUNCATE triggers do not fire on DROP TABLE, so reverting stays possible.
    await queryRunner.query('DROP TABLE audit_logs');
    await queryRunner.query('DROP FUNCTION audit_logs_append_only()');
  }
}
