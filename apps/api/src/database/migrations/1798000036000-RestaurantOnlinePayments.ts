import { MigrationInterface, QueryRunner } from 'typeorm';
import { disableTenantIsolation, enableTenantIsolation } from '../rls';

/**
 * Phase 6: customer online payments into the RESTAURANT's own payment-gateway account.
 *
 * - `restaurant_payment_accounts`: one connected gateway account per restaurant (Razorpay
 *   today; `provider` keeps it open for others). Key secret and webhook secret are stored
 *   encrypted (AES-256-GCM, bytea); `webhook_key` is a random public id that routes the
 *   restaurant's webhook URL to its account without exposing the tenant.
 * - `payment_intents`: one online payment attempt for an order — amount decided by the server,
 *   gateway order id, status. At most one live (`created`) intent per order.
 * - `gateway_events`: every webhook event id seen per provider (unique), so retried / duplicate
 *   deliveries are processed once.
 * - `payments`: method `online` plus `gateway`, `gateway_payment_id` (unique per gateway: the
 *   same captured payment can never be recorded twice) and the intent that produced it.
 *
 * RLS: tenant isolation; accounts and events also allow platform scope (the webhook endpoint
 * resolves the account before it knows the tenant). Reversible.
 */
export class RestaurantOnlinePayments1798000036000 implements MigrationInterface {
  name = 'RestaurantOnlinePayments1798000036000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE restaurant_payment_accounts (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
        restaurant_id uuid NOT NULL,
        provider text NOT NULL,
        key_id text NOT NULL,
        key_secret_enc bytea NOT NULL,
        webhook_secret_enc bytea NOT NULL,
        webhook_key text NOT NULL,
        mode text NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        verified_at timestamptz,
        last_webhook_at timestamptz,
        created_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT rpa_restaurant_fkey FOREIGN KEY (tenant_id, restaurant_id)
          REFERENCES restaurants (tenant_id, id),
        CONSTRAINT rpa_one_per_restaurant UNIQUE (tenant_id, restaurant_id),
        CONSTRAINT rpa_webhook_key_key UNIQUE (webhook_key),
        CONSTRAINT rpa_provider_check CHECK (provider IN ('razorpay')),
        CONSTRAINT rpa_mode_check CHECK (mode IN ('test', 'live')),
        CONSTRAINT rpa_key_id_length CHECK (char_length(key_id) BETWEEN 8 AND 64)
      )`);
    await q.query(
      `CREATE TRIGGER rpa_set_updated_at BEFORE UPDATE ON restaurant_payment_accounts
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,
    );

    await q.query(`
      CREATE TABLE payment_intents (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL,
        order_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        account_id uuid NOT NULL REFERENCES restaurant_payment_accounts (id),
        provider text NOT NULL,
        gateway_order_id text NOT NULL,
        amount_minor bigint NOT NULL,
        currency_code char(3) NOT NULL,
        status text NOT NULL DEFAULT 'created',
        guest_id uuid,
        created_by uuid,
        gateway_payment_id text,
        failure_reason text,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT payment_intents_tenant_id_id_key UNIQUE (tenant_id, id),
        CONSTRAINT payment_intents_order_fkey FOREIGN KEY (tenant_id, order_id)
          REFERENCES orders (tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT payment_intents_gateway_order_key UNIQUE (provider, gateway_order_id),
        CONSTRAINT payment_intents_amount_check CHECK (amount_minor > 0),
        CONSTRAINT payment_intents_status_check
          CHECK (status IN ('created', 'paid', 'failed', 'expired', 'cancelled', 'needs_review')),
        CONSTRAINT payment_intents_reason_length CHECK (char_length(failure_reason) <= 300)
      )`);
    await q.query(`
      CREATE UNIQUE INDEX payment_intents_one_live ON payment_intents (tenant_id, order_id)
        WHERE status = 'created'`);
    await q.query(
      `CREATE INDEX payment_intents_order_idx ON payment_intents (tenant_id, order_id)`,
    );
    await q.query(
      `CREATE TRIGGER payment_intents_set_updated_at BEFORE UPDATE ON payment_intents
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,
    );

    await q.query(`
      CREATE TABLE gateway_events (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
        provider text NOT NULL,
        event_id text NOT NULL,
        type text NOT NULL,
        result text NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT gateway_events_event_key UNIQUE (provider, event_id),
        CONSTRAINT gateway_events_result_length CHECK (char_length(result) <= 100)
      )`);

    await q.query(`ALTER TABLE payments DROP CONSTRAINT payments_method_check`);
    await q.query(`
      ALTER TABLE payments
        ADD CONSTRAINT payments_method_check CHECK (method IN ('cash', 'card', 'upi', 'online')),
        ADD COLUMN gateway text,
        ADD COLUMN gateway_payment_id text,
        ADD COLUMN payment_intent_id uuid,
        ADD CONSTRAINT payments_gateway_presence
          CHECK ((method = 'online') = (gateway IS NOT NULL AND gateway_payment_id IS NOT NULL))`);
    await q.query(`
      CREATE UNIQUE INDEX payments_gateway_payment_key ON payments (gateway, gateway_payment_id)
        WHERE gateway_payment_id IS NOT NULL`);

    await enableTenantIsolation(q, 'payment_intents');
    for (const t of ['restaurant_payment_accounts', 'gateway_events']) {
      await q.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      await q.query(`
        CREATE POLICY tenant_or_platform ON ${t}
          USING (tenant_id = app_current_tenant() OR app_is_platform())
          WITH CHECK (tenant_id = app_current_tenant() OR app_is_platform())`);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX payments_gateway_payment_key');
    await q.query(`
      ALTER TABLE payments DROP CONSTRAINT payments_gateway_presence,
        DROP COLUMN payment_intent_id, DROP COLUMN gateway_payment_id, DROP COLUMN gateway,
        DROP CONSTRAINT payments_method_check`);
    await q.query(
      `ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK (method IN ('cash', 'card', 'upi'))`,
    );
    await disableTenantIsolation(q, 'payment_intents');
    await q.query('DROP TABLE gateway_events');
    await q.query('DROP TABLE payment_intents');
    await q.query('DROP TABLE restaurant_payment_accounts');
  }
}
