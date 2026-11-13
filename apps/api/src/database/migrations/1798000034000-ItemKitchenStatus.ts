import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 4: item-level kitchen status and one workflow for every order source.
 *
 * - `order_items.kitchen_status` (pending → preparing → ready) and `ready_at`. An order becomes
 *   READY only when every active line is ready; the order-level buttons still work (they move
 *   all lines at once).
 * - `order_items.station_id`: nullable placeholder for kitchen-station routing (a later phase
 *   adds the stations table and the FK). Nothing reads it yet.
 * - Workflow is NEW → PREPARING → READY → SERVED for QR, waiter and POS orders alike; the manual
 *   Accept step is retired. `accepted` stays a valid stored value so history (audit, events,
 *   reports) remains readable, but open accepted orders are moved to preparing here.
 *
 * Backfill: lines of ready/served orders are ready, lines of preparing orders are preparing.
 * Reversible (`down` drops the columns; it does not restore 'accepted' on moved orders).
 */
export class ItemKitchenStatus1798000034000 implements MigrationInterface {
  name = 'ItemKitchenStatus1798000034000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE order_items
        ADD COLUMN kitchen_status text NOT NULL DEFAULT 'pending',
        ADD COLUMN ready_at timestamptz,
        ADD COLUMN station_id uuid,
        ADD CONSTRAINT order_items_kitchen_status_check
          CHECK (kitchen_status IN ('pending', 'preparing', 'ready')),
        ADD CONSTRAINT order_items_ready_at_check
          CHECK ((kitchen_status = 'ready') = (ready_at IS NOT NULL))`);
    await q.query(
      `UPDATE orders SET kitchen_status = 'preparing', kitchen_updated_at = now()
        WHERE kitchen_status = 'accepted'`,
    );
    await q.query(`
      UPDATE order_items i SET kitchen_status = 'ready', ready_at = o.kitchen_updated_at
        FROM orders o WHERE o.id = i.order_id AND o.kitchen_status IN ('ready', 'served')`);
    await q.query(`
      UPDATE order_items i SET kitchen_status = 'preparing'
        FROM orders o WHERE o.id = i.order_id AND o.kitchen_status = 'preparing'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE order_items
        DROP CONSTRAINT order_items_ready_at_check,
        DROP CONSTRAINT order_items_kitchen_status_check,
        DROP COLUMN station_id, DROP COLUMN ready_at, DROP COLUMN kitchen_status`);
  }
}
