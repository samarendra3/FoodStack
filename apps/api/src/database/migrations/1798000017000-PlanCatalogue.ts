import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The plan catalogue becomes the single source of truth for pricing on every surface.
 *
 * - plans.code is the public slug. New: trial length, storage limit, public visibility, a
 *   popular/recommended badge, an icon key, custom (quote-based) pricing, plan-specific feature
 *   flags, and archiving (a referenced plan is archived, never deleted).
 * - subscriptions.plan_snapshot: the price, currency, limits and features the customer agreed to
 *   when the payment was applied. Editing a plan never changes an existing customer's terms;
 *   limits are enforced from this snapshot.
 */
export class PlanCatalogue1798000017000 implements MigrationInterface {
  name = 'PlanCatalogue1798000017000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE plans
        DROP CONSTRAINT plans_price_check,
        ALTER COLUMN price_monthly_minor DROP NOT NULL,
        ALTER COLUMN price_yearly_minor DROP NOT NULL,
        ADD COLUMN trial_days integer NOT NULL DEFAULT 15,
        ADD COLUMN max_storage_mb integer,
        ADD COLUMN is_public boolean NOT NULL DEFAULT true,
        ADD COLUMN badge text,
        ADD COLUMN icon text NOT NULL DEFAULT 'sparkles',
        ADD COLUMN custom_pricing boolean NOT NULL DEFAULT false,
        ADD COLUMN feature_flags jsonb NOT NULL DEFAULT '{}',
        ADD COLUMN archived_at timestamptz,
        ADD CONSTRAINT plans_price_check CHECK (
          (custom_pricing AND price_monthly_minor IS NULL AND price_yearly_minor IS NULL)
          OR (NOT custom_pricing AND price_monthly_minor BETWEEN 0 AND 100000000
              AND price_yearly_minor BETWEEN 0 AND 1000000000)),
        ADD CONSTRAINT plans_trial_days_check CHECK (trial_days BETWEEN 1 AND 90),
        ADD CONSTRAINT plans_storage_check CHECK (max_storage_mb >= 1),
        ADD CONSTRAINT plans_badge_check CHECK (badge IN ('popular', 'recommended')),
        ADD CONSTRAINT plans_icon_check CHECK (icon IN ('rocket', 'sparkles', 'building', 'store', 'crown')),
        ADD CONSTRAINT plans_feature_flags_check CHECK (jsonb_typeof(feature_flags) = 'object'),
        ADD CONSTRAINT plans_currency_format CHECK (currency_code ~ '^[A-Z]{3}$'),
        ADD CONSTRAINT plans_archived_check CHECK (archived_at IS NULL OR (NOT is_active AND NOT is_public))`);
    await queryRunner.query(
      `CREATE INDEX plans_public_idx ON plans (sort_order) WHERE is_active AND is_public AND archived_at IS NULL`,
    );

    await queryRunner.query(`ALTER TABLE subscriptions ADD COLUMN plan_snapshot jsonb`);
    // The plan a prospect picked on the pricing page (sets the trial length on approval).
    await queryRunner.query(
      `ALTER TABLE access_requests ADD COLUMN plan_code citext CHECK (plan_code ~ '^[a-z0-9-]{2,30}$')`,
    );
    // Existing paid subscriptions agreed to the plan as it is today.
    await queryRunner.query(`
      UPDATE subscriptions s SET plan_snapshot = jsonb_build_object(
          'planId', p.id, 'code', p.code, 'name', p.name, 'currencyCode', trim(p.currency_code),
          'billingCycle', s.billing_cycle,
          'priceMinor', CASE WHEN s.billing_cycle = 'yearly' THEN p.price_yearly_minor ELSE p.price_monthly_minor END,
          'limits', jsonb_build_object('branches', p.max_branches, 'staff', p.max_staff,
                                       'ordersPerMonth', p.max_orders_per_month, 'menuItems', p.max_menu_items,
                                       'storageMb', p.max_storage_mb),
          'features', to_jsonb(p.features), 'featureFlags', p.feature_flags)
        FROM plans p WHERE p.id = s.plan_id`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE access_requests DROP COLUMN plan_code');
    await queryRunner.query('ALTER TABLE subscriptions DROP COLUMN plan_snapshot');
    await queryRunner.query('DROP INDEX plans_public_idx');
    await queryRunner.query(
      `UPDATE plans SET price_monthly_minor = coalesce(price_monthly_minor, 0),
                        price_yearly_minor = coalesce(price_yearly_minor, 0)`,
    );
    await queryRunner.query(`
      ALTER TABLE plans
        DROP CONSTRAINT plans_archived_check,
        DROP CONSTRAINT plans_currency_format,
        DROP CONSTRAINT plans_feature_flags_check,
        DROP CONSTRAINT plans_icon_check,
        DROP CONSTRAINT plans_badge_check,
        DROP CONSTRAINT plans_storage_check,
        DROP CONSTRAINT plans_trial_days_check,
        DROP CONSTRAINT plans_price_check,
        DROP COLUMN archived_at, DROP COLUMN feature_flags, DROP COLUMN custom_pricing,
        DROP COLUMN icon, DROP COLUMN badge, DROP COLUMN is_public, DROP COLUMN max_storage_mb,
        DROP COLUMN trial_days,
        ALTER COLUMN price_monthly_minor SET NOT NULL,
        ALTER COLUMN price_yearly_minor SET NOT NULL,
        ADD CONSTRAINT plans_price_check
          CHECK (price_monthly_minor BETWEEN 0 AND 100000000 AND price_yearly_minor BETWEEN 0 AND 1000000000)`);
  }
}
