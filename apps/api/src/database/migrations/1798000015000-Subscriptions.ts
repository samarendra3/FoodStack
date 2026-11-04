import { MigrationInterface, QueryRunner } from 'typeorm';
import { disableTenantIsolation, enableTenantIsolation } from '../rls';

/**
 * Restaurant profile fields, the platform plan catalogue, and per-tenant subscriptions with
 * manually verified invoices.
 *
 * - plans: platform-owned (no tenant), managed by Super Admins. Limits NULL = unlimited.
 * - subscriptions: one row per tenant once a first invoice is paid. Trials stay on
 *   tenants.status / trial_ends_at.
 * - subscription_invoices: created as 'pending' when an owner requests a plan, renewal or cycle
 *   change; a Super Admin marks it 'paid' after verifying the transfer, which (and only which)
 *   starts or extends the subscription period. Readable by the tenant and by platform sessions.
 */
export class Subscriptions1798000015000 implements MigrationInterface {
  name = 'Subscriptions1798000015000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE restaurants
        ADD COLUMN logo_url text,
        ADD COLUMN phone text,
        ADD COLUMN email citext,
        ADD COLUMN address_line text,
        ADD COLUMN city text,
        ADD COLUMN state text,
        ADD COLUMN postal_code text,
        ADD COLUMN gstin text,
        ADD COLUMN registration_number text,
        ADD CONSTRAINT restaurants_logo_url_check CHECK (logo_url ~ '^https://\\S+$' AND char_length(logo_url) <= 500),
        ADD CONSTRAINT restaurants_phone_check CHECK (phone ~ '^\\+?[0-9]{6,15}$'),
        ADD CONSTRAINT restaurants_email_check CHECK (email ~ '^[^@\\s]+@[^@\\s]+$' AND char_length(email) <= 254),
        ADD CONSTRAINT restaurants_address_length CHECK (char_length(address_line) <= 200),
        ADD CONSTRAINT restaurants_city_length CHECK (char_length(city) <= 80),
        ADD CONSTRAINT restaurants_state_length CHECK (char_length(state) <= 80),
        ADD CONSTRAINT restaurants_postal_check CHECK (postal_code ~ '^[A-Za-z0-9 -]{3,12}$'),
        ADD CONSTRAINT restaurants_gstin_check CHECK (gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
        ADD CONSTRAINT restaurants_registration_length CHECK (char_length(registration_number) <= 60)`);

    await queryRunner.query(`
      CREATE TABLE plans (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        code citext NOT NULL,
        name text NOT NULL,
        description text,
        currency_code char(3) NOT NULL DEFAULT 'INR',
        price_monthly_minor bigint NOT NULL,
        price_yearly_minor bigint NOT NULL,
        max_branches integer,
        max_staff integer,
        max_orders_per_month integer,
        max_menu_items integer,
        features text[] NOT NULL DEFAULT '{}',
        is_active boolean NOT NULL DEFAULT true,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT plans_code_key UNIQUE (code),
        CONSTRAINT plans_code_format CHECK (code ~ '^[a-z0-9-]{2,30}$'),
        CONSTRAINT plans_name_length CHECK (char_length(name) BETWEEN 1 AND 40),
        CONSTRAINT plans_description_length CHECK (char_length(description) <= 200),
        CONSTRAINT plans_price_check CHECK (price_monthly_minor BETWEEN 0 AND 100000000 AND price_yearly_minor BETWEEN 0 AND 1000000000),
        CONSTRAINT plans_limits_check CHECK (
          max_branches >= 1 AND max_staff >= 1 AND max_orders_per_month >= 1 AND max_menu_items >= 1),
        CONSTRAINT plans_features_check CHECK (cardinality(features) <= 30)
      )`);

    await queryRunner.query(`
      CREATE TABLE subscriptions (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL REFERENCES tenants (id),
        plan_id uuid NOT NULL REFERENCES plans (id),
        billing_cycle text NOT NULL,
        status text NOT NULL DEFAULT 'active',
        current_period_start timestamptz NOT NULL,
        current_period_end timestamptz NOT NULL,
        cancelled_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT subscriptions_tenant_key UNIQUE (tenant_id),
        CONSTRAINT subscriptions_cycle_check CHECK (billing_cycle IN ('monthly', 'yearly')),
        CONSTRAINT subscriptions_status_check CHECK (status IN ('active', 'cancelled')),
        CONSTRAINT subscriptions_period_check CHECK (current_period_end > current_period_start),
        CONSTRAINT subscriptions_cancelled_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
      )`);

    await queryRunner.query(`CREATE SEQUENCE subscription_invoice_number_seq`);
    await queryRunner.query(`
      CREATE TABLE subscription_invoices (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL REFERENCES tenants (id),
        invoice_number text NOT NULL DEFAULT
          'FS-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('subscription_invoice_number_seq')::text, 6, '0'),
        plan_id uuid NOT NULL REFERENCES plans (id),
        plan_name text NOT NULL,
        billing_cycle text NOT NULL,
        kind text NOT NULL,
        amount_minor bigint NOT NULL,
        currency_code char(3) NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        period_start timestamptz,
        period_end timestamptz,
        payment_method text,
        payment_reference text,
        note text,
        requested_by uuid REFERENCES users (id),
        verified_by uuid REFERENCES users (id),
        created_at timestamptz NOT NULL DEFAULT now(),
        paid_at timestamptz,
        cancelled_at timestamptz,
        CONSTRAINT subscription_invoices_number_key UNIQUE (invoice_number),
        CONSTRAINT subscription_invoices_cycle_check CHECK (billing_cycle IN ('monthly', 'yearly')),
        CONSTRAINT subscription_invoices_kind_check
          CHECK (kind IN ('new', 'renewal', 'upgrade', 'downgrade', 'cycle_change')),
        CONSTRAINT subscription_invoices_amount_check CHECK (amount_minor >= 0),
        CONSTRAINT subscription_invoices_status_check CHECK (status IN ('pending', 'paid', 'cancelled')),
        CONSTRAINT subscription_invoices_paid_check CHECK (
          (status = 'paid') = (paid_at IS NOT NULL AND period_start IS NOT NULL AND period_end IS NOT NULL
                               AND payment_method IS NOT NULL)),
        CONSTRAINT subscription_invoices_cancelled_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
        CONSTRAINT subscription_invoices_method_check
          CHECK (payment_method IN ('bank_transfer', 'upi', 'card', 'cash', 'other')),
        CONSTRAINT subscription_invoices_reference_length CHECK (char_length(payment_reference) <= 80),
        CONSTRAINT subscription_invoices_note_length CHECK (char_length(note) <= 300)
      )`);
    // At most one unpaid request per tenant.
    await queryRunner.query(`
      CREATE UNIQUE INDEX subscription_invoices_one_pending ON subscription_invoices (tenant_id)
        WHERE status = 'pending'`);
    await queryRunner.query(`
      CREATE INDEX subscription_invoices_tenant_created_idx ON subscription_invoices (tenant_id, created_at DESC)`);
    await queryRunner.query(`
      CREATE INDEX subscription_invoices_status_idx ON subscription_invoices (status, created_at DESC)`);

    for (const t of ['subscriptions', 'subscription_invoices']) {
      await enableTenantIsolation(queryRunner, t);
      await queryRunner.query(
        `CREATE POLICY platform_access ON ${t} USING (app_is_platform()) WITH CHECK (app_is_platform())`,
      );
    }

    // Super Admins manage the catalogue and verify payments.
    await queryRunner.query(
      `INSERT INTO permissions (code, audience, description)
       VALUES ('platform:billing_manage', 'platform', 'Manage plans and verify subscription payments')
       ON CONFLICT (code) DO NOTHING`,
    );
    await queryRunner.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'platform:billing_manage'
        WHERE r.tenant_id IS NULL AND r.is_system AND r.code = 'super_admin'
       ON CONFLICT DO NOTHING`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM role_permissions WHERE permission_id IN (
         SELECT id FROM permissions WHERE code = 'platform:billing_manage')`,
    );
    await queryRunner.query(`DELETE FROM permissions WHERE code = 'platform:billing_manage'`);
    for (const t of ['subscription_invoices', 'subscriptions']) {
      await queryRunner.query(`DROP POLICY platform_access ON ${t}`);
      await disableTenantIsolation(queryRunner, t);
    }
    await queryRunner.query('DROP TABLE subscription_invoices');
    await queryRunner.query('DROP SEQUENCE subscription_invoice_number_seq');
    await queryRunner.query('DROP TABLE subscriptions');
    await queryRunner.query('DROP TABLE plans');
    await queryRunner.query(`
      ALTER TABLE restaurants
        DROP COLUMN logo_url, DROP COLUMN phone, DROP COLUMN email, DROP COLUMN address_line,
        DROP COLUMN city, DROP COLUMN state, DROP COLUMN postal_code, DROP COLUMN gstin,
        DROP COLUMN registration_number`);
  }
}
