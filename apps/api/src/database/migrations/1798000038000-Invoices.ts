import { MigrationInterface, QueryRunner } from 'typeorm';
import { disableTenantIsolation, enableTenantIsolation } from '../rls';

/**
 * Phase 8: GST tax invoices.
 *
 * - `invoice_series`: one consecutive counter per branch per Indian financial year (Apr–Mar).
 *   Numbers are allocated in the same transaction that issues the invoice, so a rolled-back
 *   issue never consumes a number and the series has no gaps (GST rule 46: consecutive serial
 *   number, unique within the financial year, at most 16 characters).
 * - `invoices`: one per order bill (unique per order — issuing is idempotent), with an
 *   immutable JSON snapshot of everything printed (seller, GSTIN, items, tax split, payments),
 *   so later edits to the menu or the restaurant profile never change an issued invoice. The PDF
 *   is rendered from the snapshot (`pdf_key` is filled when stored, Phase 9).
 * Tenant RLS. Reversible.
 */
export class Invoices1798000038000 implements MigrationInterface {
  name = 'Invoices1798000038000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE invoice_series (
        tenant_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        financial_year text NOT NULL,
        last_number integer NOT NULL,
        PRIMARY KEY (tenant_id, branch_id, financial_year),
        CONSTRAINT invoice_series_branch_fkey FOREIGN KEY (tenant_id, branch_id)
          REFERENCES branches (tenant_id, id),
        CONSTRAINT invoice_series_fy_format CHECK (financial_year ~ '^[0-9]{2}-[0-9]{2}$'),
        CONSTRAINT invoice_series_positive CHECK (last_number > 0)
      )`);
    await q.query(`
      CREATE TABLE invoices (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL,
        restaurant_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        order_id uuid NOT NULL,
        invoice_number text NOT NULL,
        financial_year text NOT NULL,
        series_number integer NOT NULL,
        issued_at timestamptz NOT NULL DEFAULT now(),
        total_minor bigint NOT NULL,
        customer_phone text,
        snapshot jsonb NOT NULL,
        pdf_key text,
        created_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT invoices_tenant_id_id_key UNIQUE (tenant_id, id),
        CONSTRAINT invoices_one_per_order UNIQUE (tenant_id, order_id),
        CONSTRAINT invoices_number_key UNIQUE (tenant_id, restaurant_id, financial_year, invoice_number),
        CONSTRAINT invoices_order_fkey FOREIGN KEY (tenant_id, order_id)
          REFERENCES orders (tenant_id, id),
        CONSTRAINT invoices_branch_fkey FOREIGN KEY (tenant_id, branch_id)
          REFERENCES branches (tenant_id, id),
        CONSTRAINT invoices_number_length CHECK (char_length(invoice_number) BETWEEN 1 AND 16),
        CONSTRAINT invoices_number_chars CHECK (invoice_number ~ '^[A-Za-z0-9/-]+$')
      )`);
    await q.query(
      `CREATE INDEX invoices_branch_issued_idx ON invoices (tenant_id, branch_id, issued_at DESC)`,
    );
    await enableTenantIsolation(q, 'invoice_series');
    await enableTenantIsolation(q, 'invoices');
  }

  public async down(q: QueryRunner): Promise<void> {
    await disableTenantIsolation(q, 'invoices');
    await disableTenantIsolation(q, 'invoice_series');
    await q.query('DROP TABLE invoices');
    await q.query('DROP TABLE invoice_series');
  }
}
