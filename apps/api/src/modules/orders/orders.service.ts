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
import {
  type CreateOrderInput,
  KITCHEN_STATUSES,
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

interface OrderRow {
  id: string;
  branch_id: string;
  restaurant_id: string;
  order_number: number;
  channel: string;
  status: 'open' | 'completed' | 'cancelled';
  kitchen_status: KitchenStatus;
  table_label: string | null;
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
  ) {}

  create(
    auth: AuthContext,
    input: CreateOrderInput,
    clientRequestId: string | null,
    meta: RequestMeta,
  ) {
    return this.run(auth, async (db, access) => {
      this.require(
        access,
        input.branchId,
        ['pos:access', 'waiter:access'],
        'You cannot take orders at this branch.',
      );
      if (clientRequestId) {
        // Concurrent retries of one request wait here, then find the order the first one
        // created, instead of racing to the unique index (which would fail with an error).
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `order-request:${auth.tenantId}:${clientRequestId}`,
        ]);
        const existing = await db.one<{ id: string }>(
          'SELECT id FROM orders WHERE client_request_id = $1',
          [clientRequestId],
        );
        if (existing) return this.detail(db, existing.id);
      }
      // Reserves this month's slot atomically (rolled back if the order fails below).
      await this.subscriptions.assertWithinLimit(db, auth.tenantId!, 'ordersPerMonth', 1, {
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
        ? await this.upsertCustomer(db, auth.tenantId!, input.customer)
        : null;
      const number = await db.one<{ last_number: number }>(
        `INSERT INTO branch_order_counters (tenant_id, branch_id, last_number) VALUES ($1, $2, 1)
         ON CONFLICT (tenant_id, branch_id) DO UPDATE SET last_number = branch_order_counters.last_number + 1
         RETURNING last_number`,
        [auth.tenantId, input.branchId],
      );

      const order = await db.one<{ id: string }>(
        `INSERT INTO orders (tenant_id, restaurant_id, branch_id, order_number, channel, table_label,
                             customer_id, note, coupon_code, currency_code, tax_rate_bp,
                             subtotal_minor, discount_minor, tax_minor, total_minor,
                             client_request_id, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17) RETURNING id`,
        [
          auth.tenantId,
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
          auth.userId,
        ],
      );
      // All lines in one statement. WITH ORDINALITY keeps the cart order: ids are uuidv7
      // (monotonic within the session), which is what order details sort by.
      await db.query(
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
          ORDER BY l.n`,
        [
          auth.tenantId,
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
      );
      await this.saveDiscounts(db, auth.tenantId!, order!.id, q.applied);
      await this.audit(db, auth, meta, 'order.created', order!.id, {
        number: number!.last_number,
        totalMinor: q.totalMinor + tax,
      });
      return this.detail(db, order!.id);
    });
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
      await this.audit(db, auth, meta, 'order.item_voided', orderId, { itemId, reason });
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
      await this.audit(db, auth, meta, 'order.cancelled', id, { reason });
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
      if (order.status !== 'open') throw conflict('ORDER_CLOSED', 'This order is already closed.');
      const due = Number(order.total_minor) - Number(order.paid_minor);
      if (input.amountMinor > due) {
        throw new BadRequestException({
          code: 'OVERPAYMENT',
          message: `Only ${due / 100} is due on this order.`,
        });
      }
      const payment = await db.one<{ id: string }>(
        `INSERT INTO payments (tenant_id, order_id, branch_id, method, amount_minor, reference, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          auth.tenantId,
          id,
          order.branch_id,
          input.method,
          input.amountMinor,
          input.reference || null,
          auth.userId,
        ],
      );
      const paidInFull = input.amountMinor === due;
      await db.query(
        `UPDATE orders SET paid_minor = paid_minor + $2,
                status = CASE WHEN $3 THEN 'completed' ELSE status END,
                completed_at = CASE WHEN $3 THEN now() ELSE completed_at END,
                updated_by = $4, updated_at = now(), version = version + 1
          WHERE id = $1`,
        [id, input.amountMinor, paidInFull, auth.userId],
      );
      await this.audit(db, auth, meta, 'order.payment', id, {
        paymentId: payment!.id,
        method: input.method,
        amountMinor: input.amountMinor,
      });
      return this.detail(db, id);
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
      }>(
        'SELECT id, order_id, branch_id, amount_minor, refunded_minor FROM payments WHERE id = $1 FOR UPDATE',
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
      await this.audit(db, auth, meta, 'order.refund', payment.order_id, {
        paymentId,
        amountMinor: input.amountMinor,
        reason: input.reason,
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
      const items = await db.query<{
        id: string;
        order_id: string;
        name: string;
        variant_name: string | null;
        quantity: number;
        note: string | null;
      }>(
        `SELECT id, order_id, name, variant_name, quantity, note FROM order_items
          WHERE order_id = ANY($1::uuid[]) AND status = 'active' ORDER BY created_at, id`,
        [orders.map((o) => o.id)],
      );
      return orders.map((o) => ({
        id: o.id,
        orderNumber: String(o.order_number),
        orderType: o.channel,
        tableLabel: o.table_label,
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
          })),
      }));
    });
  }

  /** Moves a ticket one step forward (new → accepted → preparing → ready → served). */
  setKitchenStatus(auth: AuthContext, id: string, to: KitchenStatus, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      const order = await this.load(db, id, true);
      this.require(access, order.branch_id, ['kds:access'], 'You cannot update kitchen tickets.');
      if (order.status === 'cancelled')
        throw conflict('ORDER_CANCELLED', 'This order was cancelled.');
      const from = KITCHEN_STATUSES.indexOf(order.kitchen_status);
      if (KITCHEN_STATUSES.indexOf(to) !== from + 1) {
        throw conflict('BAD_TRANSITION', `A ${order.kitchen_status} ticket cannot move to ${to}.`);
      }
      await db.query(
        `UPDATE orders SET kitchen_status = $2, kitchen_updated_at = now(), updated_by = $3,
                           updated_at = now(), version = version + 1 WHERE id = $1`,
        [id, to, auth.userId],
      );
      await this.audit(db, auth, meta, 'order.kitchen_status', id, {
        from: order.kitchen_status,
        to,
      });
      return { id, status: to };
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
    return {
      ...summary(o),
      customer: customer ?? null,
      items: items.map((i) => ({
        id: i.id,
        menuItemId: i.menu_item_id,
        variantId: i.variant_id,
        name: i.name,
        variantName: i.variant_name,
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
    auth: AuthContext,
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
      actorAudience: 'tenant',
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
    status: o.status,
    kitchenStatus: o.kitchen_status,
    tableLabel: o.table_label,
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
