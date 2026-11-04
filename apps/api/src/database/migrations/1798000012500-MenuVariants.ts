import { MigrationInterface, QueryRunner } from 'typeorm';
import { disableTenantIsolation, enableTenantIsolation } from '../rls';

/**
 * Portions / sizes of a menu item (e.g. Full and Half), each with its own price. An item without
 * variants sells at menu_items.price_minor; an item with variants must be ordered as one of them,
 * and menu_items.price_minor then mirrors its first (default) variant.
 */
export class MenuVariants1798000012500 implements MigrationInterface {
  name = 'MenuVariants1798000012500';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE menu_item_variants (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL,
        menu_item_id uuid NOT NULL,
        name text NOT NULL,
        price_minor bigint NOT NULL,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz,
        CONSTRAINT menu_item_variants_tenant_id_id_key UNIQUE (tenant_id, id),
        CONSTRAINT menu_item_variants_item_fkey FOREIGN KEY (tenant_id, menu_item_id)
          REFERENCES menu_items (tenant_id, id),
        CONSTRAINT menu_item_variants_name_length CHECK (char_length(name) BETWEEN 1 AND 30),
        CONSTRAINT menu_item_variants_price_range CHECK (price_minor BETWEEN 0 AND 100000000)
      )`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX menu_item_variants_item_name_key
        ON menu_item_variants (tenant_id, menu_item_id, lower(name)) WHERE deleted_at IS NULL`);
    await enableTenantIsolation(queryRunner, 'menu_item_variants');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await disableTenantIsolation(queryRunner, 'menu_item_variants');
    await queryRunner.query('DROP TABLE menu_item_variants');
  }
}
