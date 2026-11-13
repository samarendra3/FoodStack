import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type Db, DbContext } from '../../core/db/db-context';
import { hasPermission } from '../auth/access';
import { AccessService } from '../auth/access.service';
import type { AuthContext, RequestMeta, TenantAccess } from '../auth/auth.types';
import { writeAudit } from '../auth/user-tokens';
import { type EventActor, OrderEventsService } from './order-events';

type Status = 'unassigned' | 'assigned' | 'accepted' | 'served' | 'reassigned' | 'cancelled';

interface AssignmentRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  order_id: string;
  waiter_user_id: string | null;
  status: Status;
}

const conflict = (code: string, message: string) => new ConflictException({ code, message });
const forbidden = (message: string) => new ForbiddenException({ code: 'FORBIDDEN', message });

/**
 * Who takes a ready order to the table.
 *
 * When the kitchen marks an order READY (in that same transaction) the order is assigned to an
 * eligible waiter of its branch: active member with `waiter:access` for the branch, **clocked
 * in at this branch**, and not a supervisor (`waiter:assign` holders assign, they are not
 * auto-assigned). The pick is workload-based: fewest open tasks (assigned + accepted) in the
 * branch, then the waiter who has waited longest since their last assignment. A per-branch
 * advisory lock serialises picks, and a partial unique index allows one open assignment per
 * order, so two concurrent "ready"s never double-assign. With nobody eligible the order goes to
 * the branch's UNASSIGNED queue, where any waiter can claim it and supervisors can assign it.
 */
@Injectable()
export class WaiterAssignmentsService {
  constructor(
    private readonly db: DbContext,
    private readonly access: AccessService,
    private readonly events: OrderEventsService,
  ) {}

  // ---- called from OrdersService inside its transaction ----

