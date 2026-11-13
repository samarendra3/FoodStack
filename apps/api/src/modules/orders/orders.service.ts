import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { likeTerm, runPaged } from '../../common/pagination/paged';
import { type Db, DbContext } from '../../core/db/db-context';
import { hasPermission } from '../auth/access';
import { SubscriptionLifecycleService } from '../billing/subscription-lifecycle.service';
import { AccessService } from '../auth/access.service';
import type { AuthContext, RequestMeta, TenantAccess } from '../auth/auth.types';
import { writeAudit } from '../auth/user-tokens';
import { PromotionsService } from '../promotions/promotions.service';
import { CacheNs } from '../../shared/cache/cache.keys';
import { CacheService } from '../../shared/cache/cache.service';
import { type EventActor, OrderEventsService, type ReadyPayload } from './order-events';
import { WaiterAssignmentsService } from './waiter-assignments';
import {
  type CreateOrderInput,
  type KitchenStatus,
  type ListOrdersQuery,
  type ListPaymentsQuery,
  type PaymentInput,
  type RefundInput,
} from './orders.schemas';

const forbidden = (message: string) => new ForbiddenException({ code: 'ORDER_FORBIDDEN', message });
const conflict = (code: string, message: string) => new ConflictException({ code, message });
const notFound = (what: string) =>
  new NotFoundException({ code: 'ORDER_NOT_FOUND', message: `${what} not found.` });

export interface OrderRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  restaurant_id: string;
  order_number: number;
  channel: string;
  status: 'open' | 'completed' | 'cancelled';
  kitchen_status: KitchenStatus;
  table_label: string | null;
  bill_label: string | null;
  customer_id: string | null;
  note: string | null;
  coupon_code: string | null;
  currency_code: string;
  tax_rate_bp: number;
  subtotal_minor: string;
  discount_minor: string;
  tax_minor: string;
  total_minor: string;
  paid_minor: string;
  refunded_minor: string;
  cancel_reason: string | null;
  created_at: Date;
  completed_at: Date | null;
  cancelled_at: Date | null;
  kitchen_updated_at: Date;
  payment_preference: 'counter_cash' | 'counter_card' | 'online' | null;
}

/** Who performs an order write: a signed-in staff member, or a QR guest (no user, "system"). */
export interface Actor {
  tenantId: string;
  userId: string | null;
  sessionId: string | null;
  audience: 'tenant' | 'system';
}
/** Allowed order-level kitchen moves. `accepted` is legacy (stored on old orders only). */
const ORDER_MOVES: Partial<Record<KitchenStatus, KitchenStatus[]>> = {
  new: ['preparing'],
  accepted: ['preparing'],
  preparing: ['ready'],
  ready: ['served'],
};

/** Timeline shows only these facts per event type (the pickup card's item list is not repeated). */
const TIMELINE_FIELDS: Record<string, string[]> = {
  'order.created': ['orderNumber', 'channel', 'tableLabel', 'itemCount', 'totalMinor'],
  'order.status': ['from', 'to'],
  'order.item_status': ['name', 'from', 'to'],
  'waiter.assigned': ['waiterName', 'auto'],
  'waiter.accepted': ['claimed'],
  'waiter.unassigned': ['problemNote'],
  'order.ready': ['from', 'to'],
  'order.served': ['from', 'to'],
  'order.cancelled': ['reason'],
  'order.item_voided': ['itemId', 'reason'],
  'payment.recorded': ['method', 'amountMinor', 'paidInFull'],
  'payment.refunded': ['amountMinor', 'reason'],
  'payment.failed': ['reason', 'needsReview'],
};
function pickTimelineDetails(type: string, payload: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of TIMELINE_FIELDS[type] ?? []) if (k in payload) out[k] = payload[k];
  return out;
}

const eventActor = (a: Actor): EventActor =>
  a.userId ? { kind: 'staff', userId: a.userId } : { kind: 'system' };

export const actorOf = (auth: AuthContext): Actor => ({
  tenantId: auth.tenantId!,
  userId: auth.userId,
  sessionId: auth.sessionId,
  audience: 'tenant',
});

export interface SessionRow {
  id: string;
  branch_id: string;
  branch_name: string;
  table_id: string;
  table_label: string;
  table_area: string;
  status: 'open' | 'closed';
  opened_via: 'qr' | 'staff';
  opened_at: Date;
  closed_at: Date | null;
  currency_code: string;
}
export const SESSION_SQL = `
  SELECT s.id, s.branch_id, b.name AS branch_name, s.table_id, t.label AS table_label, t.area AS table_area,
         s.status, s.opened_via, s.opened_at, s.closed_at, r.currency_code
    FROM table_sessions s
    JOIN dining_tables t ON t.id = s.table_id
    JOIN branches b ON b.id = s.branch_id
    JOIN restaurants r ON r.id = b.restaurant_id`;

/**
 * The open sitting at a table, opening one if there is none. The partial unique index allows a
 * single open sitting per table; a per-table advisory lock makes concurrent first scans and
 * first orders wait for each other and then share the same sitting.
 */
export async function openTableSession(
  db: Db,
  tenantId: string,
  branchId: string,
  tableId: string,
  via: 'qr' | 'staff',
): Promise<string> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `table-session:${tenantId}:${tableId}`,
  ]);
  const open = await db.one<{ id: string }>(
    `SELECT id FROM table_sessions WHERE table_id = $1 AND status = 'open'`,
    [tableId],
  );
  if (open) return open.id;
  const created = await db.one<{ id: string }>(
    `INSERT INTO table_sessions (tenant_id, branch_id, table_id, opened_via) VALUES ($1, $2, $3, $4) RETURNING id`,
    [tenantId, branchId, tableId, via],
  );
  return created!.id;
}

/** Staff dine-in order at a table defined in Tables & Sections → that table's sitting. */
async function staffTableSession(db: Db, tenantId: string, branchId: string, label: string) {
  const t = await db.one<{ id: string }>(
    `SELECT id FROM dining_tables WHERE branch_id = $1 AND lower(label) = lower($2) AND deleted_at IS NULL`,
    [branchId, label],
  );
  // Free-text table labels (no matching table) keep working as before, without a session.
  return t ? openTableSession(db, tenantId, branchId, t.id, 'staff') : null;
}

