import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RBAC (docs/phase-3-design.md §2.1, §3): permission catalogue, roles, role permissions,
 * tenant role assignments with scope, and platform role assignments.
 *
 * Integrity rules the API must never be able to break are enforced in the database:
 * - platform and tenant audiences never mix (roles, role permissions, assignments);
 * - a tenant can only use system roles or its own custom roles;
 * - a restaurant/branch scope must belong to the assignment's tenant;
 * - system roles cannot be changed by the app role.
 */
export class AccessControl1798000004000 implements MigrationInterface {
  name = 'AccessControl1798000004000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE permissions (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        code text NOT NULL,
        audience text NOT NULL,
        description text NOT NULL,
        CONSTRAINT permissions_code_key UNIQUE (code),
        CONSTRAINT permissions_code_format CHECK (code ~ '^[a-z_]+:[a-z_]+$'),
        CONSTRAINT permissions_audience_check CHECK (audience IN ('platform', 'tenant'))
      )
    `);
    // The catalogue is code-defined and changes only through migrations.
    await queryRunner.query(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON permissions FROM foodstack_app',
    );

    await queryRunner.query(`
      CREATE TABLE roles (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid REFERENCES tenants (id),
        code text NOT NULL,
        name text NOT NULL,
        description text,
        audience text NOT NULL,
        is_system boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        version integer NOT NULL DEFAULT 1,
        CONSTRAINT roles_tenant_code_key UNIQUE NULLS NOT DISTINCT (tenant_id, code),
        CONSTRAINT roles_code_format CHECK (code ~ '^[a-z][a-z0-9_]{1,47}$'),
        CONSTRAINT roles_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
        CONSTRAINT roles_audience_check CHECK (audience IN ('platform', 'tenant')),
        -- System roles and platform roles are global; tenant custom roles belong to a tenant.
        CONSTRAINT roles_system_global CHECK (NOT is_system OR tenant_id IS NULL),
        CONSTRAINT roles_platform_global CHECK (audience = 'tenant' OR tenant_id IS NULL),
        CONSTRAINT roles_global_kind CHECK (tenant_id IS NOT NULL OR is_system OR audience = 'platform')
      )
    `);
    await queryRunner.query(`
      CREATE TRIGGER roles_set_updated_at BEFORE UPDATE ON roles
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);

    await queryRunner.query(`
      CREATE TABLE role_permissions (
        role_id uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
        permission_id uuid NOT NULL REFERENCES permissions (id),
        PRIMARY KEY (role_id, permission_id)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX role_permissions_permission_idx ON role_permissions (permission_id)',
    );
    await queryRunner.query(`
      CREATE FUNCTION role_permissions_check_audience() RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        DECLARE role_audience text; permission_audience text;
        BEGIN
          SELECT audience INTO role_audience FROM roles WHERE id = NEW.role_id;
          SELECT audience INTO permission_audience FROM permissions WHERE id = NEW.permission_id;
          IF role_audience IS DISTINCT FROM permission_audience THEN
            RAISE EXCEPTION 'Permission audience % does not match role audience %',
              permission_audience, role_audience USING ERRCODE = 'check_violation';
          END IF;
          RETURN NEW;
        END $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER role_permissions_check_audience BEFORE INSERT OR UPDATE ON role_permissions
        FOR EACH ROW EXECUTE FUNCTION role_permissions_check_audience()
    `);

    await queryRunner.query(`
      CREATE TABLE user_role_assignments (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL,
        membership_id uuid NOT NULL,
        role_id uuid NOT NULL REFERENCES roles (id),
        scope_type text NOT NULL,
        scope_id uuid,
        granted_by_user_id uuid REFERENCES users (id),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT user_role_assignments_membership_fkey FOREIGN KEY (tenant_id, membership_id)
          REFERENCES tenant_memberships (tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT user_role_assignments_scope_type_check
          CHECK (scope_type IN ('tenant', 'restaurant', 'branch')),
        CONSTRAINT user_role_assignments_scope_id_presence
          CHECK ((scope_type = 'tenant') = (scope_id IS NULL)),
        CONSTRAINT user_role_assignments_unique
          UNIQUE NULLS NOT DISTINCT (membership_id, role_id, scope_type, scope_id)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX user_role_assignments_membership_idx ON user_role_assignments (tenant_id, membership_id)',
    );
    await queryRunner.query(
      'CREATE INDEX user_role_assignments_role_idx ON user_role_assignments (role_id)',
    );
    // A polymorphic scope_id cannot carry a composite FK, so the trigger checks it instead.
    // It runs as the invoking role, so lookups are themselves limited by RLS to the current tenant.
    await queryRunner.query(`
      CREATE FUNCTION user_role_assignments_check() RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        DECLARE r roles%ROWTYPE;
        BEGIN
          SELECT * INTO r FROM roles WHERE id = NEW.role_id;
          IF NOT FOUND OR r.audience <> 'tenant' THEN
            RAISE EXCEPTION 'Role % is not a tenant role', NEW.role_id USING ERRCODE = 'check_violation';
          END IF;
          IF r.tenant_id IS NOT NULL AND r.tenant_id <> NEW.tenant_id THEN
            RAISE EXCEPTION 'Role % belongs to another tenant', NEW.role_id
              USING ERRCODE = 'check_violation';
          END IF;
          IF NEW.scope_type = 'restaurant' AND NOT EXISTS (
            SELECT 1 FROM restaurants WHERE id = NEW.scope_id AND tenant_id = NEW.tenant_id
          ) THEN
            RAISE EXCEPTION 'Restaurant scope % is not in tenant %', NEW.scope_id, NEW.tenant_id
              USING ERRCODE = 'foreign_key_violation';
          END IF;
          IF NEW.scope_type = 'branch' AND NOT EXISTS (
            SELECT 1 FROM branches WHERE id = NEW.scope_id AND tenant_id = NEW.tenant_id
          ) THEN
            RAISE EXCEPTION 'Branch scope % is not in tenant %', NEW.scope_id, NEW.tenant_id
              USING ERRCODE = 'foreign_key_violation';
          END IF;
          RETURN NEW;
        END $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER user_role_assignments_check BEFORE INSERT OR UPDATE ON user_role_assignments
        FOR EACH ROW EXECUTE FUNCTION user_role_assignments_check()
    `);

    await queryRunner.query(`
      CREATE TABLE platform_role_assignments (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        user_id uuid NOT NULL REFERENCES users (id),
        role_id uuid NOT NULL REFERENCES roles (id),
        granted_by_user_id uuid REFERENCES users (id),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT platform_role_assignments_user_role_key UNIQUE (user_id, role_id)
      )
    `);
    await queryRunner.query(`
      CREATE FUNCTION platform_role_assignments_check() RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM roles WHERE id = NEW.role_id AND audience = 'platform') THEN
            RAISE EXCEPTION 'Role % is not a platform role', NEW.role_id USING ERRCODE = 'check_violation';
          END IF;
          RETURN NEW;
        END $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER platform_role_assignments_check BEFORE INSERT OR UPDATE ON platform_role_assignments
        FOR EACH ROW EXECUTE FUNCTION platform_role_assignments_check()
    `);

    // --- Row-level security -------------------------------------------------------------
    // roles: everyone in a tenant reads system roles and the tenant's own roles; the platform
    // reads all global roles. Writes: the tenant's own custom roles, or (platform) non-system
    // platform roles. System roles are immutable to the app role.
    await queryRunner.query('ALTER TABLE roles ENABLE ROW LEVEL SECURITY');
    await queryRunner.query('ALTER TABLE roles FORCE ROW LEVEL SECURITY');
    await queryRunner.query(`
      CREATE POLICY roles_select ON roles FOR SELECT
        USING (tenant_id IS NULL OR tenant_id = app_current_tenant())
    `);
    await queryRunner.query(`
      CREATE POLICY roles_tenant_write ON roles
        USING (tenant_id = app_current_tenant() AND NOT is_system)
        WITH CHECK (tenant_id = app_current_tenant() AND NOT is_system AND audience = 'tenant')
    `);
    await queryRunner.query(`
      CREATE POLICY roles_platform_write ON roles
        USING (app_is_platform() AND tenant_id IS NULL AND audience = 'platform' AND NOT is_system)
        WITH CHECK (app_is_platform() AND tenant_id IS NULL AND audience = 'platform' AND NOT is_system)
    `);

    await queryRunner.query('ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY');
    await queryRunner.query('ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY');
    await queryRunner.query(`
      CREATE POLICY role_permissions_select ON role_permissions FOR SELECT
        USING (EXISTS (SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id))
    `);
    const writableRole = `EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = role_permissions.role_id AND NOT r.is_system
        AND (r.tenant_id = app_current_tenant()
             OR (app_is_platform() AND r.tenant_id IS NULL AND r.audience = 'platform'))
    )`;
    for (const command of ['INSERT', 'UPDATE', 'DELETE']) {
      const clause =
        command === 'INSERT'
          ? `WITH CHECK (${writableRole})`
          : command === 'UPDATE'
            ? `USING (${writableRole}) WITH CHECK (${writableRole})`
            : `USING (${writableRole})`;
      await queryRunner.query(
        `CREATE POLICY role_permissions_${command.toLowerCase()} ON role_permissions FOR ${command} ${clause}`,
      );
    }

    await queryRunner.query('ALTER TABLE user_role_assignments ENABLE ROW LEVEL SECURITY');
    await queryRunner.query('ALTER TABLE user_role_assignments FORCE ROW LEVEL SECURITY');
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON user_role_assignments
        USING (tenant_id = app_current_tenant())
        WITH CHECK (tenant_id = app_current_tenant())
    `);

    await queryRunner.query('ALTER TABLE platform_role_assignments ENABLE ROW LEVEL SECURITY');
    await queryRunner.query('ALTER TABLE platform_role_assignments FORCE ROW LEVEL SECURITY');
    await queryRunner.query(`
      CREATE POLICY own_or_platform_read ON platform_role_assignments FOR SELECT
        USING (user_id = app_current_user() OR app_is_platform())
    `);
    await queryRunner.query(`
      CREATE POLICY platform_write ON platform_role_assignments
        USING (app_is_platform()) WITH CHECK (app_is_platform())
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE platform_role_assignments');
    await queryRunner.query('DROP TABLE user_role_assignments');
    await queryRunner.query('DROP TABLE role_permissions');
    await queryRunner.query('DROP TABLE roles');
    await queryRunner.query('DROP TABLE permissions');
    await queryRunner.query('DROP FUNCTION platform_role_assignments_check()');
    await queryRunner.query('DROP FUNCTION user_role_assignments_check()');
    await queryRunner.query('DROP FUNCTION role_permissions_check_audience()');
  }
}
