import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 2: secret per-table QR links, guest contact/consent, payment choice.
 *
 * - `dining_tables.qr_key`: random secret carried in the table's QR link (`?k=`). A new guest can
 *   join a table only with the current key, so an old photo or a shared link stops working once
 *   the key is rotated. Existing tables get a random key (gen_random_uuid: 122 random bits).
 * - `restaurants.qr_legacy_links`: while true, links without a key (the QR codes printed before
 *   this change) still work. Existing restaurants start with it ON so nothing printed breaks;
 *   they switch it off after reprinting. New restaurants start with it OFF.
 * - `table_guests.phone / receipt_consent / marketing_consent / consent_at`: optional; used only
 *   for transactional receipts unless marketing was explicitly allowed.
 * - `orders.payment_preference`: how the guest said they will pay (counter cash / card; online
 *   is added with the payment phase). Informational for the bill; payment status is unchanged.
 */
export class SecureQrAndGuestDetails1798000032000 implements MigrationInterface {
  name = 'SecureQrAndGuestDetails1798000032000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE dining_tables
        ADD COLUMN qr_key text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', ''),
        ADD COLUMN qr_rotated_at timestamptz,
        ADD CONSTRAINT dining_tables_qr_key_length CHECK (char_length(qr_key) BETWEEN 16 AND 64)`);

    await q.query(
      `ALTER TABLE restaurants ADD COLUMN qr_legacy_links boolean NOT NULL DEFAULT false`,
    );
    await q.query(`UPDATE restaurants SET qr_legacy_links = true`);

    await q.query(`
      ALTER TABLE table_guests
        ADD COLUMN phone text,
        ADD COLUMN receipt_consent boolean NOT NULL DEFAULT false,
        ADD COLUMN marketing_consent boolean NOT NULL DEFAULT false,
        ADD COLUMN consent_at timestamptz,
        ADD CONSTRAINT table_guests_phone_format CHECK (phone ~ '^\\+[1-9][0-9]{7,14}$')`);

    await q.query(`
      ALTER TABLE orders
        ADD COLUMN payment_preference text,
        ADD CONSTRAINT orders_payment_preference_check
          CHECK (payment_preference IN ('counter_cash', 'counter_card', 'online'))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE orders DROP CONSTRAINT orders_payment_preference_check, DROP COLUMN payment_preference`,
    );
    await q.query(`
      ALTER TABLE table_guests DROP CONSTRAINT table_guests_phone_format,
        DROP COLUMN consent_at, DROP COLUMN marketing_consent, DROP COLUMN receipt_consent,
        DROP COLUMN phone`);
    await q.query(`ALTER TABLE restaurants DROP COLUMN qr_legacy_links`);
    await q.query(`
      ALTER TABLE dining_tables DROP CONSTRAINT dining_tables_qr_key_length,
        DROP COLUMN qr_rotated_at, DROP COLUMN qr_key`);
  }
}
