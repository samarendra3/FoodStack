import { MigrationInterface, QueryRunner } from 'typeorm';
import { disableTenantIsolation, enableTenantIsolation } from '../rls';

/**
 * Subscription lifecycle: every tenant has exactly one `subscriptions` row from the moment it is
 * created, and that row is the single source of truth for access (see EntitlementService).
 *
 * - Statuses: trialing, active, expired, pending_payment, past_due, suspended, cancelled.
 *   Trials have no plan; `current_period_end` is the trial end. A NULL period end on an active
 *   row means a complimentary (non-expiring) account, used for tenants that pre-date billing.
 * - New tenants get a 15-day trial from the database clock (BEFORE INSERT sets trial_ends_at,
 *   AFTER INSERT creates the trialing subscription), whichever code path creates them.
 * - subscription_events: append-only status history (expiry, payment, admin actions).
 * - subscription_invoices gain payment-gateway fields; payment_webhook_events de-duplicates
 *   gateway webhooks so replays are harmless.
 */
export class SubscriptionLifecycle1798000016000 implements MigrationInterface {
  name = 'SubscriptionLifecycle1798000016000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE subscriptions
        DROP CONSTRAINT subscriptions_status_check,
        DROP CONSTRAINT subscriptions_cancelled_check,
        DROP CONSTRAINT subscriptions_period_check,
        ALTER COLUMN plan_id DROP NOT NULL,
        ALTER COLUMN billing_cycle DROP NOT NULL,
        ALTER COLUMN current_period_end DROP NOT NULL,
        ALTER COLUMN status DROP DEFAULT,
        ADD COLUMN trial_started_at timestamptz,
        ADD COLUMN trial_ends_at timestamptz,
        ADD COLUMN status_changed_at timestamptz NOT NULL DEFAULT now(),
        ADD COLUMN status_reason text,
        ADD CONSTRAINT subscriptions_status_check CHECK (status IN
          ('trialing', 'active', 'expired', 'pending_payment', 'past_due', 'suspended', 'cancelled')),
        ADD CONSTRAINT subscriptions_cancelled_check CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL),
        ADD CONSTRAINT subscriptions_period_check
          CHECK (current_period_end IS NULL OR current_period_end > current_period_start),
        ADD CONSTRAINT subscriptions_trialing_check
          CHECK (status <> 'trialing' OR (trial_ends_at IS NOT NULL AND current_period_end IS NOT NULL)),
        ADD CONSTRAINT subscriptions_paid_plan_check
          CHECK (status IN ('trialing', 'expired', 'pending_payment', 'suspended') OR plan_id IS NOT NULL
                 OR current_period_end IS NULL),
        ADD CONSTRAINT subscriptions_reason_length CHECK (char_length(status_reason) <= 300)`);
    await queryRunner.query(
      `CREATE INDEX subscriptions_status_end_idx ON subscriptions (status, current_period_end)`,
    );
    // The row now exists for every tenant, so it must not block removing a tenant (the product
    // never deletes tenants; this keeps test fixtures and manual cleanup working).
    await queryRunner.query(`
      ALTER TABLE subscriptions
        DROP CONSTRAINT subscriptions_tenant_id_fkey,
        ADD CONSTRAINT subscriptions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE`);

    // Backfill: tenants without a subscription get one mirroring their current state.
    await queryRunner.query(`
      INSERT INTO subscriptions (tenant_id, status, current_period_start, current_period_end,
                                 trial_started_at, trial_ends_at)
      SELECT t.id,
             CASE WHEN t.status = 'trial' THEN
                    CASE WHEN coalesce(t.trial_ends_at, t.created_at + interval '15 days') > now()
                         THEN 'trialing' ELSE 'expired' END
                  ELSE 'active' END,
             t.created_at,
             CASE WHEN t.status = 'trial' THEN coalesce(t.trial_ends_at, t.created_at + interval '15 days') END,
             CASE WHEN t.status = 'trial' THEN t.created_at END,
             CASE WHEN t.status = 'trial' THEN coalesce(t.trial_ends_at, t.created_at + interval '15 days') END
        FROM tenants t
       WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id = t.id)`);
    // Rows that existed before keep their paid state; mark ended paid periods as expired.
    await queryRunner.query(`
      UPDATE subscriptions SET status = 'expired'
       WHERE status IN ('active', 'cancelled') AND current_period_end IS NOT NULL AND current_period_end <= now()`);

    await queryRunner.query(`
      CREATE FUNCTION tenants_default_trial() RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NEW.status = 'trial' AND NEW.trial_ends_at IS NULL THEN
            NEW.trial_ends_at = now() + interval '15 days';
          END IF;
          RETURN NEW;
        END $$`);
    await queryRunner.query(`
      CREATE TRIGGER tenants_default_trial BEFORE INSERT ON tenants
        FOR EACH ROW EXECUTE FUNCTION tenants_default_trial()`);

    // Runs in the new tenant's scope for the one insert, then restores the caller's scope.
    await queryRunner.query(`
      CREATE FUNCTION tenants_create_subscription() RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        DECLARE
          prev text := current_setting('app.tenant_id', true);
        BEGIN
          PERFORM set_config('app.tenant_id', NEW.id::text, true);
          IF NEW.status = 'trial' THEN
            INSERT INTO subscriptions (tenant_id, status, current_period_start, current_period_end,
                                       trial_started_at, trial_ends_at)
            VALUES (NEW.id, 'trialing', NEW.created_at, NEW.trial_ends_at, NEW.created_at, NEW.trial_ends_at);
          ELSE
            INSERT INTO subscriptions (tenant_id, status, current_period_start)
            VALUES (NEW.id, 'active', NEW.created_at);
          END IF;
          PERFORM set_config('app.tenant_id', coalesce(prev, ''), true);
          RETURN NULL;
        END $$`);
    await queryRunner.query(`
      CREATE TRIGGER tenants_create_subscription AFTER INSERT ON tenants
        FOR EACH ROW EXECUTE FUNCTION tenants_create_subscription()`);

    await queryRunner.query(`
      CREATE TABLE subscription_events (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
        subscription_id uuid NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
        event text NOT NULL,
        from_status text,
        to_status text,
        invoice_id uuid REFERENCES subscription_invoices (id) ON DELETE CASCADE,
        actor_user_id uuid REFERENCES users (id),
        reason text,
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT subscription_events_event_format CHECK (event ~ '^[a-z_]{2,40}$'),
        CONSTRAINT subscription_events_reason_length CHECK (char_length(reason) <= 300)
      )`);
    await queryRunner.query(
      `CREATE INDEX subscription_events_tenant_idx ON subscription_events (tenant_id, created_at DESC)`,
    );

    await queryRunner.query(`
      ALTER TABLE subscription_invoices
        DROP CONSTRAINT subscription_invoices_method_check,
        ADD CONSTRAINT subscription_invoices_method_check
          CHECK (payment_method IN ('bank_transfer', 'upi', 'card', 'cash', 'other', 'online')),
        ADD COLUMN gateway text,
        ADD COLUMN gateway_order_id text,
        ADD COLUMN gateway_payment_id text,
        ADD COLUMN failure_reason text,
        ADD COLUMN failed_at timestamptz,
        ADD CONSTRAINT subscription_invoices_gateway_check CHECK (gateway IN ('razorpay')),
        ADD CONSTRAINT subscription_invoices_failure_length CHECK (char_length(failure_reason) <= 300)`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX subscription_invoices_gateway_order_key
        ON subscription_invoices (gateway, gateway_order_id) WHERE gateway_order_id IS NOT NULL`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX subscription_invoices_gateway_payment_key
        ON subscription_invoices (gateway, gateway_payment_id) WHERE gateway_payment_id IS NOT NULL`);

    await queryRunner.query(`
      CREATE TABLE payment_webhook_events (
        gateway text NOT NULL,
        event_id text NOT NULL,
        event_type text NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (gateway, event_id),
        CONSTRAINT payment_webhook_events_id_length CHECK (char_length(event_id) <= 100)
      )`);
    await queryRunner.query(`ALTER TABLE payment_webhook_events ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE payment_webhook_events FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(
      `CREATE POLICY platform_access ON payment_webhook_events USING (app_is_platform()) WITH CHECK (app_is_platform())`,
    );

    await enableTenantIsolation(queryRunner, 'subscription_events');
    await queryRunner.query(
      `CREATE POLICY platform_access ON subscription_events USING (app_is_platform()) WITH CHECK (app_is_platform())`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP POLICY platform_access ON subscription_events');
    await disableTenantIsolation(queryRunner, 'subscription_events');
    await queryRunner.query('DROP TABLE subscription_events');
    await queryRunner.query('DROP TABLE payment_webhook_events');
    await queryRunner.query('DROP TRIGGER tenants_create_subscription ON tenants');
    await queryRunner.query('DROP FUNCTION tenants_create_subscription()');
    await queryRunner.query('DROP TRIGGER tenants_default_trial ON tenants');
    await queryRunner.query('DROP FUNCTION tenants_default_trial()');
    await queryRunner.query('DROP INDEX subscription_invoices_gateway_payment_key');
    await queryRunner.query('DROP INDEX subscription_invoices_gateway_order_key');
    await queryRunner.query(
      `UPDATE subscription_invoices SET payment_method = 'other' WHERE payment_method = 'online'`,
    );
    await queryRunner.query(`
      ALTER TABLE subscription_invoices
        DROP CONSTRAINT subscription_invoices_failure_length,
        DROP CONSTRAINT subscription_invoices_gateway_check,
        DROP COLUMN failed_at, DROP COLUMN failure_reason, DROP COLUMN gateway_payment_id,
        DROP COLUMN gateway_order_id, DROP COLUMN gateway,
        DROP CONSTRAINT subscription_invoices_method_check,
        ADD CONSTRAINT subscription_invoices_method_check
          CHECK (payment_method IN ('bank_transfer', 'upi', 'card', 'cash', 'other'))`);
    await queryRunner.query('DROP INDEX subscriptions_status_end_idx');
    await queryRunner.query(`
      ALTER TABLE subscriptions
        DROP CONSTRAINT subscriptions_tenant_id_fkey,
        ADD CONSTRAINT subscriptions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id)`);
    // Only paid subscriptions existed before this migration.
    await queryRunner.query(
      `DELETE FROM subscriptions WHERE plan_id IS NULL OR current_period_end IS NULL`,
    );
    await queryRunner.query(`
      UPDATE subscriptions SET status = CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE 'active' END`);
    await queryRunner.query(`
      ALTER TABLE subscriptions
        DROP CONSTRAINT subscriptions_reason_length,
        DROP CONSTRAINT subscriptions_paid_plan_check,
        DROP CONSTRAINT subscriptions_trialing_check,
        DROP CONSTRAINT subscriptions_period_check,
        DROP CONSTRAINT subscriptions_cancelled_check,
        DROP CONSTRAINT subscriptions_status_check,
        DROP COLUMN status_reason, DROP COLUMN status_changed_at,
        DROP COLUMN trial_ends_at, DROP COLUMN trial_started_at,
        ALTER COLUMN status SET DEFAULT 'active',
        ALTER COLUMN current_period_end SET NOT NULL,
        ALTER COLUMN billing_cycle SET NOT NULL,
        ALTER COLUMN plan_id SET NOT NULL,
        ADD CONSTRAINT subscriptions_status_check CHECK (status IN ('active', 'cancelled')),
        ADD CONSTRAINT subscriptions_cancelled_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
        ADD CONSTRAINT subscriptions_period_check CHECK (current_period_end > current_period_start)`);
  }
}
