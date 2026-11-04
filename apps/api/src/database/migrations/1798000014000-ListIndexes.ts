import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes for the paged admin lists (search, filters and default sorts). Every index leads with
 * tenant_id, matching row-level security.
 */
const INDEXES: [name: string, sql: string][] = [
  ['orders_branch_status_created_idx', 'orders (tenant_id, branch_id, status, created_at DESC)'],
  ['orders_branch_channel_created_idx', 'orders (tenant_id, branch_id, channel, created_at DESC)'],
  [
    'payments_branch_method_created_idx',
    'payments (tenant_id, branch_id, method, created_at DESC)',
  ],
  ['customers_tenant_name_idx', 'customers (tenant_id, lower(name))'],
  [
    'menu_items_tenant_name_idx',
    'menu_items (tenant_id, restaurant_id, lower(name)) WHERE deleted_at IS NULL',
  ],
  [
    'inventory_movements_branch_created_idx',
    'inventory_movements (tenant_id, branch_id, created_at DESC)',
  ],
  [
    'promotions_tenant_created_idx',
    'promotions (tenant_id, restaurant_id, created_at DESC) WHERE deleted_at IS NULL',
  ],
];

export class ListIndexes1798000014000 implements MigrationInterface {
  name = 'ListIndexes1798000014000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [name, sql] of INDEXES) await queryRunner.query(`CREATE INDEX ${name} ON ${sql}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [name] of INDEXES) await queryRunner.query(`DROP INDEX ${name}`);
  }
}
