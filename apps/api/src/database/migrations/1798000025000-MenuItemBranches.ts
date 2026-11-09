import { MigrationInterface, QueryRunner } from 'typeorm';
import { disableTenantIsolation, enableTenantIsolation } from '../rls';

/**
 * Which branches sell a menu item (e.g. a café branch with its own items). An item with no rows
 * here is sold at every branch of its restaurant, so existing menus keep working unchanged.
 */
export class MenuItemBranches1798000025000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE menu_item_branches (
        tenant_id uuid NOT NULL,
        menu_item_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        CONSTRAINT menu_item_branches_pkey PRIMARY KEY (tenant_id, menu_item_id, branch_id),
        CONSTRAINT menu_item_branches_item_fkey FOREIGN KEY (tenant_id, menu_item_id)
          REFERENCES menu_items (tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT menu_item_branches_branch_fkey FOREIGN KEY (tenant_id, branch_id)
          REFERENCES branches (tenant_id, id) ON DELETE CASCADE
      )`);
    await queryRunner.query(
      'CREATE INDEX menu_item_branches_branch_idx ON menu_item_branches (tenant_id, branch_id)',
    );
    await enableTenantIsolation(queryRunner, 'menu_item_branches');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await disableTenantIsolation(queryRunner, 'menu_item_branches');
    await queryRunner.query('DROP TABLE menu_item_branches');
  }
}
