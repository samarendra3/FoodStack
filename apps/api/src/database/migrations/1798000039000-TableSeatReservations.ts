import { MigrationInterface, QueryRunner } from 'typeorm';
import { disableTenantIsolation, enableTenantIsolation } from '../rls';

/**
 * Seat reservations: how many seats each QR group holds at a table.
 * One active reservation per guest. Capacity is enforced here too (trigger), so no code path
 * can overbook a table, even if the application check were skipped.
 */
export class TableSeatReservations1798000039000 implements MigrationInterface {
  name = 'TableSeatReservations1798000039000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE table_seat_reservations (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        table_id uuid NOT NULL,
        session_id uuid NOT NULL,
        guest_id uuid NOT NULL,
        seats integer NOT NULL,
        status text NOT NULL DEFAULT 'active',
        request_id text,
        released_at timestamptz,
        released_by uuid,
        release_reason text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT table_seat_reservations_tenant_id_id_key UNIQUE (tenant_id, id),
        CONSTRAINT tsr_branch_fkey FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
        CONSTRAINT tsr_table_fkey FOREIGN KEY (tenant_id, table_id) REFERENCES dining_tables (tenant_id, id),
        CONSTRAINT tsr_session_fkey FOREIGN KEY (tenant_id, session_id) REFERENCES table_sessions (tenant_id, id),
        CONSTRAINT tsr_guest_fkey FOREIGN KEY (tenant_id, guest_id) REFERENCES table_guests (tenant_id, id),
        CONSTRAINT tsr_seats_range CHECK (seats BETWEEN 1 AND 50),
        CONSTRAINT tsr_status_check CHECK (status IN ('active', 'released')),
        CONSTRAINT tsr_reason_check CHECK (release_reason IS NULL OR release_reason IN ('guest_settled', 'session_closed', 'staff_cleared')),
        CONSTRAINT tsr_released_check CHECK ((status = 'released') = (released_at IS NOT NULL))
      )`);
    // One active reservation per guest: a repeated request can never double-book.
    await q.query(
      `CREATE UNIQUE INDEX tsr_one_active_per_guest ON table_seat_reservations (tenant_id, guest_id) WHERE status = 'active'`,
    );
    // Same request id from the same table = same reservation (retry safety).
    await q.query(
      `CREATE UNIQUE INDEX tsr_request_key ON table_seat_reservations (tenant_id, table_id, request_id) WHERE request_id IS NOT NULL`,
    );
    // Occupancy sum per table.
    await q.query(
      `CREATE INDEX tsr_active_table_idx ON table_seat_reservations (tenant_id, table_id) INCLUDE (seats) WHERE status = 'active'`,
    );
    await q.query(
      `CREATE INDEX tsr_session_idx ON table_seat_reservations (tenant_id, session_id)`,
    );

    // Defence in depth: serialize on the table row and refuse to exceed its seats.
    await q.query(`
      CREATE FUNCTION table_seat_reservations_capacity() RETURNS trigger AS $$
      DECLARE cap integer; used integer;
      BEGIN
        IF NEW.status <> 'active' THEN RETURN NEW; END IF;
        SELECT seats INTO cap FROM dining_tables
          WHERE tenant_id = NEW.tenant_id AND id = NEW.table_id FOR UPDATE;
        SELECT coalesce(sum(seats), 0) INTO used FROM table_seat_reservations
          WHERE tenant_id = NEW.tenant_id AND table_id = NEW.table_id
            AND status = 'active' AND id <> NEW.id;
        IF used + NEW.seats > cap THEN
          RAISE EXCEPTION 'TABLE_FULL' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await q.query(`
      CREATE TRIGGER table_seat_reservations_capacity_trg
        BEFORE INSERT OR UPDATE OF seats, status ON table_seat_reservations
        FOR EACH ROW EXECUTE FUNCTION table_seat_reservations_capacity()`);
    await q.query(
      `CREATE TRIGGER table_seat_reservations_set_updated_at BEFORE UPDATE ON table_seat_reservations FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,
    );
    await enableTenantIsolation(q, 'table_seat_reservations');
  }

  public async down(q: QueryRunner): Promise<void> {
    await disableTenantIsolation(q, 'table_seat_reservations');
    await q.query('DROP TABLE table_seat_reservations');
    await q.query('DROP FUNCTION IF EXISTS table_seat_reservations_capacity()');
  }
}
