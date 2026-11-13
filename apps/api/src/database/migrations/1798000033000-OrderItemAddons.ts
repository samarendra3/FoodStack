import { MigrationInterface, QueryRunner } from 'typeorm';
import { disableTenantIsolation, enableTenantIsolation } from '../rls';

/**
 * Phase 3: add-ons on order lines.
 *
 * `order_item_addons` is an immutable snapshot of the add-on options chosen for one order line
 * (group and option name, price at the time of ordering), so later menu edits never change a
 * placed order or its bill. The line's `unit_price_minor` already includes the add-on prices, so
 * every existing money rule (line total = unit price × quantity, order totals) is unchanged; this
 * table is the breakdown shown on tickets, bills and invoices.
 *
 * Additive and reversible. `order_items` gains (tenant_id, id) uniqueness for the composite FK.
 */
export class OrderItemAddons1798000033000 implements MigrationInterface {
  name = 'OrderItemAddons1798000033000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE order_items ADD CONSTRAINT order_items_tenant_id_id_key UNIQUE (tenant_id, id)`,
    );
    await q.query(`
      CREATE TABLE order_item_addons (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL,
        order_id uuid NOT NULL,
        order_item_id uuid NOT NULL,
        option_id uuid,
        group_name text NOT NULL,
        name text NOT NULL,
        price_minor bigint NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT order_item_addons_item_fkey FOREIGN KEY (tenant_id, order_item_id)
          REFERENCES order_items (tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT order_item_addons_order_fkey FOREIGN KEY (tenant_id, order_id)
          REFERENCES orders (tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT order_item_addons_price_check CHECK (price_minor >= 0),
        CONSTRAINT order_item_addons_name_length
          CHECK (char_length(name) BETWEEN 1 AND 60 AND char_length(group_name) BETWEEN 1 AND 60)
      )`);
    await q.query(
      `CREATE INDEX order_item_addons_item_idx ON order_item_addons (tenant_id, order_item_id)`,
    );
    await q.query(
      `CREATE INDEX order_item_addons_order_idx ON order_item_addons (tenant_id, order_id)`,
    );
    await enableTenantIsolation(q, 'order_item_addons');
  }

  public async down(q: QueryRunner): Promise<void> {
    await disableTenantIsolation(q, 'order_item_addons');
    await q.query('DROP TABLE order_item_addons');
    await q.query('ALTER TABLE order_items DROP CONSTRAINT order_items_tenant_id_id_key');
  }
}
