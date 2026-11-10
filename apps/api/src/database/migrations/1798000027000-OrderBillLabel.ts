import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Separate bills at one table (e.g. two parties sharing a 4-seater): each order carries the bill
 * it belongs to ("A", "B", or a guest name). NULL = the table's only bill, as before.
 */
export class OrderBillLabel1798000027000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE orders ADD COLUMN bill_label text`);
    await queryRunner.query(
      `ALTER TABLE orders ADD CONSTRAINT orders_bill_label_length
         CHECK (bill_label IS NULL OR char_length(bill_label) BETWEEN 1 AND 20)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE orders DROP CONSTRAINT orders_bill_label_length');
    await queryRunner.query('ALTER TABLE orders DROP COLUMN bill_label');
  }
}
