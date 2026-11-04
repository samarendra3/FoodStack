import { MigrationInterface, QueryRunner } from 'typeorm';
import { disableTenantIsolation, enableTenantIsolation } from '../rls';

/**
 * Restaurant menu: categories and items, owned by one restaurant (every branch of it sells the
 * same menu). Prices are minor units in the restaurant's currency. Both tables soft-delete so
 * past orders can keep pointing at an item that was later removed.
 *
 * Adds `menu:read` (POS, waiter, kitchen and managers need the menu) and `menu:manage`.
 */
const PERMISSIONS: ReadonlyArray<[code: string, description: string, roles: string[]]> = [
  [
    'menu:read',
    'View the menu',
    [
      'owner',
      'restaurant_admin',
      'branch_manager',
      'accountant',
      'cashier',
      'waiter',
      'kitchen_manager',
      'kitchen_staff',
    ],
  ],
  ['menu:manage', 'Create and edit menu categories and items', ['owner', 'restaurant_admin']],
];

export class Menu1798000009000 implements MigrationInterface {
  name = 'Menu1798000009000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE menu_categories (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL,
        restaurant_id uuid NOT NULL,
        name text NOT NULL,
        sort_order integer NOT NULL DEFAULT 0,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by uuid,
        updated_by uuid,
        version integer NOT NULL DEFAULT 1,
        deleted_at timestamptz,
        CONSTRAINT menu_categories_tenant_id_id_key UNIQUE (tenant_id, id),
        CONSTRAINT menu_categories_restaurant_fkey FOREIGN KEY (tenant_id, restaurant_id)
          REFERENCES restaurants (tenant_id, id),
        CONSTRAINT menu_categories_name_length CHECK (char_length(name) BETWEEN 1 AND 60)
      )`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX menu_categories_restaurant_name_key
        ON menu_categories (tenant_id, restaurant_id, lower(name)) WHERE deleted_at IS NULL`);

    await queryRunner.query(`
      CREATE TABLE menu_items (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL,
        restaurant_id uuid NOT NULL,
        category_id uuid NOT NULL,
        name text NOT NULL,
        description text,
        price_minor bigint NOT NULL,
        currency_code char(3) NOT NULL,
        diet text NOT NULL,
        image_url text,
        is_available boolean NOT NULL DEFAULT true,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by uuid,
        updated_by uuid,
        version integer NOT NULL DEFAULT 1,
        deleted_at timestamptz,
        CONSTRAINT menu_items_tenant_id_id_key UNIQUE (tenant_id, id),
        CONSTRAINT menu_items_restaurant_fkey FOREIGN KEY (tenant_id, restaurant_id)
          REFERENCES restaurants (tenant_id, id),
        CONSTRAINT menu_items_category_fkey FOREIGN KEY (tenant_id, category_id)
          REFERENCES menu_categories (tenant_id, id),
        CONSTRAINT menu_items_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
        CONSTRAINT menu_items_description_length CHECK (char_length(description) <= 300),
        CONSTRAINT menu_items_price_range CHECK (price_minor BETWEEN 0 AND 100000000),
        CONSTRAINT menu_items_diet_check CHECK (diet IN ('veg', 'non_veg', 'egg')),
        CONSTRAINT menu_items_image_url_length CHECK (char_length(image_url) <= 500)
      )`);
    await queryRunner.query(`
      CREATE INDEX menu_items_tenant_category_idx
        ON menu_items (tenant_id, category_id) WHERE deleted_at IS NULL`);
    await queryRunner.query(`
      CREATE INDEX menu_items_tenant_restaurant_idx
        ON menu_items (tenant_id, restaurant_id, sort_order) WHERE deleted_at IS NULL`);

    await enableTenantIsolation(queryRunner, 'menu_categories');
    await enableTenantIsolation(queryRunner, 'menu_items');

    for (const [code, description, roles] of PERMISSIONS) {
      await queryRunner.query(
        `INSERT INTO permissions (code, audience, description) VALUES ($1, 'tenant', $2)
         ON CONFLICT (code) DO NOTHING`,
        [code, description],
      );
      await queryRunner.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = $1
          WHERE r.tenant_id IS NULL AND r.is_system AND r.code = ANY($2::text[])
         ON CONFLICT DO NOTHING`,
        [code, roles],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const codes = PERMISSIONS.map(([code]) => code);
    await queryRunner.query(
      `DELETE FROM role_permissions WHERE permission_id IN (
         SELECT id FROM permissions WHERE code = ANY($1::text[]))`,
      [codes],
    );
    await queryRunner.query('DELETE FROM permissions WHERE code = ANY($1::text[])', [codes]);
    await disableTenantIsolation(queryRunner, 'menu_items');
    await disableTenantIsolation(queryRunner, 'menu_categories');
    await queryRunner.query('DROP TABLE menu_items');
    await queryRunner.query('DROP TABLE menu_categories');
  }
}
