import { MigrationInterface, QueryRunner } from 'typeorm';
import { seedLaunchPlans } from '../seeds/launch-plans';

/**
 * Plan management for Super Admins, and the initial FoodStack plan catalogue.
 *
 * - plans: plan type (free_trial / paid / enterprise), whether new subscribers get a trial,
 *   which billing cycles are sold, CTA text, internal notes, and an ordered feature list where
 *   each line is included or excluded (feature_items). features (text[]) stays the list of
 *   included lines, kept in sync by the API, because subscription snapshots store it.
 * - Plan names are unique (case-insensitive), and at most one live Free Trial plan exists: it
 *   defines the terms every new restaurant starts on.
 * - New trials snapshot the Free Trial plan's limits at registration (frozen terms, like paid
 *   subscriptions); later edits apply to new restaurants only.
 * - Seeds the four launch plans. ON CONFLICT DO NOTHING skips any whose slug or name already
 *   exists, so re-running never duplicates or overwrites a plan the Super Admin has edited.
 */
export class PlanManagement1798000018000 implements MigrationInterface {
  name = 'PlanManagement1798000018000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE plans
        ADD COLUMN plan_type text NOT NULL DEFAULT 'paid',
        ADD COLUMN allow_trial boolean NOT NULL DEFAULT true,
        ADD COLUMN billing_cycles text NOT NULL DEFAULT 'both',
        ADD COLUMN cta_label text,
        ADD COLUMN admin_notes text,
        ADD COLUMN feature_items jsonb NOT NULL DEFAULT '[]'`);
    // Quote-priced plans are enterprise plans; included features become feature lines.
    await queryRunner.query(`UPDATE plans SET plan_type = 'enterprise' WHERE custom_pricing`);
    await queryRunner.query(`
      UPDATE plans SET feature_items = (
        SELECT coalesce(jsonb_agg(jsonb_build_object('label', f, 'enabled', true) ORDER BY o), '[]')
          FROM unnest(features) WITH ORDINALITY AS u(f, o))`);
    await queryRunner.query(`
      ALTER TABLE plans
        DROP CONSTRAINT plans_badge_check,
        ADD CONSTRAINT plans_badge_check CHECK (badge IN ('popular', 'recommended', 'best_value')),
        ADD CONSTRAINT plans_type_check CHECK (plan_type IN ('free_trial', 'paid', 'enterprise')),
        ADD CONSTRAINT plans_cycles_check CHECK (billing_cycles IN ('monthly', 'yearly', 'both')),
        ADD CONSTRAINT plans_cta_length CHECK (char_length(cta_label) BETWEEN 1 AND 30),
        ADD CONSTRAINT plans_notes_length CHECK (char_length(admin_notes) <= 2000),
        ADD CONSTRAINT plans_feature_items_check
          CHECK (jsonb_typeof(feature_items) = 'array' AND jsonb_array_length(feature_items) <= 30),
        ADD CONSTRAINT plans_custom_pricing_type CHECK (NOT custom_pricing OR plan_type = 'enterprise'),
        ADD CONSTRAINT plans_free_trial_price
          CHECK (plan_type <> 'free_trial' OR (price_monthly_minor = 0 AND price_yearly_minor = 0))`);
    await queryRunner.query(`CREATE UNIQUE INDEX plans_name_key ON plans (lower(name))`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX plans_one_free_trial ON plans ((true)) WHERE plan_type = 'free_trial' AND archived_at IS NULL`,
    );
    await queryRunner.query(`CREATE INDEX plans_created_idx ON plans (created_at)`);

    await seedLaunchPlans(queryRunner);

    // New restaurants start on the Free Trial plan's terms, frozen at registration.
    await queryRunner.query(trialTrigger(true));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(trialTrigger(false));
    // Seeded plans go only if nothing references them; edited or used plans stay.
    await queryRunner.query(`
      DELETE FROM plans p
       WHERE p.code IN ('free-trial', 'starter', 'professional', 'business')
         AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.plan_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM subscription_invoices i WHERE i.plan_id = p.id)`);
    await queryRunner.query(`UPDATE plans SET plan_type = 'paid' WHERE plan_type = 'free_trial'`);
    await queryRunner.query(`UPDATE plans SET badge = NULL WHERE badge = 'best_value'`);
    await queryRunner.query('DROP INDEX plans_created_idx');
    await queryRunner.query('DROP INDEX plans_one_free_trial');
    await queryRunner.query('DROP INDEX plans_name_key');
    await queryRunner.query(`
      ALTER TABLE plans
        DROP CONSTRAINT plans_free_trial_price,
        DROP CONSTRAINT plans_custom_pricing_type,
        DROP CONSTRAINT plans_feature_items_check,
        DROP CONSTRAINT plans_notes_length,
        DROP CONSTRAINT plans_cta_length,
        DROP CONSTRAINT plans_cycles_check,
        DROP CONSTRAINT plans_type_check,
        DROP CONSTRAINT plans_badge_check,
        ADD CONSTRAINT plans_badge_check CHECK (badge IN ('popular', 'recommended')),
        DROP COLUMN feature_items, DROP COLUMN admin_notes, DROP COLUMN cta_label,
        DROP COLUMN billing_cycles, DROP COLUMN allow_trial, DROP COLUMN plan_type`);
  }
}

/** The tenant → subscription trigger; `withPlan` adds the Free Trial plan snapshot. */
function trialTrigger(withPlan: boolean) {
  const snapshot = withPlan
    ? `(SELECT jsonb_build_object(
          'planId', p.id, 'code', p.code, 'name', p.name, 'currencyCode', trim(p.currency_code),
          'billingCycle', 'monthly', 'priceMinor', 0,
          'limits', jsonb_build_object('branches', p.max_branches, 'staff', p.max_staff,
                                       'ordersPerMonth', p.max_orders_per_month,
                                       'menuItems', p.max_menu_items, 'storageMb', p.max_storage_mb),
          'features', to_jsonb(p.features), 'featureFlags', p.feature_flags)
         FROM plans p
        WHERE p.plan_type = 'free_trial' AND p.is_active AND p.archived_at IS NULL)`
    : 'NULL';
  return `
    CREATE OR REPLACE FUNCTION tenants_create_subscription() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        prev text := current_setting('app.tenant_id', true);
      BEGIN
        PERFORM set_config('app.tenant_id', NEW.id::text, true);
        IF NEW.status = 'trial' THEN
          INSERT INTO subscriptions (tenant_id, status, current_period_start, current_period_end,
                                     trial_started_at, trial_ends_at, plan_snapshot)
          VALUES (NEW.id, 'trialing', NEW.created_at, NEW.trial_ends_at, NEW.created_at,
                  NEW.trial_ends_at, ${snapshot});
        ELSE
          INSERT INTO subscriptions (tenant_id, status, current_period_start)
          VALUES (NEW.id, 'active', NEW.created_at);
        END IF;
        PERFORM set_config('app.tenant_id', coalesce(prev, ''), true);
        RETURN NULL;
      END $$`;
}
