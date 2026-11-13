import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { z } from 'zod';
import { type Db, DbContext } from '../../core/db/db-context';
import { hasPermission } from '../auth/access';
import { AccessService } from '../auth/access.service';
import type { AuthContext, RequestMeta, TenantAccess } from '../auth/auth.types';
import { writeAudit } from '../auth/user-tokens';

export const PAYMENT_STATUSES = [
  'pending',
  'partially_paid',
  'paid',
  'partially_refunded',
  'refunded',
  'cancelled',
] as const;

export const billingListSchema = z.strictObject({
  branchId: z.uuid(),
  /** Comma-separated payment statuses; default: the open desk (pending, partially paid). */
  paymentStatus: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : ['pending', 'partially_paid']))
    .pipe(z.array(z.enum(PAYMENT_STATUSES)).min(1).max(6)),
  /** Local calendar day (YYYY-MM-DD) in the branch timezone; default today. */
  date: z.iso.date().optional(),
  q: z.string().trim().max(40).optional(),
});
export const reconciliationSchema = z.strictObject({
  branchId: z.uuid(),
  date: z.iso.date().optional(),
});
export const resolveSchema = z.strictObject({
  note: z.string().trim().min(3).max(200),
});

const forbidden = (m: string) => new ForbiddenException({ code: 'FORBIDDEN', message: m });
const DAY = `(($2::date)::timestamp AT TIME ZONE b.timezone)`;

/**
 * The billing counter: what is owed now, what was collected today and whether it all adds up.
 * Read access: POS staff (cashiers) and order readers of the branch. Resolving an online
 * payment that needs review: refund permission.
 */
@Injectable()
export class BillingDeskService {
  constructor(
    private readonly db: DbContext,
    private readonly access: AccessService,
  ) {}

