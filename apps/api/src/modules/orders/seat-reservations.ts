import { ConflictException, Injectable } from '@nestjs/common';
import type { Db } from '../../core/db/db-context';

export interface Availability {
  capacity: number;
  occupied: number;
  available: number;
}

export type ReleaseReason = 'guest_settled' | 'session_closed' | 'staff_cleared';

/**
 * Seat reservations: one active row per QR group, holding `seats` of the table's capacity.
 * Occupancy is always computed from active rows, never stored.
 */
@Injectable()
export class SeatReservationsService {
  /** Same lock as openTableSession: concurrent scans of one table queue up here. */
  async lockTable(db: Db, tenantId: string, tableId: string) {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `table-session:${tenantId}:${tableId}`,
    ]);
  }

  async availability(db: Db, tableId: string): Promise<Availability | null> {
    const t = await db.one<{ seats: number }>(
      'SELECT seats FROM dining_tables WHERE id = $1 AND deleted_at IS NULL',
      [tableId],
    );
    if (!t) return null;
    const o = await db.one<{ used: number }>(
      `SELECT coalesce(sum(seats), 0)::int AS used FROM table_seat_reservations
        WHERE table_id = $1 AND status = 'active'`,
      [tableId],
    );
    const occupied = o!.used;
    return { capacity: t.seats, occupied, available: Math.max(t.seats - occupied, 0) };
  }

  /**
   * Locks the table, then throws TABLE_FULL or NOT_ENOUGH_SEATS. Call this BEFORE any session,
   * guest, cart or order is created for the party.
   */
  async assertRoom(db: Db, tenantId: string, tableId: string, party: number) {
    await this.lockTable(db, tenantId, tableId);
    const a = await this.availability(db, tableId);
    if (!a) throw new ConflictException({ code: 'TABLE_NOT_FOUND', message: 'Table not found.' });
    if (a.available === 0) {
      throw new ConflictException({
        code: 'TABLE_FULL',
        message: 'This table is full right now. Please ask our staff for another table.',
        ...a,
      });
    }
    if (party > a.available) {
      throw new ConflictException({
        code: 'NOT_ENOUGH_SEATS',
        message: `Only ${a.available} seat${a.available === 1 ? '' : 's'} left at this table.`,
        ...a,
      });
    }
    return a;
  }

  async reserve(
    db: Db,
    r: {
      tenantId: string;
      branchId: string;
      tableId: string;
      sessionId: string;
      guestId: string;
      seats: number;
      requestId?: string | null;
    },
  ) {
    await db.query(
      `INSERT INTO table_seat_reservations
         (tenant_id, branch_id, table_id, session_id, guest_id, seats, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [r.tenantId, r.branchId, r.tableId, r.sessionId, r.guestId, r.seats, r.requestId ?? null],
    );
  }

  /** Idempotent: only rows that are still active change. */
  releaseGuest(db: Db, guestId: string, reason: ReleaseReason, by: string | null) {
    return db.query(
      `UPDATE table_seat_reservations
          SET status = 'released', released_at = now(), release_reason = $2, released_by = $3
        WHERE guest_id = $1 AND status = 'active'`,
      [guestId, reason, by],
    );
  }

  releaseSession(db: Db, sessionId: string, reason: ReleaseReason, by: string | null) {
    return db.query(
      `UPDATE table_seat_reservations
          SET status = 'released', released_at = now(), release_reason = $2, released_by = $3
        WHERE session_id = $1 AND status = 'active'`,
      [sessionId, reason, by],
    );
  }
}
