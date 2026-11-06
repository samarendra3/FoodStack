import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-restaurant monthly order counters (docs/PHASE_3_PERFORMANCE_REPORT.md §3).
 *
 * Phase 2 kept one counter per tenant and month, with the month taken from each order's
 * restaurant time zone but displayed in the first restaurant's. Restaurants in different time
 * zones therefore shared rows around month boundaries. Now each restaurant has its own row per
 * month in its own time zone; a tenant's usage this month is the sum over its restaurants of
 * each one's current month. The plan limit still applies to the whole tenant.
 *
 * The composite key (tenant_id, restaurant_id) references restaurants, so a counter can never
 * point at another tenant's restaurant. Rows are rebuilt from orders (non-cancelled), so usage
 * is exact after the migration.
 */
export class PerRestaurantUsage1798000022000 implements MigrationInterface {
  name = 'PerRestaurantUsage1798000022000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SELECT set_config('app.platform', 'on', true)`);
    await queryRunner.query('DELETE FROM tenant_usage_counters');
    await queryRunner.query(`
      ALTER TABLE tenant_usage_counters
        DROP CONSTRAINT tenant_usage_counters_pkey,
        ADD COLUMN restaurant_id uuid NOT NULL,
        ADD CONSTRAINT tenant_usage_counters_pkey PRIMARY KEY (tenant_id, restaurant_id, period),
        ADD CONSTRAINT tenant_usage_counters_restaurant_fkey FOREIGN KEY (tenant_id, restaurant_id)
          REFERENCES restaurants (tenant_id, id) ON DELETE CASCADE`);
    await queryRunner.query(`
      INSERT INTO tenant_usage_counters (tenant_id, restaurant_id, period, orders)
      SELECT o.tenant_id, o.restaurant_id, date_trunc('month', o.created_at AT TIME ZONE r.timezone)::date,
             count(*)
        FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.status <> 'cancelled'
       GROUP BY 1, 2, 3`);
    await queryRunner.query(`SELECT set_config('app.platform', '', true)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SELECT set_config('app.platform', 'on', true)`);
    await queryRunner.query(`
      CREATE TEMP TABLE usage_rollup ON COMMIT DROP AS
        SELECT tenant_id, period, sum(orders)::int AS orders FROM tenant_usage_counters
         GROUP BY tenant_id, period`);
    await queryRunner.query('DELETE FROM tenant_usage_counters');
    await queryRunner.query(`
      ALTER TABLE tenant_usage_counters
        DROP CONSTRAINT tenant_usage_counters_restaurant_fkey,
        DROP CONSTRAINT tenant_usage_counters_pkey,
        DROP COLUMN restaurant_id,
        ADD CONSTRAINT tenant_usage_counters_pkey PRIMARY KEY (tenant_id, period)`);
    await queryRunner.query(
      `INSERT INTO tenant_usage_counters (tenant_id, period, orders) SELECT tenant_id, period, orders FROM usage_rollup`,
    );
    await queryRunner.query(`SELECT set_config('app.platform', '', true)`);
  }
}