  /** Bills of one branch and local day, filtered by payment status, with totals per status. */
  list(auth: AuthContext, q: z.infer<typeof billingListSchema>) {
    return this.run(auth, async (db, access) => {
      this.require(access, q.branchId, ['pos:access', 'order:read']);
      const date = q.date ?? (await this.today(db, q.branchId));
      const term = q.q ? `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
      const rows = await db.query<{
        id: string;
        order_number: number;
        channel: string;
        table_label: string | null;
        bill_label: string | null;
        status: string;
        payment_status: string;
        kitchen_status: string;
        payment_preference: string | null;
        subtotal_minor: string;
        discount_minor: string;
        tax_minor: string;
        total_minor: string;
        paid_minor: string;
        refunded_minor: string;
        currency_code: string;
        created_at: Date;
        customer_name: string | null;
        customer_phone: string | null;
        methods: string[] | null;
        needs_review: boolean;
      }>(
        `SELECT o.id, o.order_number, o.channel, o.table_label, o.bill_label, o.status,
                o.payment_status, o.kitchen_status, o.payment_preference, o.subtotal_minor,
                o.discount_minor, o.tax_minor, o.total_minor, o.paid_minor, o.refunded_minor,
                o.currency_code, o.created_at,
                coalesce(c.name, g.display_name) AS customer_name,
                coalesce(c.phone, g.phone) AS customer_phone,
                (SELECT array_agg(DISTINCT p.method) FROM payments p WHERE p.order_id = o.id) AS methods,
                EXISTS (SELECT 1 FROM payment_intents i
                         WHERE i.order_id = o.id AND i.status = 'needs_review') AS needs_review
           FROM orders o
           JOIN branches b ON b.id = o.branch_id
           LEFT JOIN customers c ON c.id = o.customer_id
           LEFT JOIN table_guests g ON g.id = o.guest_id
          WHERE o.branch_id = $1
            AND o.created_at >= ${DAY} AND o.created_at < ${DAY} + interval '1 day'
            AND o.payment_status = ANY($3::text[])
            AND ($4::text IS NULL OR o.table_label ILIKE $4 OR o.bill_label ILIKE $4
                 OR o.order_number::text = $5 OR c.phone ILIKE $4 OR g.phone ILIKE $4)
          ORDER BY (o.payment_status IN ('pending', 'partially_paid')) DESC, o.created_at DESC
          LIMIT 300`,
        [q.branchId, date, q.paymentStatus, term, q.q ?? ''],
      );
      const totals = await db.query<{
        payment_status: string;
        n: number;
        total: string;
        due: string;
      }>(
        `SELECT o.payment_status, count(*)::int AS n, sum(o.total_minor) AS total,
                sum(CASE WHEN o.status = 'open' THEN o.total_minor - o.paid_minor ELSE 0 END) AS due
           FROM orders o JOIN branches b ON b.id = o.branch_id
          WHERE o.branch_id = $1
            AND o.created_at >= ${DAY} AND o.created_at < ${DAY} + interval '1 day'
          GROUP BY o.payment_status`,
        [q.branchId, date],
      );
      return {
        date,
        totals: Object.fromEntries(
          totals.map((t) => [
            t.payment_status,
            { count: t.n, totalMinor: Number(t.total), dueMinor: Number(t.due) },
          ]),
        ),
        bills: rows.map((o) => ({
          id: o.id,
          orderNumber: String(o.order_number),
          channel: o.channel,
          tableLabel: o.table_label,
          billLabel: o.bill_label,
          customerName: o.customer_name,
          customerPhone: o.customer_phone,
          status: o.status,
          paymentStatus: o.payment_status,
          kitchenStatus: o.kitchen_status,
          paymentPreference: o.payment_preference,
          methods: o.methods ?? [],
          subtotalMinor: Number(o.subtotal_minor),
          discountMinor: Number(o.discount_minor),
          taxMinor: Number(o.tax_minor),
          totalMinor: Number(o.total_minor),
          paidMinor: Number(o.paid_minor),
          refundedMinor: Number(o.refunded_minor),
          dueMinor: o.status === 'open' ? Number(o.total_minor) - Number(o.paid_minor) : 0,
          currencyCode: o.currency_code.trim(),
          needsReview: o.needs_review,
          createdAt: new Date(o.created_at).toISOString(),
        })),
      };
    });
  }

  /**
   * End-of-day check for one branch: collections by method, refunds, net, and anything that
   * needs a human: online payments parked for review, online attempts that never finished,
   * open bills still owing, and integrity checks that should always be zero.
   */
  reconciliation(auth: AuthContext, q: z.infer<typeof reconciliationSchema>) {
    return this.run(auth, async (db, access) => {
      this.require(access, q.branchId, ['order:read', 'pos:access']);
      const date = q.date ?? (await this.today(db, q.branchId));
      const byMethod = await db.query<{ method: string; n: number; collected: string }>(
        `SELECT p.method, count(*)::int AS n, sum(p.amount_minor) AS collected
           FROM payments p JOIN branches b ON b.id = p.branch_id
          WHERE p.branch_id = $1 AND p.created_at >= ${DAY} AND p.created_at < ${DAY} + interval '1 day'
          GROUP BY p.method ORDER BY p.method`,
        [q.branchId, date],
      );
      const refunds = await db.query<{ method: string; n: number; refunded: string }>(
        `SELECT p.method, count(*)::int AS n, sum(r.amount_minor) AS refunded
           FROM refunds r JOIN payments p ON p.id = r.payment_id JOIN branches b ON b.id = p.branch_id
          WHERE p.branch_id = $1 AND r.created_at >= ${DAY} AND r.created_at < ${DAY} + interval '1 day'
          GROUP BY p.method`,
        [q.branchId, date],
      );
      const review = await db.query<{
        id: string;
        order_id: string;
        order_number: number;
        amount_minor: string;
        gateway_payment_id: string | null;
        failure_reason: string | null;
        updated_at: Date;
      }>(
        `SELECT i.id, i.order_id, o.order_number, i.amount_minor, i.gateway_payment_id,
                i.failure_reason, i.updated_at
           FROM payment_intents i JOIN orders o ON o.id = i.order_id
          WHERE i.branch_id = $1 AND i.status = 'needs_review' ORDER BY i.updated_at`,
        [q.branchId],
      );
      const stale = await db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM payment_intents
          WHERE branch_id = $1 AND status = 'created' AND expires_at < now()`,
        [q.branchId],
      );
      const open = await db.one<{ n: number; due: string | null }>(
        `SELECT count(*)::int AS n, sum(o.total_minor - o.paid_minor) AS due
           FROM orders o JOIN branches b ON b.id = o.branch_id
          WHERE o.branch_id = $1 AND o.status = 'open'
            AND o.created_at >= ${DAY} AND o.created_at < ${DAY} + interval '1 day'`,
        [q.branchId, date],
      );
      // Integrity: each must be 0. Paid totals must equal the sum of payment rows; a completed
      // bill must be fully paid; every online payment must come from a paid intent.
      const integrity = await db.one<{
        paid_mismatch: number;
        completed_unpaid: number;
        orphan_online: number;
      }>(
        `SELECT
           (SELECT count(*)::int FROM orders o
             WHERE o.branch_id = $1 AND o.paid_minor <>
                   coalesce((SELECT sum(p.amount_minor) FROM payments p WHERE p.order_id = o.id), 0)) AS paid_mismatch,
           (SELECT count(*)::int FROM orders o
             WHERE o.branch_id = $1 AND o.status = 'completed' AND o.paid_minor < o.total_minor) AS completed_unpaid,
           (SELECT count(*)::int FROM payments p
             LEFT JOIN payment_intents i ON i.id = p.payment_intent_id
             WHERE p.branch_id = $1 AND p.method = 'online'
               AND (i.id IS NULL OR i.status <> 'paid')) AS orphan_online`,
        [q.branchId],
      );
      const refundedBy = new Map(refunds.map((r) => [r.method, Number(r.refunded)]));
      const methods = byMethod.map((m) => ({
        method: m.method,
        payments: m.n,
        collectedMinor: Number(m.collected),
        refundedMinor: refundedBy.get(m.method) ?? 0,
        netMinor: Number(m.collected) - (refundedBy.get(m.method) ?? 0),
      }));
      for (const r of refunds) {
        if (!methods.some((m) => m.method === r.method)) {
          methods.push({
            method: r.method,
            payments: 0,
            collectedMinor: 0,
            refundedMinor: Number(r.refunded),
            netMinor: -Number(r.refunded),
          });
        }
      }
      return {
        date,
        methods,
        totalCollectedMinor: methods.reduce((s, m) => s + m.collectedMinor, 0),
        totalRefundedMinor: methods.reduce((s, m) => s + m.refundedMinor, 0),
        totalNetMinor: methods.reduce((s, m) => s + m.netMinor, 0),
        openBills: { count: open!.n, dueMinor: Number(open!.due ?? 0) },
        needsReview: review.map((r) => ({
          intentId: r.id,
          orderId: r.order_id,
          orderNumber: String(r.order_number),
          amountMinor: Number(r.amount_minor),
          gatewayPaymentId: r.gateway_payment_id,
          reason: r.failure_reason,
          since: new Date(r.updated_at).toISOString(),
        })),
        staleOnlineAttempts: stale!.n,
        integrity: {
          paidMismatch: integrity!.paid_mismatch,
          completedUnpaid: integrity!.completed_unpaid,
          orphanOnlinePayments: integrity!.orphan_online,
          ok:
            integrity!.paid_mismatch === 0 &&
            integrity!.completed_unpaid === 0 &&
            integrity!.orphan_online === 0,
        },
      };
    });
  }

  /**
   * Closes an online payment parked for review once staff have dealt with it in the gateway
   * dashboard (refunded it, or collected the bill another way). Audited with the note.
   */
  resolveReview(auth: AuthContext, intentId: string, note: string, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      const i = await db.one<{ id: string; branch_id: string; order_id: string; status: string }>(
        `SELECT id, branch_id, order_id, status FROM payment_intents WHERE id = $1 FOR UPDATE`,
        [intentId],
      );
      if (!i) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Payment not found.' });
      this.require(access, i.branch_id, ['order:refund']);
      if (i.status !== 'needs_review')
        throw new ConflictException({
          code: 'NOT_IN_REVIEW',
          message: 'This payment is not waiting for review.',
        });
      await db.query(
        `UPDATE payment_intents SET status = 'cancelled', failure_reason = left(coalesce(failure_reason, '') || ' | resolved: ' || $2, 300)
          WHERE id = $1`,
        [intentId, note],
      );
      await writeAudit(db, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorSessionId: auth.sessionId,
        actorAudience: 'tenant',
        action: 'payment.review_resolved',
        entityType: 'order',
        entityId: i.order_id,
        metadata: { intentId, note },
        ...meta,
      });
      return { intentId, status: 'resolved' };
    });
  }

  private async today(db: Db, branchId: string) {
    const r = await db.one<{ d: string }>(
      `SELECT to_char(now() AT TIME ZONE timezone, 'YYYY-MM-DD') AS d FROM branches WHERE id = $1`,
      [branchId],
    );
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Branch not found.' });
    return r.d;
  }

  private require(access: TenantAccess, branchId: string, anyOf: string[]) {
    const inTenant = access.allBranches.some((b) => b.id === branchId);
    if (!inTenant || !anyOf.some((p) => hasPermission(access, p, { branchId }))) {
      throw forbidden('You cannot view billing for this branch.');
    }
  }

  private run<T>(auth: AuthContext, work: (db: Db, access: TenantAccess) => Promise<T>) {
    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, async (db) =>
      work(db, await this.access.forRequest(db, auth)),
    );
  }
}
