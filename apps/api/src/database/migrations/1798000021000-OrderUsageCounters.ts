import { MigrationInterface, QueryRunner } from 'typeorm';
import { disableTenantIsolation, enableTenantIsolation } from '../rls';

/**
 * Monthly order counter per tenant (docs/PERFORMANCE_AUDIT.md F1).
 *
 * Before: every order creation counted all of the tenant's orders this month (O(m) rows under
 * an advisory lock). Now one row per (tenant, month) holds the count of non-cancelled orders:
 *
 * - Creating an order reserves a slot with one atomic statement
 *   `INSERT … ON CONFLICT DO UPDATE SET orders = orders + 1 WHERE orders + 1 <= limit`.
 *   The counter row's lock serializes concurrent creations for the tenant, so the limit can
 *   never be exceeded, and a failed order rolls the reservation back with its transaction.
 * - Cancelling an order releases the slot of the month it was created in.
 * - The month follows the order's restaurant time zone, as the previous count did.
 *
 * The backfill counts existing non-cancelled orders, so current usage is preserved.
 */
export class OrderUsageCounters1798000021000 implements MigrationInterface {
  name = 'OrderUsageCounters1798000021000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE tenant_usage_counters (
        tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
        period date NOT NULL,
        orders integer NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, period),
        CONSTRAINT tenant_usage_counters_period_check CHECK (period = date_trunc('month', period)::date),
        CONSTRAINT tenant_usage_counters_orders_check CHECK (orders >= 0)
      )`);
    await enableTenantIsolation(queryRunner, 'tenant_usage_counters');
    await queryRunner.query(
      `CREATE POLICY platform_access ON tenant_usage_counters USING (app_is_platform()) WITH CHECK (app_is_platform())`,
    );
    // Platform scope for the backfill (FORCE ROW LEVEL SECURITY applies to the owner too).
    await queryRunner.query(`SELECT set_config('app.platform', 'on', true)`);
    await queryRunner.query(`
      INSERT INTO tenant_usage_counters (tenant_id, period, orders)
      SELECT o.tenant_id, date_trunc('month', o.created_at AT TIME ZONE r.timezone)::date, count(*)
        FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.status <> 'cancelled'
       GROUP BY 1, 2`);
    await queryRunner.query(`SELECT set_config('app.platform', '', true)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP POLICY platform_access ON tenant_usage_counters');
    await disableTenantIsolation(queryRunner, 'tenant_usage_counters');
    await queryRunner.query('DROP TABLE tenant_usage_counters');
  }
}