  async assignOnReady(
    db: Db,
    order: { id: string; tenant_id: string; branch_id: string },
    actor: EventActor,
  ) {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `waiter-assign:${order.tenant_id}:${order.branch_id}`,
    ]);
    const open = await db.one<{ id: string }>(
      `SELECT id FROM waiter_assignments
        WHERE order_id = $1 AND status IN ('unassigned', 'assigned', 'accepted')`,
      [order.id],
    );
    if (open) return; // already handed over (idempotent)
    const pick = await this.pickWaiter(db, order.branch_id, null);
    const row = await db.one<{ id: string }>(
      `INSERT INTO waiter_assignments (tenant_id, branch_id, order_id, waiter_user_id, status, assigned_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $4::uuid IS NULL THEN NULL ELSE now() END) RETURNING id`,
      [
        order.tenant_id,
        order.branch_id,
        order.id,
        pick?.user_id ?? null,
        pick ? 'assigned' : 'unassigned',
      ],
    );
    await this.emit(db, order, row!.id, pick ? 'waiter.assigned' : 'waiter.unassigned', actor, {
      waiterUserId: pick?.user_id ?? null,
      waiterName: pick?.full_name ?? null,
      auto: true,
    });
  }

  /** The order was served (by a waiter or the kitchen): close its open assignment. */
  async closeOnServed(db: Db, orderId: string, userId: string | null) {
    await db.query(
      `UPDATE waiter_assignments
          SET status = 'served', served_at = now(),
              waiter_user_id = coalesce(waiter_user_id, $2)
        WHERE order_id = $1 AND status IN ('unassigned', 'assigned', 'accepted')`,
      [orderId, userId],
    );
  }

  async closeOnCancelled(db: Db, orderId: string) {
    await db.query(
      `UPDATE waiter_assignments SET status = 'cancelled'
        WHERE order_id = $1 AND status IN ('unassigned', 'assigned', 'accepted')`,
      [orderId],
    );
  }

  /** Open assignment per order, for the pickup list. */
  async openFor(db: Db, orderIds: string[]) {
    const rows = await db.query<{
      id: string;
      order_id: string;
      status: Status;
      waiter_user_id: string | null;
      waiter_name: string | null;
      assigned_at: Date | null;
      accepted_at: Date | null;
      problem_note: string | null;
    }>(
      `SELECT a.id, a.order_id, a.status, a.waiter_user_id, u.full_name AS waiter_name,
              a.assigned_at, a.accepted_at, a.problem_note
         FROM waiter_assignments a LEFT JOIN users u ON u.id = a.waiter_user_id
        WHERE a.order_id = ANY($1::uuid[]) AND a.status IN ('unassigned', 'assigned', 'accepted')`,
      [orderIds],
    );
    return new Map(
      rows.map((r) => [
        r.order_id,
        {
          id: r.id,
          status: r.status as 'unassigned' | 'assigned' | 'accepted',
          waiterUserId: r.waiter_user_id,
          waiterName: r.waiter_name,
          assignedAt: r.assigned_at ? new Date(r.assigned_at).toISOString() : null,
          acceptedAt: r.accepted_at ? new Date(r.accepted_at).toISOString() : null,
          problemNote: r.problem_note,
        },
      ]),
    );
  }

  // ---- waiter / supervisor actions ----

  /** Waiter confirms they are taking it. */
  accept(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.act(auth, id, meta, async (db, a) => {
      if (a.status !== 'assigned' || a.waiter_user_id !== auth.userId)
        throw conflict('NOT_YOURS', 'Only the assigned waiter can accept this order.');
      await db.query(
        `UPDATE waiter_assignments SET status = 'accepted', accepted_at = now() WHERE id = $1`,
        [id],
      );
      return { type: 'waiter.accepted' as const, waiterUserId: auth.userId };
    });
  }

  /** Waiter takes an order from the unassigned queue. */
  claim(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.act(auth, id, meta, async (db, a) => {
      if (a.status !== 'unassigned')
        throw conflict('ALREADY_ASSIGNED', 'Someone else already took this order.');
      await db.query(
        `UPDATE waiter_assignments SET status = 'accepted', waiter_user_id = $2, assigned_by = $2,
                assigned_at = now(), accepted_at = now(), problem_note = NULL WHERE id = $1`,
        [id, auth.userId],
      );
      return { type: 'waiter.accepted' as const, waiterUserId: auth.userId, claimed: true };
    });
  }

  /** Waiter cannot serve it (e.g. busy, wrong table): back to the queue with a note. */
  problem(auth: AuthContext, id: string, note: string, meta: RequestMeta) {
    return this.act(auth, id, meta, async (db, a) => {
      if (!['assigned', 'accepted'].includes(a.status) || a.waiter_user_id !== auth.userId)
        throw conflict('NOT_YOURS', 'Only the assigned waiter can report a problem.');
      await this.requeue(db, a, note);
      return { type: 'waiter.unassigned' as const, problemNote: note, reportedBy: auth.userId };
    });
  }

  /** Supervisor assigns (or reassigns) to a specific waiter of the branch. */
  assign(auth: AuthContext, id: string, waiterUserId: string, meta: RequestMeta) {
    return this.act(
      auth,
      id,
      meta,
      async (db, a, access) => {
        if (!hasPermission(access, 'waiter:assign', { branchId: a.branch_id }))
          throw forbidden('You cannot assign orders in this branch.');
        const target = await this.pickWaiter(db, a.branch_id, waiterUserId, false);
        if (!target) throw conflict('NOT_A_WAITER', 'That person cannot serve at this branch.');
        // Close the current row and open a fresh one, so history shows each hand-over.
        if (a.status !== 'unassigned') {
          await db.query(`UPDATE waiter_assignments SET status = 'reassigned' WHERE id = $1`, [id]);
        } else {
          await db.query(`DELETE FROM waiter_assignments WHERE id = $1`, [id]);
        }
        const row = await db.one<{ id: string }>(
          `INSERT INTO waiter_assignments
             (tenant_id, branch_id, order_id, waiter_user_id, status, assigned_by, assigned_at)
           VALUES ($1, $2, $3, $4, 'assigned', $5, now()) RETURNING id`,
          [a.tenant_id, a.branch_id, a.order_id, waiterUserId, auth.userId],
        );
        return {
          type: 'waiter.assigned' as const,
          assignmentId: row!.id,
          waiterUserId,
          waiterName: target.full_name,
          auto: false,
        };
      },
      'any',
    );
  }

  /** Waiters a supervisor can pick from, with their open workload and clock-in state. */
  staff(auth: AuthContext, branchId: string) {
    return this.run(auth, async (db, access) => {
      if (!hasPermission(access, 'waiter:assign', { branchId }))
        throw forbidden('You cannot assign orders in this branch.');
      const rows = await this.candidates(db, branchId, false);
      return rows.map((r) => ({
        userId: r.user_id,
        name: r.full_name,
        clockedIn: r.clocked_in,
        openTasks: Number(r.open_tasks),
      }));
    });
  }

  /** The caller's own recent hand-overs (served / reassigned / cancelled), newest first. */
  history(auth: AuthContext, branchId: string) {
    return this.run(auth, async (db, access) => {
      if (!hasPermission(access, 'waiter:access', { branchId }))
        throw forbidden('You cannot view this branch.');
      const rows = await db.query<{
        id: string;
        order_id: string;
        order_number: number;
        table_label: string | null;
        status: Status;
        assigned_at: Date | null;
        served_at: Date | null;
      }>(
        `SELECT a.id, a.order_id, o.order_number, o.table_label, a.status, a.assigned_at, a.served_at
           FROM waiter_assignments a JOIN orders o ON o.id = a.order_id
          WHERE a.branch_id = $1 AND a.waiter_user_id = $2
            AND a.status IN ('served', 'reassigned', 'cancelled')
            AND a.created_at > now() - interval '24 hours'
          ORDER BY a.created_at DESC LIMIT 100`,
        [branchId, auth.userId],
      );
      return rows.map((r) => ({
        id: r.id,
        orderId: r.order_id,
        orderNumber: String(r.order_number),
        tableLabel: r.table_label,
        status: r.status,
        assignedAt: r.assigned_at ? new Date(r.assigned_at).toISOString() : null,
        servedAt: r.served_at ? new Date(r.served_at).toISOString() : null,
      }));
    });
  }

  // ---- helpers ----

  /**
   * Eligible waiters of a branch with their open task count. `autoOnly`: clocked in at this
   * branch and not a supervisor (used for automatic assignment).
   */
  private candidates(db: Db, branchId: string, autoOnly: boolean) {
    return db.query<{
      user_id: string;
      full_name: string;
      clocked_in: boolean;
      open_tasks: string;
      last_assigned: Date | null;
    }>(
      `WITH b AS (SELECT id, restaurant_id FROM branches WHERE id = $1),
       holders AS (
         SELECT m.user_id, p.code
           FROM tenant_memberships m
           JOIN user_role_assignments ra ON ra.membership_id = m.id
           JOIN role_permissions rp ON rp.role_id = ra.role_id
           JOIN permissions p ON p.id = rp.permission_id
           CROSS JOIN b
          WHERE m.status = 'active' AND p.code IN ('waiter:access', 'waiter:assign')
            AND (ra.scope_type = 'tenant'
                 OR (ra.scope_type = 'restaurant' AND ra.scope_id = b.restaurant_id)
                 OR (ra.scope_type = 'branch' AND ra.scope_id = b.id)))
       SELECT u.id AS user_id, u.full_name,
              EXISTS (SELECT 1 FROM attendance_entries e
                       WHERE e.user_id = u.id AND e.branch_id = $1 AND e.clock_out IS NULL) AS clocked_in,
              (SELECT count(*) FROM waiter_assignments w
                WHERE w.branch_id = $1 AND w.waiter_user_id = u.id
                  AND w.status IN ('assigned', 'accepted')) AS open_tasks,
              (SELECT max(w.assigned_at) FROM waiter_assignments w
                WHERE w.branch_id = $1 AND w.waiter_user_id = u.id) AS last_assigned
         FROM users u
        WHERE u.id IN (SELECT user_id FROM holders WHERE code = 'waiter:access')
          AND ($2::boolean = false OR u.id NOT IN (SELECT user_id FROM holders WHERE code = 'waiter:assign'))
        ORDER BY lower(u.full_name)`,
      [branchId, autoOnly],
    );
  }

  /** Auto: best eligible waiter (or null). With `userId`: that user if they can serve here. */
  private async pickWaiter(db: Db, branchId: string, userId: string | null, autoOnly = true) {
    const all = await this.candidates(db, branchId, autoOnly);
    if (userId) return all.find((c) => c.user_id === userId) ?? null;
    const ready = all.filter((c) => c.clocked_in);
    ready.sort(
      (a, b) =>
        Number(a.open_tasks) - Number(b.open_tasks) ||
        (a.last_assigned ? new Date(a.last_assigned).getTime() : 0) -
          (b.last_assigned ? new Date(b.last_assigned).getTime() : 0) ||
        a.user_id.localeCompare(b.user_id),
    );
    return ready[0] ?? null;
  }

  private async requeue(db: Db, a: AssignmentRow, note: string) {
    await db.query(
      `UPDATE waiter_assignments SET status = 'reassigned', problem_note = $2 WHERE id = $1`,
      [a.id, note],
    );
    await db.query(
      `INSERT INTO waiter_assignments (tenant_id, branch_id, order_id, status, problem_note)
       VALUES ($1, $2, $3, 'unassigned', $4)`,
      [a.tenant_id, a.branch_id, a.order_id, note],
    );
  }

  private async act(
    auth: AuthContext,
    id: string,
    meta: RequestMeta,
    work: (
      db: Db,
      a: AssignmentRow,
      access: TenantAccess,
    ) => Promise<
      { type: 'waiter.assigned' | 'waiter.accepted' | 'waiter.unassigned' } & Record<
        string,
        unknown
      >
    >,
    who: 'waiter' | 'any' = 'waiter',
  ) {
    return this.run(auth, async (db, access) => {
      const a = await db.one<AssignmentRow>(
        `SELECT id, tenant_id, branch_id, order_id, waiter_user_id, status
           FROM waiter_assignments WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Task not found.' });
      if (who === 'waiter' && !hasPermission(access, 'waiter:access', { branchId: a.branch_id }))
        throw forbidden('You cannot serve in this branch.');
      if (!['unassigned', 'assigned', 'accepted'].includes(a.status))
        throw conflict('TASK_CLOSED', 'This order has already been handled.');
      const { type, assignmentId, ...payload } = await work(db, a, access);
      await writeAudit(db, {
        tenantId: a.tenant_id,
        actorUserId: auth.userId,
        actorSessionId: auth.sessionId,
        actorAudience: 'tenant',
        action: type,
        entityType: 'order',
        entityId: a.order_id,
        metadata: { assignmentId: assignmentId ?? id, ...payload },
        ...meta,
      });
      await this.emit(
        db,
        { id: a.order_id, tenant_id: a.tenant_id, branch_id: a.branch_id },
        (assignmentId as string | undefined) ?? id,
        type,
        { kind: 'staff', userId: auth.userId },
        payload,
      );
      return { id: (assignmentId as string | undefined) ?? id, orderId: a.order_id, ...payload };
    });
  }

  private emit(
    db: Db,
    order: { id: string; tenant_id: string; branch_id: string },
    assignmentId: string,
    type: 'waiter.assigned' | 'waiter.accepted' | 'waiter.unassigned',
    actor: EventActor,
    payload: Record<string, unknown>,
  ) {
    return this.events.record(db, {
      tenantId: order.tenant_id,
      branchId: order.branch_id,
      orderId: order.id,
      type,
      payload: { assignmentId, ...payload },
      actor,
    });
  }

  private run<T>(auth: AuthContext, work: (db: Db, access: TenantAccess) => Promise<T>) {
    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, async (db) =>
      work(db, await this.access.forRequest(db, auth)),
    );
  }
}
