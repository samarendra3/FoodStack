import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Identity: global users, tenant memberships, sessions with rotating refresh tokens,
 * single-use tokens and login activity (docs/phase-3-design.md §2.1–2.2).
 *
 * `users`, `user_tokens`, `login_attempts` and `mfa_recovery_codes` are not tenant-owned and have
 * no RLS; only identity services touch them. `user_tokens` deliberately has no tenant_id column
 * (an invitation's tenant lives in `payload`), so every table with tenant_id stays under RLS.
 *
 * Refresh tokens are presented as `<sessionId>.<secret>`: the API sets app.session_id before
 * looking the token up, so no policy bypass (or SECURITY DEFINER function) is needed to resolve
 * an unknown caller.
 */
export class Identity1798000003000 implements MigrationInterface {
  name = 'Identity1798000003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        email citext NOT NULL,
        full_name text NOT NULL,
        phone_e164 text,
        password_hash text,
        email_verified_at timestamptz,
        status text NOT NULL DEFAULT 'active',
        failed_login_count integer NOT NULL DEFAULT 0,
        locked_until timestamptz,
        last_login_at timestamptz,
        password_changed_at timestamptz,
        mfa_enabled boolean NOT NULL DEFAULT false,
        mfa_secret_enc bytea,
        mfa_enrolled_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        version integer NOT NULL DEFAULT 1,
        CONSTRAINT users_email_key UNIQUE (email),
        CONSTRAINT users_phone_key UNIQUE (phone_e164),
        CONSTRAINT users_email_format CHECK (email ~ '^[^@\\s]+@[^@\\s]+$' AND char_length(email) <= 254),
        CONSTRAINT users_full_name_length CHECK (char_length(full_name) BETWEEN 1 AND 120),
        CONSTRAINT users_phone_format CHECK (phone_e164 ~ '^\\+[1-9][0-9]{6,14}$'),
        CONSTRAINT users_status_check CHECK (status IN ('active', 'disabled')),
        CONSTRAINT users_failed_login_count_check CHECK (failed_login_count >= 0),
        CONSTRAINT users_mfa_secret_present CHECK (NOT mfa_enabled OR mfa_secret_enc IS NOT NULL)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE mfa_recovery_codes (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        code_hash text NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id) WHERE used_at IS NULL',
    );

    await queryRunner.query(`
      CREATE TABLE tenant_memberships (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL REFERENCES tenants (id),
        user_id uuid NOT NULL REFERENCES users (id),
        status text NOT NULL DEFAULT 'invited',
        permission_version integer NOT NULL DEFAULT 1,
        invited_by_user_id uuid REFERENCES users (id),
        joined_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        version integer NOT NULL DEFAULT 1,
        CONSTRAINT tenant_memberships_tenant_user_key UNIQUE (tenant_id, user_id),
        CONSTRAINT tenant_memberships_tenant_id_id_key UNIQUE (tenant_id, id),
        CONSTRAINT tenant_memberships_status_check CHECK (status IN ('invited', 'active', 'suspended'))
      )
    `);
    await queryRunner.query(
      'CREATE INDEX tenant_memberships_user_idx ON tenant_memberships (user_id)',
    );

    await queryRunner.query(`
      CREATE TABLE sessions (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        user_id uuid NOT NULL REFERENCES users (id),
        audience text NOT NULL,
        tenant_id uuid REFERENCES tenants (id),
        membership_id uuid,
        mfa_verified_at timestamptz,
        ip inet,
        user_agent text,
        device_name text,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        idle_expires_at timestamptz NOT NULL,
        absolute_expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        revoke_reason text,
        CONSTRAINT sessions_membership_fkey FOREIGN KEY (tenant_id, membership_id)
          REFERENCES tenant_memberships (tenant_id, id),
        CONSTRAINT sessions_audience_check CHECK (audience IN ('tenant', 'platform')),
        CONSTRAINT sessions_audience_tenant CHECK (
          (audience = 'tenant') = (tenant_id IS NOT NULL)
          AND (tenant_id IS NULL) = (membership_id IS NULL)
        ),
        CONSTRAINT sessions_expiry_order CHECK (idle_expires_at <= absolute_expires_at),
        CONSTRAINT sessions_revoke_consistent CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
        CONSTRAINT sessions_revoke_reason_check CHECK (revoke_reason IN (
          'logout', 'logout_all', 'reuse_detected', 'password_changed', 'tenant_suspended',
          'membership_suspended', 'admin_revoked', 'expired', 'tenant_switched'
        )),
        CONSTRAINT sessions_user_agent_length CHECK (char_length(user_agent) <= 512),
        CONSTRAINT sessions_device_name_length CHECK (char_length(device_name) <= 120)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL',
    );
    await queryRunner.query(
      'CREATE INDEX sessions_tenant_active_idx ON sessions (tenant_id) WHERE revoked_at IS NULL',
    );

    await queryRunner.query(`
      CREATE TABLE refresh_tokens (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
        token_hash bytea NOT NULL,
        parent_id uuid REFERENCES refresh_tokens (id),
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash),
        CONSTRAINT refresh_tokens_hash_length CHECK (octet_length(token_hash) = 32)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX refresh_tokens_session_idx ON refresh_tokens (session_id)',
    );

    await queryRunner.query(`
      CREATE TABLE user_tokens (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        user_id uuid REFERENCES users (id) ON DELETE CASCADE,
        purpose text NOT NULL,
        token_hash bytea NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT user_tokens_token_hash_key UNIQUE (token_hash),
        CONSTRAINT user_tokens_hash_length CHECK (octet_length(token_hash) = 32),
        CONSTRAINT user_tokens_purpose_check CHECK (purpose IN (
          'email_verification', 'password_reset', 'invitation', 'mfa_challenge'
        ))
      )
    `);
    await queryRunner.query(
      'CREATE INDEX user_tokens_user_purpose_idx ON user_tokens (user_id, purpose) WHERE used_at IS NULL',
    );

    await queryRunner.query(`
      CREATE TABLE login_attempts (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        email citext NOT NULL,
        user_id uuid REFERENCES users (id),
        ip inet,
        user_agent text,
        success boolean NOT NULL,
        reason text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT login_attempts_reason_check CHECK (reason IN (
          'ok', 'bad_credentials', 'locked', 'unverified', 'mfa_required', 'mfa_failed',
          'disabled', 'tenant_inactive', 'rate_limited'
        )),
        CONSTRAINT login_attempts_success_reason CHECK (success = (reason = 'ok')),
        CONSTRAINT login_attempts_user_agent_length CHECK (char_length(user_agent) <= 512)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX login_attempts_user_idx ON login_attempts (user_id, created_at DESC)',
    );
    await queryRunner.query(
      'CREATE INDEX login_attempts_ip_idx ON login_attempts (ip, created_at DESC)',
    );
    await queryRunner.query(
      'CREATE INDEX login_attempts_created_brin ON login_attempts USING brin (created_at)',
    );
    // Append-only activity log.
    await queryRunner.query('REVOKE UPDATE, DELETE, TRUNCATE ON login_attempts FROM foodstack_app');

    for (const table of ['users', 'tenant_memberships']) {
      await queryRunner.query(`
        CREATE TRIGGER ${table}_set_updated_at BEFORE UPDATE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION set_updated_at()
      `);
    }

    // tenant_memberships: full access within the current tenant; a user may read their own
    // memberships (login, /auth/me, switch-tenant); the platform may read all.
    await queryRunner.query('ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY');
    await queryRunner.query('ALTER TABLE tenant_memberships FORCE ROW LEVEL SECURITY');
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON tenant_memberships
        USING (tenant_id = app_current_tenant())
        WITH CHECK (tenant_id = app_current_tenant())
    `);
    await queryRunner.query(`
      CREATE POLICY own_memberships ON tenant_memberships FOR SELECT
        USING (user_id = app_current_user())
    `);
    await queryRunner.query(`
      CREATE POLICY platform_read ON tenant_memberships FOR SELECT
        USING (app_is_platform())
    `);

    // A user can see the tenants they belong to (needed before a tenant is chosen at login).
    await queryRunner.query(`
      CREATE POLICY tenants_member_select ON tenants FOR SELECT
        USING (EXISTS (
          SELECT 1 FROM tenant_memberships m
          WHERE m.tenant_id = tenants.id AND m.user_id = app_current_user()
        ))
    `);

    // sessions: the owner of the session, the session being refreshed, sessions bound to the
    // current tenant (membership suspension revokes them), or the platform.
    await queryRunner.query('ALTER TABLE sessions ENABLE ROW LEVEL SECURITY');
    await queryRunner.query('ALTER TABLE sessions FORCE ROW LEVEL SECURITY');
    await queryRunner.query(`
      CREATE POLICY session_access ON sessions
        USING (
          user_id = app_current_user()
          OR id = app_current_session()
          OR (tenant_id IS NOT NULL AND tenant_id = app_current_tenant())
          OR app_is_platform()
        )
        WITH CHECK (
          user_id = app_current_user()
          OR id = app_current_session()
          OR (tenant_id IS NOT NULL AND tenant_id = app_current_tenant())
          OR app_is_platform()
        )
    `);

    // refresh_tokens follow the visibility of their session.
    await queryRunner.query('ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY');
    await queryRunner.query('ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY');
    await queryRunner.query(`
      CREATE POLICY via_session ON refresh_tokens
        USING (EXISTS (SELECT 1 FROM sessions s WHERE s.id = refresh_tokens.session_id))
        WITH CHECK (EXISTS (SELECT 1 FROM sessions s WHERE s.id = refresh_tokens.session_id))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP POLICY tenants_member_select ON tenants');
    for (const table of [
      'refresh_tokens',
      'sessions',
      'login_attempts',
      'user_tokens',
      'tenant_memberships',
      'mfa_recovery_codes',
      'users',
    ]) {
      await queryRunner.query(`DROP TABLE ${table}`);
    }
  }
}
