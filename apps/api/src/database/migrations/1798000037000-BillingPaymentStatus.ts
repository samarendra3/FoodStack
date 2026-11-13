import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 7: billing desk and reconciliation.
 *
 * - `orders.payment_status`: a STORED generated column, so the payment state machine is
 *   derived in exactly one place from the money columns and can never drift from them:
 *     cancelled | pending | partially_paid | paid | partially_refunded | refunded
 *   (the order's own status — open / completed / cancelled — stays separate).
 * - `payments.client_request_id`: idempotency for counter payments — a retried or
 *   double-tapped "Collect" with the same key returns the first result instead of charging
 *   twice. Unique per tenant.
 * Reversible.
 */
export class BillingPaymentStatus1798000037000 implements MigrationInterface {
  name = 'BillingPaymentStatus1798000037000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE orders ADD COLUMN payment_status text GENERATED ALWAYS AS (
        CASE
          WHEN status = 'cancelled' THEN 'cancelled'
          WHEN paid_minor = 0 THEN 'pending'
          WHEN refunded_minor > 0 AND refunded_minor >= paid_minor THEN 'refunded'
          WHEN refunded_minor > 0 THEN 'partially_refunded'
          WHEN paid_minor < total_minor THEN 'partially_paid'
          ELSE 'paid'
        END) STORED`);
    await q.query(`
      CREATE INDEX orders_branch_payment_status_idx
        ON orders (tenant_id, branch_id, payment_status, created_at DESC)`);
    await q.query(`ALTER TABLE payments ADD COLUMN client_request_id text`);
    await q.query(`
      ALTER TABLE payments ADD CONSTRAINT payments_client_request_length
        CHECK (char_length(client_request_id) BETWEEN 8 AND 80)`);
    await q.query(`
      CREATE UNIQUE INDEX payments_client_request_key ON payments (tenant_id, client_request_id)
        WHERE client_request_id IS NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX payments_client_request_key');
    await q.query(
      'ALTER TABLE payments DROP CONSTRAINT payments_client_request_length, DROP COLUMN client_request_id',
    );
    await q.query('DROP INDEX orders_branch_payment_status_idx');
    await q.query('ALTER TABLE orders DROP COLUMN payment_status');
  }
}
