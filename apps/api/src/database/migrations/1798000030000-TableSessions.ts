import { MigrationInterface, QueryRunner } from 'typeorm';
import { disableTenantIsolation, enableTenantIsolation } from '../rls';

/**
 * Table sessions and QR guests.
 *
 * A table session is one sitting at a dining table (opened by the first QR scan or the first staff
 * order, closed by staff once everything is settled). Guests are the devices that scanned the
 * table's QR code during that sitting; the browser keeps a random token and we store only its
 * SHA-256 hash. Orders keep their own bill (total, payments, status) and now point at the session
 * and, for QR orders, the guest — so a guest's running balance is the sum of their open orders and
 * paid orders are never touched again.
 *
 * Backward compatible: both new order columns are nullable; existing orders are unaffected.
 */
export class TableSessions1798000030000 implements MigrationInterface {
  name = 'TableSessions1798000030000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE table_sessions (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        table_id uuid NOT NULL,
        status text NOT NULL DEFAULT 'open',
        opened_via text NOT NULL,
        opened_at timestamptz NOT NULL DEFAULT now(),
        closed_at timestamptz,
        closed_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT table_sessions_tenant_id_id_key UNIQUE (tenant_id, id),
        CONSTRAINT table_sessions_branch_fkey FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
        CONSTRAINT table_sessions_table_fkey FOREIGN KEY (tenant_id, table_id) REFERENCES dining_tables (tenant_id, id),
        CONSTRAINT table_sessions_status_check CHECK (status IN ('open', 'closed')),
        CONSTRAINT table_sessions_via_check CHECK (opened_via IN ('qr', 'staff')),
        CONSTRAINT table_sessions_closed_check CHECK ((status = 'closed') = (closed_at IS NOT NULL))
      )`);
    // At most one open sitting per table: concurrent first scans cannot create two.
    await q.query(
      `CREATE UNIQUE INDEX table_sessions_one_open ON table_sessions (tenant_id, table_id) WHERE status = 'open'`,
    );
    await q.query(
      `CREATE INDEX table_sessions_branch_idx ON table_sessions (tenant_id, branch_id, opened_at DESC)`,
    );

    await q.query(`
      CREATE TABLE table_guests (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL,
        session_id uuid NOT NULL,
        token_hash bytea NOT NULL,
        display_name text NOT NULL,
        guest_number integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT table_guests_tenant_id_id_key UNIQUE (tenant_id, id),
        CONSTRAINT table_guests_session_fkey FOREIGN KEY (tenant_id, session_id) REFERENCES table_sessions (tenant_id, id),
        CONSTRAINT table_guests_token_key UNIQUE (tenant_id, token_hash),
        CONSTRAINT table_guests_number_key UNIQUE (tenant_id, session_id, guest_number),
        CONSTRAINT table_guests_name_length CHECK (char_length(display_name) BETWEEN 1 AND 20)
      )`);

    await q.query(`ALTER TABLE orders ADD COLUMN table_session_id uuid, ADD COLUMN guest_id uuid`);
    await q.query(
      `ALTER TABLE orders ADD CONSTRAINT orders_table_session_fkey
         FOREIGN KEY (tenant_id, table_session_id) REFERENCES table_sessions (tenant_id, id)`,
    );
    await q.query(
      `ALTER TABLE orders ADD CONSTRAINT orders_guest_fkey FOREIGN KEY (tenant_id, guest_id) REFERENCES table_guests (tenant_id, id)`,
    );
    await q.query(
      `ALTER TABLE orders ADD CONSTRAINT orders_guest_needs_session CHECK (guest_id IS NULL OR table_session_id IS NOT NULL)`,
    );
    await q.query(
      `CREATE INDEX orders_table_session_idx ON orders (tenant_id, table_session_id) WHERE table_session_id IS NOT NULL`,
    );
    await q.query(
      `CREATE INDEX orders_guest_idx ON orders (tenant_id, guest_id) WHERE guest_id IS NOT NULL`,
    );

    for (const t of ['table_sessions', 'table_guests']) {
      await q.query(
        `CREATE TRIGGER ${t}_set_updated_at BEFORE UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,
      );
      await enableTenantIsolation(q, t);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX IF EXISTS orders_guest_idx');
    await q.query('DROP INDEX IF EXISTS orders_table_session_idx');
    await q.query('ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_guest_needs_session');
    await q.query('ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_guest_fkey');
    await q.query('ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_table_session_fkey');
    await q.query('ALTER TABLE orders DROP COLUMN guest_id, DROP COLUMN table_session_id');
    for (const t of ['table_guests', 'table_sessions']) {
      await disableTenantIsolation(q, t);
      await q.query(`DROP TABLE ${t}`);
    }
  }
}
