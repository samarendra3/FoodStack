import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes for the Phase 6 analytics queries (docs/PHASE_6_ANALYTICS_AUDIT.md §5). Every index
 * leads with tenant_id, matching row-level security.
 *
 * - Sales are recognised at completed_at, which had no index. The partial index covers only
 *   completed orders and INCLUDEs the money columns, so KPI and trend sums are index-only scans.
 * - Refunds are dated by their own created_at (refunds had only an order_id index).
 * - First-order lookups (new vs returning customers) read min(created_at) per customer; the
 *   previous orders_customer_idx had no created_at.
 *
 * The audit's candidate covering order_items index is not added: it would cost every order
 * insert, and its benefit has not been measured yet (the benchmark includes the comparison;
 * see apps/api/perf/results/phase6-analytics.md).
 *
 * Migrations run in a transaction, so these are plain CREATE INDEX. On a large production
 * database create them CONCURRENTLY by hand first (same names); this migration then no-ops.
 */
const INDEXES: [name: string, sql: string][] = [
  [
    'orders_branch_completed_idx',
    `orders (tenant_id, branch_id, completed_at)
       INCLUDE (subtotal_minor, discount_minor, tax_minor, total_minor, channel, customer_id)
       WHERE status = 'completed'`,
  ],
  [
    'refunds_tenant_created_idx',
    'refunds (tenant_id, created_at) INCLUDE (payment_id, amount_minor)',
  ],
  [
    'orders_customer_created_idx',
    `orders (tenant_id, customer_id, created_at) INCLUDE (branch_id, status)
       WHERE customer_id IS NOT NULL`,
  ],
];

export class AnalyticsIndexes1798000024000 implements MigrationInterface {
  name = 'AnalyticsIndexes1798000024000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [name, sql] of INDEXES) {
      await queryRunner.query(`CREATE INDEX IF NOT EXISTS ${name} ON ${sql}`);
    }
    // Superseded: the new index has the same leading columns plus created_at.
    await queryRunner.query('DROP INDEX IF EXISTS orders_customer_idx');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders (tenant_id, customer_id) WHERE customer_id IS NOT NULL`,
    );
    for (const [name] of INDEXES) await queryRunner.query(`DROP INDEX IF EXISTS ${name}`);
  }
}
