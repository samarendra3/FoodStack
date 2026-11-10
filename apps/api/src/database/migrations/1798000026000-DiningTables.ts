import { MigrationInterface, QueryRunner } from 'typeorm';
import { disableTenantIsolation, enableTenantIsolation } from '../rls';

/**
 * A branch's dining tables, grouped by area (Ground floor, Terrace, ...). Orders keep the table's
 * label (orders.table_label), so live status is "open orders at this branch with this label".
 * Deleted tables are soft-deleted so a label can be reused afterwards.
 */
export class DiningTables1798000026000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE dining_tables (
        id uuid NOT NULL DEFAULT uuidv7(),
        tenant_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        area text NOT NULL DEFAULT 'Main area',
        label text NOT NULL,
        seats integer NOT NULL DEFAULT 4,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz,
        CONSTRAINT dining_tables_pkey PRIMARY KEY (id),
        CONSTRAINT dining_tables_tenant_id_id_key UNIQUE (tenant_id, id),
        CONSTRAINT dining_tables_branch_fkey FOREIGN KEY (tenant_id, branch_id)
          REFERENCES branches (tenant_id, id),
        CONSTRAINT dining_tables_label_length CHECK (char_length(label) BETWEEN 1 AND 20),
        CONSTRAINT dining_tables_area_length CHECK (char_length(area) BETWEEN 1 AND 40),
        CONSTRAINT dining_tables_seats_range CHECK (seats BETWEEN 1 AND 50)
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX dining_tables_branch_label_key
         ON dining_tables (tenant_id, branch_id, lower(label)) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE TRIGGER dining_tables_set_updated_at BEFORE UPDATE ON dining_tables
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,
    );
    // Live status looks up open orders by branch and table label.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS orders_open_table_idx
         ON orders (tenant_id, branch_id, table_label) WHERE status = 'open'`,
    );
    await enableTenantIsolation(queryRunner, 'dining_tables');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS orders_open_table_idx');
    await disableTenantIsolation(queryRunner, 'dining_tables');
    await queryRunner.query('DROP TABLE dining_tables');
  }
}
