import { MigrationInterface, QueryRunner } from 'typeorm';
import { disableTenantIsolation, enableTenantIsolation } from '../rls';
import { seedOrderPacks } from '../seeds/order-packs';

/**
 * Subscription add-ons: extra capacity a restaurant buys without changing plan.
 *
 * - addon_packages (platform-owned catalogue): type (orders / branches / staff / storage),
 *   quantity, price, and a validity policy:
 *     current_cycle: until the end of the restaurant's current billing period (or trial),
 *     fixed_days:    validity_days from the moment payment is verified,
 *     custom:        until a fixed date (valid_until), e.g. a promotion.
 * - Purchases reuse subscription_invoices (kind = 'addon'): the same pending → paid flow, the
 *   same gateway checkout / webhook and Super Admin verification. plan_id and billing_cycle are
 *   empty for add-on invoices; addon_snapshot freezes what was bought at request time.
 * - addon_grants (tenant): the entitlement created when an add-on invoice is paid. Capacity
 *   counts while starts_at <= now < expires_at and it is not revoked. Rows are never deleted:
 *   expiry and refunds/chargebacks are recorded on the row and in subscription_events.
 * - Invoices gain 'refunded' (with refunded_at / refund_reason) for reversed add-on payments.
 */
export class Addons1798000019000 implements MigrationInterface {
  name = 'Addons1798000019000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE addon_packages (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        code citext NOT NULL,
        name text NOT NULL,
        description text,
        addon_type text NOT NULL,
        quantity integer NOT NULL,
        price_minor bigint NOT NULL,
        currency_code char(3) NOT NULL DEFAULT 'INR',
        validity text NOT NULL DEFAULT 'current_cycle',
        validity_days integer,
        valid_until timestamptz,
        is_active boolean NOT NULL DEFAULT true,
        is_popular boolean NOT NULL DEFAULT false,
        sort_order integer NOT NULL DEFAULT 0,
        archived_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT addon_packages_code_key UNIQUE (code),
        CONSTRAINT addon_packages_code_format CHECK (code ~ '^[a-z0-9-]{2,40}$'),
        CONSTRAINT addon_packages_name_length CHECK (char_length(name) BETWEEN 1 AND 60),
        CONSTRAINT addon_packages_description_length CHECK (char_length(description) <= 200),
        CONSTRAINT addon_packages_type_check
          CHECK (addon_type IN ('orders', 'branches', 'staff', 'storage')),
        CONSTRAINT addon_packages_quantity_check CHECK (quantity BETWEEN 1 AND 1000000),
        CONSTRAINT addon_packages_price_check CHECK (price_minor BETWEEN 0 AND 100000000),
        CONSTRAINT addon_packages_currency_format CHECK (currency_code ~ '^[A-Z]{3}$'),
        CONSTRAINT addon_packages_validity_check
          CHECK (validity IN ('current_cycle', 'fixed_days', 'custom')),
        CONSTRAINT addon_packages_days_check CHECK (
          (validity = 'fixed_days') = (validity_days IS NOT NULL) AND validity_days BETWEEN 1 AND 366),
        CONSTRAINT addon_packages_until_check CHECK ((validity = 'custom') = (valid_until IS NOT NULL)),
        CONSTRAINT addon_packages_sort_check CHECK (sort_order BETWEEN 0 AND 1000),
        CONSTRAINT addon_packages_archived_check CHECK (archived_at IS NULL OR NOT is_active)
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX addon_packages_name_key ON addon_packages (lower(name))`,
    );
    await queryRunner.query(
      `CREATE INDEX addon_packages_offered_idx ON addon_packages (addon_type, sort_order) WHERE is_active AND archived_at IS NULL`,
    );

    await queryRunner.query(`
      ALTER TABLE subscription_invoices
        ALTER COLUMN plan_id DROP NOT NULL,
        ALTER COLUMN billing_cycle DROP NOT NULL,
        ADD COLUMN addon_package_id uuid REFERENCES addon_packages (id),
        ADD COLUMN addon_snapshot jsonb,
        ADD COLUMN refunded_at timestamptz,
        ADD COLUMN refund_reason text,
        DROP CONSTRAINT subscription_invoices_kind_check,
        ADD CONSTRAINT subscription_invoices_kind_check
          CHECK (kind IN ('new', 'renewal', 'upgrade', 'downgrade', 'cycle_change', 'addon')),
        ADD CONSTRAINT subscription_invoices_target_check CHECK (
          CASE WHEN kind = 'addon'
            THEN addon_package_id IS NOT NULL AND addon_snapshot IS NOT NULL
                 AND plan_id IS NULL AND billing_cycle IS NULL
            ELSE plan_id IS NOT NULL AND billing_cycle IS NOT NULL AND addon_package_id IS NULL END),
        DROP CONSTRAINT subscription_invoices_status_check,
        ADD CONSTRAINT subscription_invoices_status_check
          CHECK (status IN ('pending', 'paid', 'cancelled', 'refunded')),
        DROP CONSTRAINT subscription_invoices_paid_check,
        ADD CONSTRAINT subscription_invoices_paid_check CHECK (
          (status IN ('paid', 'refunded')) = (paid_at IS NOT NULL AND period_start IS NOT NULL
                                             AND period_end IS NOT NULL AND payment_method IS NOT NULL)),
        ADD CONSTRAINT subscription_invoices_refunded_check
          CHECK ((status = 'refunded') = (refunded_at IS NOT NULL)),
        ADD CONSTRAINT subscription_invoices_refund_reason_length CHECK (char_length(refund_reason) <= 300)`);

    await queryRunner.query(`
      CREATE TABLE addon_grants (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
        invoice_id uuid NOT NULL REFERENCES subscription_invoices (id),
        addon_package_id uuid NOT NULL REFERENCES addon_packages (id),
        addon_type text NOT NULL,
        quantity integer NOT NULL,
        name text NOT NULL,
        starts_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'active',
        revoked_at timestamptz,
        revoke_reason text,
        expiry_recorded_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT addon_grants_invoice_key UNIQUE (invoice_id),
        CONSTRAINT addon_grants_type_check
          CHECK (addon_type IN ('orders', 'branches', 'staff', 'storage')),
        CONSTRAINT addon_grants_quantity_check CHECK (quantity >= 1),
        CONSTRAINT addon_grants_window_check CHECK (expires_at > starts_at),
        CONSTRAINT addon_grants_status_check CHECK (status IN ('active', 'revoked')),
        CONSTRAINT addon_grants_revoked_check CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
        CONSTRAINT addon_grants_reason_length CHECK (char_length(revoke_reason) <= 300)
      )`);
    // Entitlement lookups: a tenant's live grants of one type.
    await queryRunner.query(
      `CREATE INDEX addon_grants_live_idx ON addon_grants (tenant_id, addon_type, expires_at) WHERE status = 'active'`,
    );
    await queryRunner.query(
      `CREATE INDEX addon_grants_expiry_idx ON addon_grants (expires_at) WHERE status = 'active' AND expiry_recorded_at IS NULL`,
    );
    await enableTenantIsolation(queryRunner, 'addon_grants');
    await queryRunner.query(
      `CREATE POLICY platform_access ON addon_grants USING (app_is_platform()) WITH CHECK (app_is_platform())`,
    );

    await seedOrderPacks(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP POLICY platform_access ON addon_grants');
    await disableTenantIsolation(queryRunner, 'addon_grants');
    await queryRunner.query('DROP TABLE addon_grants');
    await queryRunner.query(`DELETE FROM subscription_invoices WHERE kind = 'addon'`);
    await queryRunner.query(`
      ALTER TABLE subscription_invoices
        DROP CONSTRAINT subscription_invoices_refund_reason_length,
        DROP CONSTRAINT subscription_invoices_refunded_check,
        DROP CONSTRAINT subscription_invoices_paid_check,
        ADD CONSTRAINT subscription_invoices_paid_check CHECK (
          (status = 'paid') = (paid_at IS NOT NULL AND period_start IS NOT NULL AND period_end IS NOT NULL
                               AND payment_method IS NOT NULL)),
        DROP CONSTRAINT subscription_invoices_status_check,
        ADD CONSTRAINT subscription_invoices_status_check CHECK (status IN ('pending', 'paid', 'cancelled')),
        DROP CONSTRAINT subscription_invoices_target_check,
        DROP CONSTRAINT subscription_invoices_kind_check,
        ADD CONSTRAINT subscription_invoices_kind_check
          CHECK (kind IN ('new', 'renewal', 'upgrade', 'downgrade', 'cycle_change')),
        DROP COLUMN refund_reason, DROP COLUMN refunded_at, DROP COLUMN addon_snapshot,
        DROP COLUMN addon_package_id,
        ALTER COLUMN billing_cycle SET NOT NULL,
        ALTER COLUMN plan_id SET NOT NULL`);
    await queryRunner.query('DROP TABLE addon_packages');
  }
}
