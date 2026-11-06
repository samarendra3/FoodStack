import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Online payment sessions on subscription invoices.
 *
 * - checkout_started_at: when the owner last opened the gateway for this invoice.
 * - 'expired': an online checkout abandoned for longer than the session window. The request
 *   stops blocking new ones (one pending invoice per tenant) and the history is kept. A payment
 *   the gateway later confirms for it is still applied (money is never lost).
 * - A failed attempt is not a status: the invoice stays pending (retry allowed) with
 *   failure_reason / failed_at set, shown as "Payment failed".
 * - Super Admins may read role assignments (read-only) to show each restaurant's owner.
 */
export class PaymentSessions1798000020000 implements MigrationInterface {
  name = 'PaymentSessions1798000020000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE subscription_invoices
        ADD COLUMN checkout_started_at timestamptz,
        ADD COLUMN expired_at timestamptz,
        DROP CONSTRAINT subscription_invoices_status_check,
        ADD CONSTRAINT subscription_invoices_status_check
          CHECK (status IN ('pending', 'paid', 'cancelled', 'refunded', 'expired')),
        ADD CONSTRAINT subscription_invoices_expired_check
          CHECK ((status = 'expired') = (expired_at IS NOT NULL))`);
    // Existing gateway orders count as started when they were created.
    await queryRunner.query(
      `UPDATE subscription_invoices SET checkout_started_at = created_at WHERE gateway_order_id IS NOT NULL`,
    );
    await queryRunner.query(`
      CREATE INDEX subscription_invoices_open_checkout_idx ON subscription_invoices (checkout_started_at)
        WHERE status = 'pending' AND gateway_order_id IS NOT NULL`);
    await queryRunner.query(
      `CREATE POLICY platform_read ON user_role_assignments FOR SELECT USING (app_is_platform())`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP POLICY platform_read ON user_role_assignments');
    await queryRunner.query('DROP INDEX subscription_invoices_open_checkout_idx');
    await queryRunner.query(
      `UPDATE subscription_invoices SET status = 'cancelled', cancelled_at = coalesce(cancelled_at, expired_at)
        WHERE status = 'expired'`,
    );
    await queryRunner.query(`
      ALTER TABLE subscription_invoices
        DROP CONSTRAINT subscription_invoices_expired_check,
        DROP CONSTRAINT subscription_invoices_status_check,
        ADD CONSTRAINT subscription_invoices_status_check
          CHECK (status IN ('pending', 'paid', 'cancelled', 'refunded')),
        DROP COLUMN expired_at, DROP COLUMN checkout_started_at`);
  }
}
