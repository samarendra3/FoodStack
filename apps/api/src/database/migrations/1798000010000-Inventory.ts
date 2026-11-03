import { MigrationInterface, QueryRunner } from 'typeorm';
import { disableTenantIsolation, enableTenantIsolation } from '../rls';

/**
 * Inventory: a restaurant-wide list of stock items (ingredients, packaging, drinks…), the
 * quantity on hand per branch, and an append-only movement ledger explaining every change.
 * Quantities are numeric(14,3) in the item's unit; cost is minor units per unit.
 *
 * Adds `inventory:read` and `inventory:manage` (granted per scope like every permission: a
 * branch manager manages stock for their branch only).
 */
const PERMISSIONS: ReadonlyArray<[code: string, description: string, roles: string[]]> = [
  [
    'inventory:read',
    'View stock items and levels',
    [
      'owner',
      'restaurant_admin',
      'branch_manager',
      'accountant',
      'kitchen_manager',
      'inventory_manager',
      'purchase_manager',
    ],
  ],
  [
    'inventory:manage',
    'Manage stock items and record stock movements',
    ['owner', 'restaurant_admin', 'branch_manager', 'inventory_manager'],
  ],
];

const UNITS = `('kg', 'g', 'l', 'ml', 'pcs', 'pack', 'box', 'dozen')`;

export class Inventory1798000010000 implements MigrationInterface {
  name = 'Inventory1798000010000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE inventory_items (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL,
        restaurant_id uuid NOT NULL,
        name text NOT NULL,
        category text,
        unit text NOT NULL,
        low_stock_threshold numeric(14,3) NOT NULL DEFAULT 0,
        cost_per_unit_minor bigint,
        currency_code char(3) NOT NULL,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by uuid,
        updated_by uuid,
        version integer NOT NULL DEFAULT 1,
        deleted_at timestamptz,
        CONSTRAINT inventory_items_tenant_id_id_key UNIQUE (tenant_id, id),
        CONSTRAINT inventory_items_restaurant_fkey FOREIGN KEY (tenant_id, restaurant_id)
          REFERENCES restaurants (tenant_id, id),
        CONSTRAINT inventory_items_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
        CONSTRAINT inventory_items_category_length CHECK (char_length(category) <= 40),
        CONSTRAINT inventory_items_unit_check CHECK (unit IN ${UNITS}),
        CONSTRAINT inventory_items_threshold_check CHECK (low_stock_threshold >= 0),
        CONSTRAINT inventory_items_cost_check CHECK (cost_per_unit_minor BETWEEN 0 AND 100000000)
      )`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX inventory_items_restaurant_name_key
        ON inventory_items (tenant_id, restaurant_id, lower(name)) WHERE deleted_at IS NULL`);

    await queryRunner.query(`
      CREATE TABLE inventory_stock (
        tenant_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        item_id uuid NOT NULL,
        quantity numeric(14,3) NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT inventory_stock_pkey PRIMARY KEY (tenant_id, branch_id, item_id),
        CONSTRAINT inventory_stock_branch_fkey FOREIGN KEY (tenant_id, branch_id)
          REFERENCES branches (tenant_id, id),
        CONSTRAINT inventory_stock_item_fkey FOREIGN KEY (tenant_id, item_id)
          REFERENCES inventory_items (tenant_id, id),
        CONSTRAINT inventory_stock_quantity_check CHECK (quantity >= 0)
      )`);

    await queryRunner.query(`
      CREATE TABLE inventory_movements (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        item_id uuid NOT NULL,
        type text NOT NULL,
        quantity_delta numeric(14,3) NOT NULL,
        quantity_after numeric(14,3) NOT NULL,
        note text,
        created_at timestamptz NOT NULL DEFAULT now(),
        created_by uuid,
        CONSTRAINT inventory_movements_branch_fkey FOREIGN KEY (tenant_id, branch_id)
          REFERENCES branches (tenant_id, id),
        CONSTRAINT inventory_movements_item_fkey FOREIGN KEY (tenant_id, item_id)
          REFERENCES inventory_items (tenant_id, id),
        CONSTRAINT inventory_movements_type_check
          CHECK (type IN ('purchase', 'usage', 'wastage', 'count')),
        CONSTRAINT inventory_movements_after_check CHECK (quantity_after >= 0),
        CONSTRAINT inventory_movements_note_length CHECK (char_length(note) <= 200)
      )`);
    await queryRunner.query(`
      CREATE INDEX inventory_movements_item_idx
        ON inventory_movements (tenant_id, item_id, branch_id, created_at DESC)`);

    for (const table of ['inventory_items', 'inventory_stock', 'inventory_movements']) {
      await enableTenantIsolation(queryRunner, table);
    }
    // The ledger is append-only for the app role.
    await queryRunner.query('REVOKE UPDATE, DELETE ON inventory_movements FROM foodstack_app');

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
    for (const table of ['inventory_movements', 'inventory_stock', 'inventory_items']) {
      await disableTenantIsolation(queryRunner, table);
      await queryRunner.query(`DROP TABLE ${table}`);
    }
  }
}
