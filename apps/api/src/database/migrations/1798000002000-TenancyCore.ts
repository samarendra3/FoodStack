import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tenant → restaurant → branch hierarchy (docs/phase-3-design.md §2.1–2.2).
 *
 * Every tenant-owned table has ENABLE + FORCE row-level security. Composite foreign keys that
 * include tenant_id make it impossible for a row to reference another tenant's parent.
 *
 * Registration inserts a tenant by first setting app.tenant_id to the new id (generated with
 * uuidv7() beforehand), so no policy needs a bypass. A trigger keeps tenant status changes
 * platform-only.
 */
export class TenancyCore1798000002000 implements MigrationInterface {
  name = 'TenancyCore1798000002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE tenants (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        slug citext NOT NULL,
        name text NOT NULL,
        status text NOT NULL DEFAULT 'trial',
        trial_ends_at timestamptz,
        status_changed_at timestamptz NOT NULL DEFAULT now(),
        status_reason text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        version integer NOT NULL DEFAULT 1,
        CONSTRAINT tenants_slug_key UNIQUE (slug),
        CONSTRAINT tenants_slug_format CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$'),
        CONSTRAINT tenants_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
        CONSTRAINT tenants_status_check CHECK (status IN ('trial', 'active', 'suspended', 'deactivated'))
      )
    `);
    await queryRunner.query(`
      CREATE TRIGGER tenants_set_updated_at BEFORE UPDATE ON tenants
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);
    // Tenants may rename themselves; only the platform may change status.
    await queryRunner.query(`
      CREATE FUNCTION tenants_guard_status() RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF TG_OP = 'INSERT' AND NEW.status <> 'trial' AND NOT app_is_platform() THEN
            RAISE EXCEPTION 'Only the platform can create a tenant with status %', NEW.status
              USING ERRCODE = 'insufficient_privilege';
          END IF;
          IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
            IF NOT app_is_platform() THEN
              RAISE EXCEPTION 'Only the platform can change tenant status'
                USING ERRCODE = 'insufficient_privilege';
            END IF;
            NEW.status_changed_at = now();
          END IF;
          RETURN NEW;
        END $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER tenants_guard_status BEFORE INSERT OR UPDATE ON tenants
        FOR EACH ROW EXECUTE FUNCTION tenants_guard_status()
    `);

    await queryRunner.query(`
      CREATE TABLE restaurants (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL REFERENCES tenants (id),
        name text NOT NULL,
        slug citext NOT NULL,
        legal_name text,
        currency_code char(3) NOT NULL,
        country_code char(2) NOT NULL,
        timezone text NOT NULL,
        status text NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        version integer NOT NULL DEFAULT 1,
        CONSTRAINT restaurants_tenant_slug_key UNIQUE (tenant_id, slug),
        CONSTRAINT restaurants_tenant_id_id_key UNIQUE (tenant_id, id),
        CONSTRAINT restaurants_slug_format CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$'),
        CONSTRAINT restaurants_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
        CONSTRAINT restaurants_currency_format CHECK (currency_code ~ '^[A-Z]{3}$'),
        CONSTRAINT restaurants_country_format CHECK (country_code ~ '^[A-Z]{2}$'),
        CONSTRAINT restaurants_status_check CHECK (status IN ('active', 'inactive'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE branches (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL,
        restaurant_id uuid NOT NULL,
        code citext NOT NULL,
        name text NOT NULL,
        timezone text NOT NULL,
        status text NOT NULL DEFAULT 'active',
        is_default boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        version integer NOT NULL DEFAULT 1,
        CONSTRAINT branches_restaurant_fkey FOREIGN KEY (tenant_id, restaurant_id)
          REFERENCES restaurants (tenant_id, id),
        CONSTRAINT branches_tenant_code_key UNIQUE (tenant_id, code),
        CONSTRAINT branches_tenant_id_id_key UNIQUE (tenant_id, id),
        CONSTRAINT branches_code_format CHECK (code ~ '^[A-Za-z0-9_-]{1,32}$'),
        CONSTRAINT branches_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
        CONSTRAINT branches_status_check CHECK (status IN ('active', 'inactive'))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX branches_one_default_per_restaurant
        ON branches (restaurant_id) WHERE is_default
    `);
    await queryRunner.query(
      'CREATE INDEX branches_restaurant_idx ON branches (tenant_id, restaurant_id)',
    );

    for (const table of ['restaurants', 'branches']) {
      await queryRunner.query(`
        CREATE TRIGGER ${table}_set_updated_at BEFORE UPDATE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION set_updated_at()
      `);
      await queryRunner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON ${table}
          USING (tenant_id = app_current_tenant())
          WITH CHECK (tenant_id = app_current_tenant())
      `);
    }

    // tenants: own tenant, or platform context. A policy letting users see the tenants they
    // belong to is added with tenant_memberships (next migration).
    await queryRunner.query('ALTER TABLE tenants ENABLE ROW LEVEL SECURITY');
    await queryRunner.query('ALTER TABLE tenants FORCE ROW LEVEL SECURITY');
    await queryRunner.query(`
      CREATE POLICY tenants_select ON tenants FOR SELECT
        USING (id = app_current_tenant() OR app_is_platform())
    `);
    await queryRunner.query(`
      CREATE POLICY tenants_insert ON tenants FOR INSERT
        WITH CHECK (id = app_current_tenant() OR app_is_platform())
    `);
    await queryRunner.query(`
      CREATE POLICY tenants_update ON tenants FOR UPDATE
        USING (id = app_current_tenant() OR app_is_platform())
        WITH CHECK (id = app_current_tenant() OR app_is_platform())
    `);
    // No DELETE policy: tenants are deactivated, never deleted by the API.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE branches');
    await queryRunner.query('DROP TABLE restaurants');
    await queryRunner.query('DROP TABLE tenants');
    await queryRunner.query('DROP FUNCTION tenants_guard_status()');
  }
}