/**
 * Orders, bills and payments. Every amount is computed here from database prices and the
 * discount engine; the client only sends item ids, quantities, a coupon code and payment amounts.
 * Each write locks the order row (FOR UPDATE) so concurrent payments, voids and refunds serialize.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly db: DbContext,
    private readonly access: AccessService,
    private readonly promotions: PromotionsService,
    private readonly subscriptions: SubscriptionLifecycleService,
    private readonly cache: CacheService,
    private readonly events: OrderEventsService,
    private readonly assignments: WaiterAssignmentsService,
  ) {}

  /** Set by OnlinePaymentsService: refunds an online payment at the gateway (in-transaction). */
  onlineRefund?: (
    db: Db,
    payment: {
      id: string;
      gateway: string | null;
      gateway_payment_id: string | null;
      payment_intent_id: string | null;
    },
    amountMinor: number,
    reason: string,
  ) => Promise<void>;

  create(
    auth: AuthContext,
    input: CreateOrderInput,
    clientRequestId: string | null,
    meta: RequestMeta,
  ) {
    // order.created is recorded inside createInTx (outbox): one path for POS, waiter and QR.
    return this.run(auth, async (db, access) => {
      this.require(
        access,
        input.branchId,
        ['pos:access', 'waiter:access'],
        'You cannot take orders at this branch.',
      );
      return this.createInTx(db, actorOf(auth), input, clientRequestId, meta, null);
    });
  }

  /**
   * Creates one order inside the caller's transaction. Shared by staff (POS / waiter) and QR
   * guests, so pricing, numbering, idempotency, limits and audit are identical for both.
   * `guest` links a QR order to its table session and guest; staff dine-in orders at a known
   * table join (or open) that table's session.
   */
  async createInTx(
    db: Db,
    actor: Actor,
    input: CreateOrderInput,
    clientRequestId: string | null,
    meta: RequestMeta,
    guest: { sessionId: string; guestId: string; billLabel: string } | null,
  ) {
    {
      if (clientRequestId) {
        // Concurrent retries of one request wait here, then find the order the first one
        // created, instead of racing to the unique index (which would fail with an error).
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `order-request:${actor.tenantId}:${clientRequestId}`,
        ]);
        const existing = await db.one<{ id: string }>(
          'SELECT id FROM orders WHERE client_request_id = $1',
          [clientRequestId],
        );
        if (existing) return this.detail(db, existing.id);
      }
      // Reserves this month's slot atomically (rolled back if the order fails below).
      await this.subscriptions.assertWithinLimit(db, actor.tenantId!, 'ordersPerMonth', 1, {
        branchId: input.branchId,
      });

      const q = await this.promotions.quoteInTx(db, input);
      if (input.couponCode && q.coupon?.status !== 'applied') {
        throw new BadRequestException({
          code: 'COUPON_INVALID',
          message: 'The coupon is not valid for this order.',
        });
      }
      const restaurant = await db.one<{ currency_code: string; tax_rate_bp: number }>(
        'SELECT currency_code, tax_rate_bp FROM restaurants WHERE id = $1',
        [q.restaurantId],
      );
      const tax = taxOf(q.totalMinor, restaurant!.tax_rate_bp);
      const customerId = input.customer
        ? await this.upsertCustomer(db, actor.tenantId!, input.customer)
        : null;
      const number = await db.one<{ last_number: number }>(
        `INSERT INTO branch_order_counters (tenant_id, branch_id, last_number) VALUES ($1, $2, 1)
         ON CONFLICT (tenant_id, branch_id) DO UPDATE SET last_number = branch_order_counters.last_number + 1
         RETURNING last_number`,
        [actor.tenantId, input.branchId],
      );

      const sessionId =
        guest?.sessionId ??
        (input.tableLabel && (input.channel === 'dine_in' || input.channel === 'qr')
          ? await staffTableSession(db, actor.tenantId, input.branchId, input.tableLabel)
          : null);
      const order = await db.one<{ id: string }>(
        `INSERT INTO orders (tenant_id, restaurant_id, branch_id, order_number, channel, table_label,
                             bill_label, customer_id, note, coupon_code, currency_code, tax_rate_bp,
                             subtotal_minor, discount_minor, tax_minor, total_minor,
                             client_request_id, created_by, updated_by, table_session_id, guest_id,
                             kitchen_status, payment_preference)
         VALUES ($1,$2,$3,$4,$5,$6,$18,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17,$19,$20,$21,$22) RETURNING id`,
        [
          actor.tenantId,
          q.restaurantId,
          input.branchId,
          number!.last_number,
          input.channel,
          input.tableLabel || null,
          customerId,
          input.note || null,
          q.coupon?.status === 'applied' ? q.coupon.code : null,
          restaurant!.currency_code,
          restaurant!.tax_rate_bp,
          q.subtotalMinor,
          q.discountMinor,
          tax,
          q.totalMinor + tax,
          clientRequestId,
          actor.userId,
          // A bill only makes sense at a table; a QR guest's orders form that guest's bill.
          guest ? guest.billLabel : (input.tableLabel && input.billLabel) || null,
          sessionId,
          guest?.guestId ?? null,
          // One workflow for every source: NEW → PREPARING → READY → SERVED.
          'new',
          input.paymentPreference ?? null,
        ],
      );
      // All lines in one statement. WITH ORDINALITY keeps the cart order: ids are uuidv7
      // (monotonic within the session), which is what order details sort by.
      const inserted = (
        await db.query<{ id: string }>(
          `INSERT INTO order_items (tenant_id, order_id, menu_item_id, variant_id, category_id, name,
                                  variant_name, unit_price_minor, quantity, line_total_minor,
                                  discount_minor, note)
         SELECT $1, $2, l.menu_item_id, l.variant_id, l.category_id, l.name, l.variant_name,
                l.unit_price_minor, l.quantity, l.line_total_minor, l.discount_minor, l.note
           FROM unnest($3::uuid[], $4::uuid[], $5::uuid[], $6::text[], $7::text[], $8::bigint[],
                       $9::int[], $10::bigint[], $11::bigint[], $12::text[])
                WITH ORDINALITY AS l(menu_item_id, variant_id, category_id, name, variant_name,
                                     unit_price_minor, quantity, line_total_minor, discount_minor,
                                     note, n)
          ORDER BY l.n
          RETURNING id`,
          [
            actor.tenantId,
            order!.id,
            q.lines.map((l) => l.menuItemId),
            q.lines.map((l) => l.variantId ?? null),
            q.lines.map((l) => l.categoryId),
            q.lines.map((l) => l.name),
            q.lines.map((l) => l.variantName),
            q.lines.map((l) => l.unitPriceMinor),
            q.lines.map((l) => l.quantity),
            q.lines.map((l) => l.lineTotalMinor),
            q.lines.map((l) => l.discountMinor),
            q.lines.map((_, i) => input.lines[i]!.note || null),
          ],
        )
      )
        // uuidv7 ids are monotonic within the statement: id order = cart order.
        .sort((x, y) => x.id.localeCompare(y.id));
      // Add-on snapshot per line (names and prices as ordered).
      const addonRows = q.lines.flatMap((l, i) =>
        l.addons.map((a) => ({ itemId: inserted[i]!.id, ...a })),
      );
      if (addonRows.length) {
        await db.query(
          `INSERT INTO order_item_addons
             (tenant_id, order_id, order_item_id, option_id, group_name, name, price_minor)
           SELECT $1, $2, a.item_id, a.option_id, a.group_name, a.name, a.price_minor
             FROM unnest($3::uuid[], $4::uuid[], $5::text[], $6::text[], $7::bigint[])
                  AS a(item_id, option_id, group_name, name, price_minor)`,
          [
            actor.tenantId,
            order!.id,
            addonRows.map((a) => a.itemId),
            addonRows.map((a) => a.optionId),
            addonRows.map((a) => a.groupName),
            addonRows.map((a) => a.name),
            addonRows.map((a) => a.priceMinor),
          ],
        );
      }
      await this.saveDiscounts(db, actor.tenantId!, order!.id, q.applied);
      await this.audit(db, actor, meta, 'order.created', order!.id, {
        number: number!.last_number,
        totalMinor: q.totalMinor + tax,
      });
      // Same transaction: the kitchens are told only if the order commits. An idempotent retry
      // returns early above, so it can never record (or ring) twice.
      await this.events.record(db, {
        tenantId: actor.tenantId,
        branchId: input.branchId,
        orderId: order!.id,
        type: 'order.created',
        payload: {
          orderNumber: String(number!.last_number),
          channel: input.channel,
          tableLabel: input.tableLabel || null,
          itemCount: q.lines.reduce((n, l) => n + l.quantity, 0),
          totalMinor: q.totalMinor + tax,
        },
        actor: guest ? { kind: 'guest', guestId: guest.guestId } : eventActor(actor),
      });
      return this.detail(db, order!.id);
    }
  }

  /** Paged orders across the branches the caller may see (optionally one branch). */
  list(auth: AuthContext, query: ListOrdersQuery) {
    return this.run(auth, async (db, access) => {
      const branches = this.visibleBranches(access, query.branchId, ['order:read', 'pos:access']);
      const { where, params, add } = filters('o.branch_id', branches);
      if (query.status) add('o.status = ?', query.status);
      if (query.channel) add('o.channel = ?', query.channel);
      if (query.from) add(dayFrom('o.created_at', 'ANY($1::uuid[])'), query.from);
      if (query.to) add(dayTo('o.created_at', 'ANY($1::uuid[])'), query.to);
      if (query.search) {
        const term = query.search.replace(/^#/, '');
        params.push(likeTerm(term), /^\d{1,9}$/.test(term) ? Number(term) : null);
        const n = params.length;
        where.push(
          `(o.order_number = $${n} OR c.phone ILIKE $${n - 1} OR c.name ILIKE $${n - 1} OR o.table_label ILIKE $${n - 1})`,
        );
      }
      return runPaged<ListRow, unknown>(db, {
        select: `${LIST_COLUMNS}, b.name AS branch_name, c.name AS customer_name, c.phone AS customer_phone,
                 (SELECT coalesce(sum(quantity), 0) FROM order_items i
                   WHERE i.order_id = o.id AND i.status = 'active') AS item_count`,
        from: 'orders o JOIN branches b ON b.id = o.branch_id LEFT JOIN customers c ON c.id = o.customer_id',
        where,
        params,
        sortColumns: {
          createdAt: 'o.created_at',
          orderNumber: 'o.order_number',
          totalMinor: 'o.total_minor',
          status: 'o.status',
        },
        tiebreak: 'o.id',
        cursor: {
          types: {
            createdAt: 'timestamptz',
            orderNumber: 'integer',
            totalMinor: 'bigint',
            status: 'text',
          },
          tiebreakType: 'uuid',
        },
        query,
        map: (r) => ({
          ...summary(r),
          branchName: r.branch_name,
          customer: r.customer_phone ? { name: r.customer_name, phone: r.customer_phone } : null,
          itemCount: Number(r.item_count),
        }),
      });
    });
  }

  /** Paged payments with their order number, across the caller's visible branches. */
  listPayments(auth: AuthContext, query: ListPaymentsQuery) {
    return this.run(auth, async (db, access) => {
      const branches = this.visibleBranches(access, query.branchId, ['order:read']);
      const { where, params, add } = filters('p.branch_id', branches);
      if (query.method) add('p.method = ?', query.method);
      if (query.refunded === 'yes') where.push('p.refunded_minor > 0');
      if (query.refunded === 'no') where.push('p.refunded_minor = 0');
      if (query.from) add(dayFrom('p.created_at', 'ANY($1::uuid[])'), query.from);
      if (query.to) add(dayTo('p.created_at', 'ANY($1::uuid[])'), query.to);
      if (query.search) {
        const term = query.search.replace(/^#/, '');
        params.push(likeTerm(term), /^\d{1,9}$/.test(term) ? Number(term) : null);
        const n = params.length;
        where.push(`(o.order_number = $${n} OR p.reference ILIKE $${n - 1})`);
      }
      return runPaged<PaymentListRow, unknown>(db, {
        select: `p.id, p.order_id, o.order_number, b.name AS branch_name, p.method, p.amount_minor,
                 p.refunded_minor, p.reference, p.created_at, o.currency_code`,
        from: 'payments p JOIN orders o ON o.id = p.order_id JOIN branches b ON b.id = p.branch_id',
        where,
        params,
        sortColumns: { createdAt: 'p.created_at', amountMinor: 'p.amount_minor' },
        tiebreak: 'p.id',
        cursor: {
          types: { createdAt: 'timestamptz', amountMinor: 'bigint' },
          tiebreakType: 'uuid',
        },
        query,
        map: (r) => ({
          id: r.id,
          orderId: r.order_id,
          orderNumber: r.order_number,
          branchName: r.branch_name,
          method: r.method,
          amountMinor: Number(r.amount_minor),
          refundedMinor: Number(r.refunded_minor),
          reference: r.reference,
          currencyCode: r.currency_code.trim(),
          createdAt: new Date(r.created_at).toISOString(),
        }),
      });
    });
  }

  get(auth: AuthContext, id: string) {
    return this.run(auth, async (db, access) => {
      const order = await this.load(db, id);
      this.require(
        access,
        order.branch_id,
        ['order:read', 'pos:access', 'kds:access'],
        'You cannot view this order.',
      );
      return this.detail(db, id);
    });
  }

  /**
   * The order's readable timeline from the event log: who did what, when. Staff names are
   * resolved here; guests show as their display name. Same visibility as the order itself.
   */
  timeline(auth: AuthContext, id: string) {
    return this.run(auth, async (db, access) => {
      const order = await this.load(db, id);
      this.require(
        access,
        order.branch_id,
        ['order:read', 'pos:access', 'kds:access', 'waiter:access'],
        'You cannot view this order.',
      );
      const rows = await db.query<{
        id: string;
        type: string;
        payload: Record<string, unknown>;
        actor_kind: 'staff' | 'guest' | 'system';
        created_at: Date;
        staff_name: string | null;
        guest_name: string | null;
      }>(
        `SELECT e.id, e.type, e.payload, e.actor_kind, e.created_at,
                u.full_name AS staff_name, g.display_name AS guest_name
           FROM order_events e
           LEFT JOIN users u ON u.id = e.actor_user_id
           LEFT JOIN table_guests g ON g.id = e.actor_guest_id
          WHERE e.order_id = $1
          ORDER BY e.id`,
        [id],
      );
      return rows.map((r) => ({
        id: r.id,
        type: r.type,
        at: new Date(r.created_at).toISOString(),
        actor: {
          kind: r.actor_kind,
          name:
            r.actor_kind === 'staff'
              ? (r.staff_name ?? 'Staff')
              : r.actor_kind === 'guest'
                ? (r.guest_name ?? 'Guest')
                : 'System',
        },
        details: pickTimelineDetails(r.type, r.payload),
      }));
    });
  }

  /** Voids one line and re-prices the rest (coupon and offers are re-checked). */
  voidItem(auth: AuthContext, orderId: string, itemId: string, reason: string, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      const order = await this.load(db, orderId, true);
      this.require(access, order.branch_id, ['order:void'], 'You cannot void items.');
      if (order.status !== 'open')
        throw conflict('ORDER_CLOSED', 'Only open orders can be changed.');
      const items = await db.query<{
        id: string;
        menu_item_id: string;
        variant_id: string | null;
        quantity: number;
        status: string;
      }>(
        'SELECT id, menu_item_id, variant_id, quantity, status FROM order_items WHERE order_id = $1 ORDER BY created_at, id',
        [orderId],
      );
      const target = items.find((i) => i.id === itemId && i.status === 'active');
      if (!target) throw notFound('Item');
      const remaining = items.filter((i) => i.status === 'active' && i.id !== itemId);
      if (remaining.length === 0)
        throw conflict('LAST_ITEM', 'This is the last item. Cancel the order instead.');

      await db.query(
        `UPDATE order_items SET status = 'void', voided_at = now(), voided_by = $2, void_reason = $3, discount_minor = 0
          WHERE id = $1`,
        [itemId, auth.userId, reason],
      );
      await this.reprice(db, auth, order, remaining);
      await this.readyIfAllDone(db, auth, meta, order);
      await this.audit(db, actorOf(auth), meta, 'order.item_voided', orderId, { itemId, reason });
      await this.events.record(db, {
        tenantId: order.tenant_id,
        branchId: order.branch_id,
        orderId,
        type: 'order.item_voided',
        payload: { itemId, reason },
        actor: eventActor(actorOf(auth)),
      });
      return this.detail(db, orderId);
    });
  }

  cancel(auth: AuthContext, id: string, reason: string, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      const order = await this.load(db, id, true);
      this.require(access, order.branch_id, ['order:void'], 'You cannot cancel orders.');
      if (order.status !== 'open')
        throw conflict('ORDER_CLOSED', 'Only open orders can be cancelled.');
      if (Number(order.paid_minor) - Number(order.refunded_minor) > 0) {
        throw conflict(
          'ORDER_HAS_PAYMENTS',
          'Refund the payments on this order before cancelling it.',
        );
      }
      await db.query(
        `UPDATE orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2, updated_by = $3,
                           updated_at = now(), version = version + 1 WHERE id = $1`,
        [id, reason, auth.userId],
      );
      await this.subscriptions.releaseOrderSlot(db, id);
      await this.assignments.closeOnCancelled(db, id);
      await this.audit(db, actorOf(auth), meta, 'order.cancelled', id, { reason });
      await this.events.record(db, {
        tenantId: order.tenant_id,
        branchId: order.branch_id,
        orderId: id,
        type: 'order.cancelled',
        payload: { reason },
        actor: eventActor(actorOf(auth)),
      });
      return this.detail(db, id);
    });
  }

  /** Records a payment; several payments may settle one bill (split / partial). */
  addPayment(auth: AuthContext, id: string, input: PaymentInput, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      const order = await this.load(db, id, true);
      this.require(
        access,
        order.branch_id,
        ['pos:access'],
        'You cannot take payments at this branch.',
      );
      await this.applyPayment(db, actorOf(auth), order, input, meta);
      return this.detail(db, id);
    });
  }

  /** Locks an order for a payment write (online payments, in the caller's transaction). */
  lockForPayment(db: Db, id: string) {
    return this.load(db, id, true);
  }

  /**
   * Records a payment confirmed by the gateway (never by the browser). The caller holds the
   * order lock and has checked amount and currency against the gateway's own record.
   */
  recordGatewayPayment(
    db: Db,
    order: OrderRow,
    p: { amountMinor: number; provider: string; paymentId: string; intentId: string },
    meta: RequestMeta,
  ) {
    const actor: Actor = {
      tenantId: order.tenant_id,
      userId: null,
      sessionId: null,
      audience: 'system',
    };
    return this.applyPayment(
      db,
      actor,
      order,
      { method: 'online', amountMinor: p.amountMinor, reference: p.paymentId },
      meta,
      { provider: p.provider, paymentId: p.paymentId, intentId: p.intentId },
    );
  }

  /**
   * Records one payment against one locked, open order and completes it when nothing is due.
   * The single place a payment is written (POS, guest balance and whole-table settlement).
   */
  private async applyPayment(
    db: Db,
    actor: Actor,
    order: OrderRow,
    input: Omit<PaymentInput, 'method'> & { method: PaymentInput['method'] | 'online' },
    meta: RequestMeta,
    gateway?: { provider: string; paymentId: string; intentId: string },
  ) {
    if (order.status !== 'open') throw conflict('ORDER_CLOSED', 'This order is already closed.');
    const due = Number(order.total_minor) - Number(order.paid_minor);
    if (input.amountMinor > due) {
      throw new BadRequestException({
        code: 'OVERPAYMENT',
        message: `Only ${due / 100} is due on this order.`,
      });
    }
    const payment = await db.one<{ id: string }>(
      `INSERT INTO payments (tenant_id, order_id, branch_id, method, amount_minor, reference, created_by,
                             gateway, gateway_payment_id, payment_intent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        actor.tenantId,
        order.id,
        order.branch_id,
        input.method,
        input.amountMinor,
        input.reference || null,
        actor.userId,
        gateway?.provider ?? null,
        gateway?.paymentId ?? null,
        gateway?.intentId ?? null,
      ],
    );
    const paidInFull = input.amountMinor === due;
    await db.query(
      `UPDATE orders SET paid_minor = paid_minor + $2,
              status = CASE WHEN $3 THEN 'completed' ELSE status END,
              completed_at = CASE WHEN $3 THEN now() ELSE completed_at END,
              updated_by = $4, updated_at = now(), version = version + 1
        WHERE id = $1`,
      [order.id, input.amountMinor, paidInFull, actor.userId],
    );
    await this.audit(db, actor, meta, 'order.payment', order.id, {
      paymentId: payment!.id,
      method: input.method,
      amountMinor: input.amountMinor,
    });
    await this.events.record(db, {
      tenantId: actor.tenantId,
      branchId: order.branch_id,
      orderId: order.id,
      type: 'payment.recorded',
      payload: {
        paymentId: payment!.id,
        method: input.method,
        amountMinor: input.amountMinor,
        paidInFull,
      },
      actor: eventActor(actor),
    });
  }

  refund(auth: AuthContext, paymentId: string, input: RefundInput, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      const payment = await db.one<{
        id: string;
        order_id: string;
        branch_id: string;
        amount_minor: string;
        refunded_minor: string;
        method: string;
        gateway: string | null;
        gateway_payment_id: string | null;
        payment_intent_id: string | null;
      }>(
        `SELECT id, order_id, branch_id, amount_minor, refunded_minor, method, gateway,
                gateway_payment_id, payment_intent_id FROM payments WHERE id = $1 FOR UPDATE`,
        [paymentId],
      );
      if (!payment) throw notFound('Payment');
      this.require(access, payment.branch_id, ['order:refund'], 'You cannot refund payments.');
      await this.load(db, payment.order_id, true);
      const refundable = Number(payment.amount_minor) - Number(payment.refunded_minor);
      if (input.amountMinor > refundable) {
        throw new BadRequestException({
          code: 'REFUND_TOO_LARGE',
          message: `At most ${refundable / 100} can be refunded from this payment.`,
        });
      }
      // Online payments are refunded through the restaurant's gateway first; if the gateway
      // refuses, nothing is recorded (the transaction rolls back).
      if (payment.method === 'online') {
        if (!this.onlineRefund) {
          throw conflict('ONLINE_REFUND_UNAVAILABLE', 'Online refunds are not available.');
        }
        await this.onlineRefund(db, payment, input.amountMinor, input.reason);
      }
      await db.query('UPDATE payments SET refunded_minor = refunded_minor + $2 WHERE id = $1', [
        paymentId,
        input.amountMinor,
      ]);
      await db.query(
        `UPDATE orders SET refunded_minor = refunded_minor + $2, updated_by = $3, updated_at = now(),
                           version = version + 1 WHERE id = $1`,
        [payment.order_id, input.amountMinor, auth.userId],
      );
      await db.query(
        `INSERT INTO refunds (tenant_id, payment_id, order_id, amount_minor, reason, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [auth.tenantId, paymentId, payment.order_id, input.amountMinor, input.reason, auth.userId],
      );
      await this.audit(db, actorOf(auth), meta, 'order.refund', payment.order_id, {
        paymentId,
        amountMinor: input.amountMinor,
        reason: input.reason,
      });
      await this.events.record(db, {
        tenantId: auth.tenantId!,
        branchId: payment.branch_id,
        orderId: payment.order_id,
        type: 'payment.refunded',
        payload: { paymentId, amountMinor: input.amountMinor, reason: input.reason },
        actor: eventActor(actorOf(auth)),
      });
      return this.detail(db, payment.order_id);
    });
  }

  // ---- kitchen ----

  /** Open tickets plus those served in the last 12 hours, oldest first. */
  kitchenTickets(auth: AuthContext, branchId: string) {
    return this.run(auth, async (db, access) => {
      this.require(access, branchId, ['kds:access'], 'You cannot view this kitchen.');
      const orders = await db.query<OrderRow & { customer_name: string | null }>(
        `SELECT o.*, c.name AS customer_name FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
          WHERE o.branch_id = $1 AND o.status <> 'cancelled'
            AND (o.kitchen_status <> 'served' OR o.kitchen_updated_at > now() - interval '12 hours')
          ORDER BY o.created_at`,
        [branchId],
      );
      const items = await this.readyItems(
        db,
        orders.map((o) => o.id),
      );
      return orders.map((o) => ({
        id: o.id,
        orderNumber: String(o.order_number),
        orderType: o.channel,
        tableLabel: o.table_label,
        billLabel: o.bill_label,
        customerName: o.customer_name,
        createdAt: new Date(o.created_at).toISOString(),
        updatedAt: new Date(o.kitchen_updated_at).toISOString(),
        status: o.kitchen_status,
        note: o.note,
        items: items
          .filter((i) => i.order_id === o.id)
          .map((i) => ({
            id: i.id,
            name: i.variant_name ? `${i.name} (${i.variant_name})` : i.name,
            qty: i.quantity,
            note: i.note,
            addons: i.addons,
            kitchenStatus: i.kitchen_status,
          })),
      }));
    });
  }

  /** Moves a ticket one step forward (new → accepted → preparing → ready → served). */
  setKitchenStatus(auth: AuthContext, id: string, to: KitchenStatus, meta: RequestMeta) {
    return this.transitionKitchen(
      auth,
      id,
      to,
      meta,
      ['kds:access'],
      'You cannot update kitchen tickets.',
    );
  }

  // ---- waiter: ready-order pickup ----

  /** Orders the kitchen has marked ready and nobody has served yet (the missed-event backlog). */
  readyOrders(auth: AuthContext, branchId: string) {
    return this.run(auth, async (db, access) => {
      this.require(access, branchId, ['waiter:access'], 'You cannot view this branch.');
      const rows = await db.query<OrderRow>(
        `SELECT * FROM orders WHERE branch_id = $1 AND status <> 'cancelled' AND kitchen_status = 'ready'
          ORDER BY kitchen_updated_at`,
        [branchId],
      );
      const items = await this.readyItems(
        db,
        rows.map((o) => o.id),
      );
      const open = await this.assignments.openFor(
        db,
        rows.map((o) => o.id),
      );
      return rows.map((o) => ({
        orderId: o.id,
        branchId: o.branch_id,
        ...this.readyPayload(o, items),
        assignment: open.get(o.id) ?? null,
      }));
    });
  }

  /** Checks the caller may watch this branch's live feed (no DB connection is kept afterwards). */
  authorizeFeed(auth: AuthContext, branchId: string, permission: 'waiter:access' | 'kds:access') {
    return this.run(auth, async (_db, access) => {
      this.require(access, branchId, [permission], 'You cannot view this branch.');
      if (!auth.tenantId) throw forbidden('You cannot view this branch.');
      return auth.tenantId;
    });
  }

  /** A waiter hands over a ready order: ready → served. */
  markServed(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.transitionKitchen(
      auth,
      id,
      'served',
      meta,
      ['waiter:access', 'kds:access'],
      'You cannot serve orders in this branch.',
    );
  }

  private async transitionKitchen(
    auth: AuthContext,
    id: string,
    to: KitchenStatus,
    meta: RequestMeta,
    anyOf: string[],
    message: string,
  ) {
    return this.run(auth, async (db, access) => {
      const order = await this.load(db, id, true);
      this.require(access, order.branch_id, anyOf, message);
      if (order.status === 'cancelled')
        throw conflict('ORDER_CANCELLED', 'This order was cancelled.');
      if (!ORDER_MOVES[order.kitchen_status]?.includes(to)) {
        throw conflict('BAD_TRANSITION', `A ${order.kitchen_status} ticket cannot move to ${to}.`);
      }
      await this.applyOrderStatus(db, auth, meta, order, to, true);
      return { id, status: to };
    });
  }

  /**
   * Moves an order's kitchen status (caller has checked the move is allowed) and, with
   * `cascade`, its lines: PREPARING starts every pending line, READY finishes every line.
   * Records the audit entry and the outbox event in the caller's transaction.
   */
  private async applyOrderStatus(
    db: Db,
    auth: AuthContext,
    meta: RequestMeta,
    order: OrderRow,
    to: KitchenStatus,
    cascade: boolean,
  ) {
    const id = order.id;
    await db.query(
      `UPDATE orders SET kitchen_status = $2, kitchen_updated_at = now(), updated_by = $3,
                         updated_at = now(), version = version + 1 WHERE id = $1`,
      [id, to, auth.userId],
    );
    if (cascade && to === 'preparing') {
      await db.query(
        `UPDATE order_items SET kitchen_status = 'preparing'
          WHERE order_id = $1 AND status = 'active' AND kitchen_status = 'pending'`,
        [id],
      );
    }
    if (cascade && to === 'ready') {
      await db.query(
        `UPDATE order_items SET kitchen_status = 'ready', ready_at = now()
          WHERE order_id = $1 AND status = 'active' AND kitchen_status <> 'ready'`,
        [id],
      );
    }
    await this.audit(db, actorOf(auth), meta, 'order.kitchen_status', id, {
      from: order.kitchen_status,
      to,
    });
    // Outbox, same transaction: screens hear about the change only once it has committed.
    // ready / served carry the waiter pickup card; other steps are a plain status change.
    const pickup = to === 'ready' || to === 'served';
    const fresh = pickup ? await this.load(db, id) : null;
    await this.events.record(db, {
      tenantId: order.tenant_id,
      branchId: order.branch_id,
      orderId: id,
      type: to === 'ready' ? 'order.ready' : to === 'served' ? 'order.served' : 'order.status',
      payload: {
        from: order.kitchen_status,
        to,
        ...(fresh ? this.readyPayload(fresh, await this.readyItems(db, [id])) : {}),
      },
      actor: eventActor(actorOf(auth)),
    });
    // Same transaction: a READY order is handed to a waiter (or the unassigned queue); a
    // SERVED order closes its hand-over.
    if (to === 'ready') await this.assignments.assignOnReady(db, order, eventActor(actorOf(auth)));
    if (to === 'served') await this.assignments.closeOnServed(db, id, auth.userId);
  }

  /**
   * One dish on a ticket: pending → preparing → ready (pending → ready allowed for quick
   * items). Starting any dish moves a NEW order to PREPARING; the order becomes READY (and the
   * waiters are told) only when every active dish on it is ready.
   */
  setItemStatus(
    auth: AuthContext,
    orderId: string,
    itemId: string,
    to: 'preparing' | 'ready',
    meta: RequestMeta,
  ) {
    return this.run(auth, async (db, access) => {
      const order = await this.load(db, orderId, true);
      this.require(access, order.branch_id, ['kds:access'], 'You cannot update kitchen tickets.');
      if (order.status === 'cancelled')
        throw conflict('ORDER_CANCELLED', 'This order was cancelled.');
      if (order.kitchen_status === 'ready' || order.kitchen_status === 'served')
        throw conflict('BAD_TRANSITION', 'This order is already ready.');
      const item = await db.one<{
        id: string;
        name: string;
        status: string;
        kitchen_status: string;
      }>(
        `SELECT id, name, status, kitchen_status FROM order_items WHERE id = $1 AND order_id = $2`,
        [itemId, orderId],
      );
      if (!item || item.status !== 'active') throw notFound('Item');
      const allowed: Record<string, string[]> = {
        pending: ['preparing', 'ready'],
        preparing: ['ready'],
      };
      if (!allowed[item.kitchen_status]?.includes(to)) {
        throw conflict('BAD_TRANSITION', `This dish is already ${item.kitchen_status}.`);
      }
      await db.query(
        `UPDATE order_items SET kitchen_status = $2,
                ready_at = CASE WHEN $2 = 'ready' THEN now() ELSE NULL END WHERE id = $1`,
        [itemId, to],
      );
      await this.events.record(db, {
        tenantId: order.tenant_id,
        branchId: order.branch_id,
        orderId,
        type: 'order.item_status',
        payload: { itemId, name: item.name, from: item.kitchen_status, to },
        actor: eventActor(actorOf(auth)),
      });
      let current = order;
      if (order.kitchen_status === 'new' || order.kitchen_status === 'accepted') {
        await this.applyOrderStatus(db, auth, meta, order, 'preparing', false);
        current = await this.load(db, orderId);
      }
      await this.readyIfAllDone(db, auth, meta, current);
      return this.ticketItems(db, orderId);
    });
  }

  /** PREPARING order whose active dishes are all ready → READY (waiters are notified). */
  private async readyIfAllDone(db: Db, auth: AuthContext, meta: RequestMeta, order: OrderRow) {
    if (order.kitchen_status !== 'preparing') return;
    const left = await db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM order_items
        WHERE order_id = $1 AND status = 'active' AND kitchen_status <> 'ready'`,
      [order.id],
    );
    if (left!.n === 0) await this.applyOrderStatus(db, auth, meta, order, 'ready', false);
  }

  private async ticketItems(db: Db, orderId: string) {
    const o = await this.load(db, orderId);
    const items = await this.readyItems(db, [orderId]);
    return {
      id: orderId,
      status: o.kitchen_status,
      items: items.map((i) => ({ id: i.id, kitchenStatus: i.kitchen_status })),
    };
  }

  /** Add-on snapshot rows of the given orders, grouped by order line. */
  private async addonsFor(db: Db, orderIds: string[]) {
    const rows = await db.query<{
      order_item_id: string;
      group_name: string;
      name: string;
      price_minor: string;
    }>(
      `SELECT order_item_id, group_name, name, price_minor FROM order_item_addons
        WHERE order_id = ANY($1::uuid[]) ORDER BY id`,
      [orderIds],
    );
    const byItem = new Map<string, typeof rows>();
    for (const r of rows) byItem.set(r.order_item_id, [...(byItem.get(r.order_item_id) ?? []), r]);
    return byItem;
  }

  /** Active lines of the given orders with their add-on names (tickets and pickup cards). */
  private async readyItems(db: Db, orderIds: string[]) {
    const rows = await db.query<{
      id: string;
      order_id: string;
      name: string;
      variant_name: string | null;
      quantity: number;
      note: string | null;
      kitchen_status: 'pending' | 'preparing' | 'ready';
    }>(
      `SELECT id, order_id, name, variant_name, quantity, note, kitchen_status FROM order_items
        WHERE order_id = ANY($1::uuid[]) AND status = 'active' ORDER BY created_at, id`,
      [orderIds],
    );
    const addons = await this.addonsFor(db, orderIds);
    return rows.map((r) => ({ ...r, addons: (addons.get(r.id) ?? []).map((a) => a.name) }));
  }

  private readyPayload(
    o: OrderRow,
    items: Awaited<ReturnType<OrdersService['readyItems']>>,
  ): ReadyPayload {
    return {
      orderNumber: String(o.order_number),
      tableLabel: o.table_label,
      billLabel: o.bill_label,
      readyAt: new Date(o.kitchen_updated_at).toISOString(),
      items: items
        .filter((i) => i.order_id === o.id)
        .map((i) => ({
          id: i.id,
          name: i.variant_name ? `${i.name} (${i.variant_name})` : i.name,
          qty: i.quantity,
          note: i.note,
          addons: i.addons,
        })),
    };
  }

  // ---- table sessions (guest-wise and whole-table billing) ----

  /** Staff view of a table's current sitting (or a given one): guests, their orders and bills. */
  tableSession(auth: AuthContext, q: { tableId?: string; sessionId?: string }) {
    return this.run(auth, async (db, access) => {
      const s = q.sessionId
        ? await db.one<SessionRow>(`${SESSION_SQL} WHERE s.id = $1`, [q.sessionId])
        : await db.one<SessionRow>(
            `${SESSION_SQL} WHERE s.table_id = $1 ORDER BY (s.status = 'open') DESC, s.opened_at DESC LIMIT 1`,
            [q.tableId],
          );
      if (!s) return null;
      this.require(
        access,
        s.branch_id,
        ['pos:access', 'waiter:access', 'order:read'],
        'You cannot view this table.',
      );
      const history = await db.query<{
        id: string;
        status: string;
        opened_at: Date;
        closed_at: Date | null;
      }>(
        `SELECT id, status, opened_at, closed_at FROM table_sessions WHERE table_id = $1 ORDER BY opened_at DESC LIMIT 10`,
        [s.table_id],
      );
      return {
        ...(await this.sessionView(db, s, null)),
        canTakePayment: hasPermission(access, 'pos:access', { branchId: s.branch_id }),
        sittings: history.map((h) => ({
          id: h.id,
          status: h.status,
          openedAt: new Date(h.opened_at).toISOString(),
          closedAt: h.closed_at ? new Date(h.closed_at).toISOString() : null,
        })),
      };
    });
  }

  /** Open sittings at a branch with guest count, order count and balances (Dining Sessions). */
  openSessions(auth: AuthContext, branchId: string) {
    return this.run(auth, async (db, access) => {
      this.require(
        access,
        branchId,
        ['pos:access', 'waiter:access', 'order:read'],
        'You cannot view this branch.',
      );
      const rows = await db.query<Record<string, string | Date | null>>(
        `SELECT s.id, s.table_id, t.label, t.area, s.opened_at, s.opened_via,
                (SELECT count(*) FROM table_guests g WHERE g.session_id = s.id) AS guests,
                count(o.id) FILTER (WHERE o.status <> 'cancelled') AS orders,
                coalesce(sum(o.total_minor) FILTER (WHERE o.status <> 'cancelled'), 0) AS total,
                coalesce(sum(o.paid_minor) FILTER (WHERE o.status <> 'cancelled'), 0) AS paid,
                coalesce(sum(o.total_minor - o.paid_minor) FILTER (WHERE o.status = 'open'), 0) AS due,
                max(o.created_at) AS last_order_at
           FROM table_sessions s JOIN dining_tables t ON t.id = s.table_id
           LEFT JOIN orders o ON o.table_session_id = s.id
          WHERE s.branch_id = $1 AND s.status = 'open'
          GROUP BY s.id, t.label, t.area ORDER BY s.opened_at`,
        [branchId],
      );
      return rows.map((r) => ({
        id: r.id as string,
        tableId: r.table_id as string,
        tableLabel: r.label as string,
        area: r.area as string,
        openedAt: new Date(r.opened_at as Date).toISOString(),
        openedVia: r.opened_via as string,
        guests: Number(r.guests),
        orders: Number(r.orders),
        totalMinor: Number(r.total),
        paidMinor: Number(r.paid),
        outstandingMinor: Number(r.due),
        lastOrderAt: r.last_order_at ? new Date(r.last_order_at as Date).toISOString() : null,
      }));
    });
  }

  /**
   * Bills of one sitting grouped by guest (staff orders without a guest form "Table"). When
   * `onlyGuest` is set, only that guest is returned (the guest's own phone view).
   */
  async sessionView(db: Db, s: SessionRow, onlyGuest: string | null) {
    const orders = await db.query<OrderRow & { guest_id: string | null; item_count: string }>(
      `SELECT o.*, (SELECT coalesce(sum(quantity), 0) FROM order_items i WHERE i.order_id = o.id AND i.status = 'active') AS item_count
         FROM orders o WHERE o.table_session_id = $1 ${onlyGuest ? 'AND o.guest_id = $2' : ''}
        ORDER BY o.created_at, o.id`,
      onlyGuest ? [s.id, onlyGuest] : [s.id],
    );
    const guests = await db.query<{
      id: string;
      display_name: string;
      guest_number: number;
      created_at: Date;
      last_seen_at: Date;
    }>(
      `SELECT id, display_name, guest_number, created_at, last_seen_at FROM table_guests
        WHERE session_id = $1 ${onlyGuest ? 'AND id = $2' : ''} ORDER BY guest_number`,
      onlyGuest ? [s.id, onlyGuest] : [s.id],
    );
    const payments = await db.query<{
      id: string;
      order_id: string;
      method: string;
      amount_minor: string;
      refunded_minor: string;
      created_at: Date;
    }>(
      `SELECT p.id, p.order_id, p.method, p.amount_minor, p.refunded_minor, p.created_at
         FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE o.table_session_id = $1 ${onlyGuest ? 'AND o.guest_id = $2' : ''} ORDER BY p.created_at`,
      onlyGuest ? [s.id, onlyGuest] : [s.id],
    );
    const orderDto = (o: (typeof orders)[number]) => ({
      id: o.id,
      orderNumber: o.order_number,
      createdAt: new Date(o.created_at).toISOString(),
      status: o.status,
      kitchenStatus: o.kitchen_status,
      itemCount: Number(o.item_count),
      totalMinor: Number(o.total_minor),
      paidMinor: Number(o.paid_minor),
      dueMinor: o.status === 'open' ? Number(o.total_minor) - Number(o.paid_minor) : 0,
    });
    const group = (list: typeof orders) => {
      const live = list.filter((o) => o.status !== 'cancelled');
      const totalMinor = live.reduce((t, o) => t + Number(o.total_minor), 0);
      const paidMinor = live.reduce((t, o) => t + Number(o.paid_minor), 0);
      const ids = new Set(list.map((o) => o.id));
      return {
        orders: list.map(orderDto),
        totalMinor,
        paidMinor,
        outstandingMinor: live
          .filter((o) => o.status === 'open')
          .reduce((t, o) => t + Number(o.total_minor) - Number(o.paid_minor), 0),
        payments: payments
          .filter((p) => ids.has(p.order_id))
          .map((p) => ({
            id: p.id,
            orderId: p.order_id,
            method: p.method,
            amountMinor: Number(p.amount_minor),
            refundedMinor: Number(p.refunded_minor),
            createdAt: new Date(p.created_at).toISOString(),
          })),
      };
    };
    const byGuest = guests.map((g) => ({
      id: g.id,
      name: g.display_name,
      number: g.guest_number,
      joinedAt: new Date(g.created_at).toISOString(),
      lastSeenAt: new Date(g.last_seen_at).toISOString(),
      ...group(orders.filter((o) => o.guest_id === g.id)),
    }));
    const staffOrders = orders.filter((o) => o.guest_id === null);
    const all = group(orders);
    return {
      session: {
        id: s.id,
        status: s.status,
        openedVia: s.opened_via,
        openedAt: new Date(s.opened_at).toISOString(),
        closedAt: s.closed_at ? new Date(s.closed_at).toISOString() : null,
        table: { id: s.table_id, label: s.table_label, area: s.table_area },
        branch: { id: s.branch_id, name: s.branch_name },
        currencyCode: s.currency_code.trim(),
      },
      guests: byGuest,
      table:
        onlyGuest || staffOrders.length === 0
          ? null
          : { name: 'Table (staff orders)', ...group(staffOrders) },
      totals: {
        totalMinor: all.totalMinor,
        paidMinor: all.paidMinor,
        outstandingMinor: all.outstandingMinor,
      },
    };
  }

  /**
   * Pays one guest's balance (`guestId`), the staff orders without a guest (`unassigned`), or the
   * whole table. The amount is spread over that scope's open orders oldest first through
   * `applyPayment`, all under row locks in one transaction; paid orders are never touched.
   */
  paySession(
    auth: AuthContext,
    sessionId: string,
    scope: { guestId?: string; unassigned?: boolean },
    input: PaymentInput,
    meta: RequestMeta,
  ) {
    return this.run(auth, async (db, access) => {
      const s = await db.one<SessionRow>(`${SESSION_SQL} WHERE s.id = $1`, [sessionId]);
      if (!s) throw notFound('Table session');
      this.require(access, s.branch_id, ['pos:access'], 'You cannot take payments at this branch.');
      const where = scope.guestId
        ? 'AND guest_id = $2'
        : scope.unassigned
          ? 'AND guest_id IS NULL'
          : '';
      const open = await db.query<OrderRow>(
        `SELECT * FROM orders WHERE table_session_id = $1 AND status = 'open' ${where}
          ORDER BY created_at, id FOR UPDATE`,
        scope.guestId ? [sessionId, scope.guestId] : [sessionId],
      );
      const due = open.reduce((t, o) => t + Number(o.total_minor) - Number(o.paid_minor), 0);
      if (due === 0) throw conflict('NOTHING_DUE', 'Nothing is due on this bill.');
      if (input.amountMinor > due) {
        throw new BadRequestException({
          code: 'OVERPAYMENT',
          message: `Only ${due / 100} is due on this bill.`,
        });
      }
      let left = input.amountMinor;
      const applied: { orderId: string; amountMinor: number }[] = [];
      for (const o of open) {
        if (left === 0) break;
        const part = Math.min(left, Number(o.total_minor) - Number(o.paid_minor));
        if (part <= 0) continue;
        await this.applyPayment(db, actorOf(auth), o, { ...input, amountMinor: part }, meta);
        applied.push({ orderId: o.id, amountMinor: part });
        left -= part;
      }
      return {
        applied,
        remainingMinor: due - input.amountMinor,
        ...(await this.sessionView(db, s, null)),
      };
    });
  }

  /** Ends a sitting. Refused while any bill is open; the next scan starts a new sitting. */
  closeSession(auth: AuthContext, sessionId: string, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      const s = await db.one<SessionRow>(`${SESSION_SQL} WHERE s.id = $1 FOR UPDATE OF s`, [
        sessionId,
      ]);
      if (!s) throw notFound('Table session');
      this.require(
        access,
        s.branch_id,
        ['pos:access', 'waiter:access'],
        'You cannot close this table.',
      );
      if (s.status === 'closed')
        throw conflict('SESSION_CLOSED', 'This table session is already closed.');
      const open = await db.one<{ n: string }>(
        `SELECT count(*) AS n FROM orders WHERE table_session_id = $1 AND status = 'open'`,
        [sessionId],
      );
      if (Number(open?.n ?? 0) > 0) {
        throw conflict(
          'SESSION_HAS_OPEN_BILLS',
          'Settle or cancel every open bill before closing the table.',
        );
      }
      await db.query(
        `UPDATE table_sessions SET status = 'closed', closed_at = now(), closed_by = $2 WHERE id = $1`,
        [sessionId, auth.userId],
      );
      await writeAudit(db, {
        action: 'table_session.closed',
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorSessionId: auth.sessionId,
        actorAudience: 'tenant',
        entityType: 'table_session',
        entityId: sessionId,
        metadata: { table: s.table_label },
        ...meta,
      });
    });
  }

  // ---- helpers ----

  private run<T>(auth: AuthContext, work: (db: Db, access: TenantAccess) => Promise<T>) {
    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, async (db) =>
      work(db, await this.access.forRequest(db, auth)),
    );
  }

  /** Branches where the caller holds any of `anyOf`; narrowed to `branchId` when given. */
  private visibleBranches(
    access: TenantAccess,
    branchId: string | undefined,
    anyOf: string[],
  ): string[] {
    const ids = access.allBranches
      .filter((b) => anyOf.some((p) => hasPermission(access, p, { branchId: b.id })))
      .map((b) => b.id);
    if (branchId) {
      if (!ids.includes(branchId)) throw forbidden('You cannot view this branch.');
      return [branchId];
    }
    if (ids.length === 0) throw forbidden('You cannot view orders.');
    return ids;
  }

  private require(access: TenantAccess, branchId: string, anyOf: string[], message: string) {
    const inTenant = access.allBranches.some((b) => b.id === branchId);
    if (!inTenant || !anyOf.some((p) => hasPermission(access, p, { branchId })))
      throw forbidden(message);
  }

  private async load(db: Db, id: string, lock = false): Promise<OrderRow> {
    const row = await db.one<OrderRow>(
      `SELECT * FROM orders WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    );
    if (!row) throw notFound('Order');
    return row;
  }

  private async reprice(
    db: Db,
    auth: AuthContext,
    order: OrderRow,
    lines: { id: string; menu_item_id: string; variant_id: string | null; quantity: number }[],
  ) {
    // Re-price at the prices saved on the order lines, not today's menu prices.
    const saved = await db.query<{ id: string; unit_price_minor: string; category_id: string }>(
      'SELECT id, unit_price_minor, category_id FROM order_items WHERE id = ANY($1::uuid[])',
      [lines.map((l) => l.id)],
    );
    const q = await this.promotions.quoteSavedLines(db, {
      branchId: order.branch_id,
      restaurantId: order.restaurant_id,
      channel: order.channel,
      couponCode: order.coupon_code,
      lines: lines.map((l) => {
        const s = saved.find((x) => x.id === l.id)!;
        return {
          menuItemId: l.menu_item_id,
          variantId: l.variant_id,
          categoryId: s.category_id,
          unitPriceMinor: Number(s.unit_price_minor),
          quantity: l.quantity,
        };
      }),
    });
    const tax = taxOf(q.totalMinor, order.tax_rate_bp);
    const total = q.totalMinor + tax;
    if (total < Number(order.paid_minor)) {
      throw conflict(
        'PAID_MORE_THAN_TOTAL',
        'Payments already exceed the new total. Refund first.',
      );
    }
    if (lines.length) {
      await db.query(
        `UPDATE order_items i SET discount_minor = u.discount_minor
           FROM unnest($1::uuid[], $2::bigint[]) AS u(id, discount_minor)
          WHERE i.id = u.id`,
        [lines.map((l) => l.id), lines.map((_, i) => q.lines[i]!.discountMinor)],
      );
    }
    // Applied offers are recalculated, so the previous set is replaced.
    await db.query('DELETE FROM order_discounts WHERE order_id = $1', [order.id]);
    await this.saveDiscounts(db, auth.tenantId!, order.id, q.applied);
    const couponStillValid = q.coupon?.status === 'applied';
    await db.query(
      `UPDATE orders SET subtotal_minor = $2, discount_minor = $3, tax_minor = $4, total_minor = $5,
              coupon_code = CASE WHEN $6 THEN coupon_code ELSE NULL END,
              status = CASE WHEN $5 = paid_minor AND paid_minor > 0 THEN 'completed' ELSE status END,
              completed_at = CASE WHEN $5 = paid_minor AND paid_minor > 0 THEN now() ELSE completed_at END,
              updated_by = $7, updated_at = now(), version = version + 1
        WHERE id = $1`,
      [order.id, q.subtotalMinor, q.discountMinor, tax, total, couponStillValid, auth.userId],
    );
  }

  /** The promotions applied to an order, as priced by the discount engine. */
  private async saveDiscounts(
    db: Db,
    tenantId: string,
    orderId: string,
    applied: {
      promotionId: string;
      name: string;
      couponCode: string | null;
      discountMinor: number;
    }[],
  ) {
    if (applied.length === 0) return;
    await db.query(
      `INSERT INTO order_discounts (tenant_id, order_id, promotion_id, name, coupon_code, discount_minor)
       SELECT $1, $2, d.promotion_id, d.name, d.coupon_code, d.discount_minor
         FROM unnest($3::uuid[], $4::text[], $5::text[], $6::bigint[])
              WITH ORDINALITY AS d(promotion_id, name, coupon_code, discount_minor, n)
        ORDER BY d.n`,
      [
        tenantId,
        orderId,
        applied.map((a) => a.promotionId),
        applied.map((a) => a.name),
        applied.map((a) => a.couponCode),
        applied.map((a) => a.discountMinor),
      ],
    );
  }

  private async upsertCustomer(
    db: Db,
    tenantId: string,
    c: { phone: string; name?: string | null },
  ) {
    const row = await db.one<{ id: string }>(
      `INSERT INTO customers (tenant_id, phone, name) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, phone) DO UPDATE
         SET name = coalesce(EXCLUDED.name, customers.name), updated_at = now()
       RETURNING id`,
      [tenantId, c.phone, c.name || null],
    );
    return row!.id;
  }

  private async detail(db: Db, id: string) {
    const o = await this.load(db, id);
    const [items, discounts, payments, refunds, customer] = await Promise.all([
      db.query<{
        id: string;
        menu_item_id: string;
        variant_id: string | null;
        name: string;
        variant_name: string | null;
        unit_price_minor: string;
        quantity: number;
        line_total_minor: string;
        discount_minor: string;
        note: string | null;
        status: string;
        void_reason: string | null;
      }>('SELECT * FROM order_items WHERE order_id = $1 ORDER BY created_at, id', [id]),
      db.query<{
        promotion_id: string;
        name: string;
        coupon_code: string | null;
        discount_minor: string;
      }>(
        'SELECT promotion_id, name, coupon_code, discount_minor FROM order_discounts WHERE order_id = $1',
        [id],
      ),
      db.query<{
        id: string;
        method: string;
        amount_minor: string;
        refunded_minor: string;
        reference: string | null;
        created_at: Date;
      }>(
        'SELECT id, method, amount_minor, refunded_minor, reference, created_at FROM payments WHERE order_id = $1 ORDER BY created_at',
        [id],
      ),
      db.query<{
        id: string;
        payment_id: string;
        amount_minor: string;
        reason: string;
        created_at: Date;
      }>(
        'SELECT id, payment_id, amount_minor, reason, created_at FROM refunds WHERE order_id = $1 ORDER BY created_at',
        [id],
      ),
      o.customer_id
        ? db.one<{ name: string | null; phone: string }>(
            'SELECT name, phone FROM customers WHERE id = $1',
            [o.customer_id],
          )
        : Promise.resolve(undefined),
    ]);
    const addonsByItem = await this.addonsFor(db, [id]);
    return {
      ...summary(o),
      customer: customer ?? null,
      items: items.map((i) => ({
        id: i.id,
        menuItemId: i.menu_item_id,
        variantId: i.variant_id,
        name: i.name,
        variantName: i.variant_name,
        addons: (addonsByItem.get(i.id) ?? []).map((a) => ({
          groupName: a.group_name,
          name: a.name,
          priceMinor: Number(a.price_minor),
        })),
        unitPriceMinor: Number(i.unit_price_minor),
        quantity: i.quantity,
        lineTotalMinor: Number(i.line_total_minor),
        discountMinor: Number(i.discount_minor),
        note: i.note,
        status: i.status,
        voidReason: i.void_reason,
      })),
      discounts: discounts.map((d) => ({
        promotionId: d.promotion_id,
        name: d.name,
        couponCode: d.coupon_code,
        discountMinor: Number(d.discount_minor),
      })),
      payments: payments.map((p) => ({
        id: p.id,
        method: p.method,
        amountMinor: Number(p.amount_minor),
        refundedMinor: Number(p.refunded_minor),
        reference: p.reference,
        createdAt: new Date(p.created_at).toISOString(),
      })),
      refunds: refunds.map((r) => ({
        id: r.id,
        paymentId: r.payment_id,
        amountMinor: Number(r.amount_minor),
        reason: r.reason,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    };
  }

  private audit(
    db: Db,
    auth: Actor,
    meta: RequestMeta,
    action: string,
    id: string,
    metadata: object,
  ) {
    // Every order write (create, void, cancel, payment, refund, kitchen status) is audited
    // here, so this is the one place that retires the tenant's analytics after COMMIT.
    this.cache.invalidateAfterCommit(db, CacheNs.analytics(auth.tenantId!));
    return writeAudit(db, {
      action,
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      actorSessionId: auth.sessionId,
      actorAudience: auth.audience,
      entityType: 'order',
      entityId: id,
      metadata: metadata as Record<string, unknown>,
      ...meta,
    });
  }
}

/** Tax on the discounted subtotal, rounded half up to the minor unit. */
export function taxOf(amountMinor: number, rateBp: number): number {
  return Math.round((amountMinor * rateBp) / 10_000);
}

/** Columns `summary()` reads; lists select only these. */
const LIST_COLUMNS = [
  'id',
  'branch_id',
  'order_number',
  'channel',
  'status',
  'kitchen_status',
  'table_label',
  'bill_label',
  'table_session_id',
  'guest_id',
  'note',
  'coupon_code',
  'currency_code',
  'tax_rate_bp',
  'subtotal_minor',
  'discount_minor',
  'tax_minor',
  'total_minor',
  'paid_minor',
  'refunded_minor',
  'cancel_reason',
  'created_at',
  'completed_at',
  'cancelled_at',
]
  .map((c) => `o.${c}`)
  .join(', ');

/**
 * Local-day date filters (YYYY-MM-DD placeholder `?`), time-zone correct per branch and usable
 * by the (tenant_id, branch_id, created_at) indexes. Two conditions each:
 *  - an exact one against the row's own branch time zone (`b.timezone`, from the join), and
 *  - a constant bound over every requested branch's time zone (`branchMatch` selects them):
 *    an uncorrelated sub-select, evaluated once, which PostgreSQL can use as an index range key.
 * Comparing raw `created_at` (never converting each row) is what makes this index-friendly.
 */
export function dayFrom(column: string, branchMatch: string) {
  return `${column} >= (?::date::timestamp AT TIME ZONE b.timezone)
      AND ${column} >= (SELECT min(?::date::timestamp AT TIME ZONE tz.timezone)
                         FROM branches tz WHERE tz.id = ${branchMatch})`;
}

export function dayTo(column: string, branchMatch: string) {
  return `${column} < ((?::date + 1)::timestamp AT TIME ZONE b.timezone)
      AND ${column} < (SELECT max((?::date + 1)::timestamp AT TIME ZONE tz.timezone)
                        FROM branches tz WHERE tz.id = ${branchMatch})`;
}

function summary(o: OrderRow) {
  const total = Number(o.total_minor);
  const paid = Number(o.paid_minor);
  return {
    id: o.id,
    branchId: o.branch_id,
    orderNumber: o.order_number,
    channel: o.channel,
    paymentPreference: o.payment_preference,
    status: o.status,
    kitchenStatus: o.kitchen_status,
    tableLabel: o.table_label,
    billLabel: o.bill_label,
    tableSessionId: (o as { table_session_id?: string | null }).table_session_id ?? null,
    guestId: (o as { guest_id?: string | null }).guest_id ?? null,
    note: o.note,
    couponCode: o.coupon_code,
    currencyCode: o.currency_code.trim(),
    taxRateBp: o.tax_rate_bp,
    subtotalMinor: Number(o.subtotal_minor),
    discountMinor: Number(o.discount_minor),
    taxMinor: Number(o.tax_minor),
    totalMinor: total,
    paidMinor: paid,
    refundedMinor: Number(o.refunded_minor),
    dueMinor: o.status === 'open' ? total - paid : 0,
    cancelReason: o.cancel_reason,
    createdAt: new Date(o.created_at).toISOString(),
    completedAt: o.completed_at ? new Date(o.completed_at).toISOString() : null,
    cancelledAt: o.cancelled_at ? new Date(o.cancelled_at).toISOString() : null,
  };
}

type ListRow = OrderRow & {
  item_count: string;
  branch_name: string;
  customer_name: string | null;
  customer_phone: string | null;
};

interface PaymentListRow {
  id: string;
  order_id: string;
  order_number: number;
  branch_name: string;
  method: string;
  amount_minor: string;
  refunded_minor: string;
  reference: string | null;
  created_at: Date;
  currency_code: string;
}

/** WHERE builder: `add('col = ?', v)` appends a condition with the next $n placeholder. */
function filters(branchColumn: string, branches: string[]) {
  const where = [`${branchColumn} = ANY($1::uuid[])`];
  const params: unknown[] = [branches];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.split('?').join('$' + params.length));
  };
  return { where, params, add };
}
