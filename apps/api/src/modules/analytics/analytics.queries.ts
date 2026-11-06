import type { Db } from '../../core/db/db-context';
import type { AnalyticsScope } from './analytics-scope';

/**
 * Parameterized aggregation SQL for analytics. Every statement:
 * - runs in the caller's RLS transaction (tenant_id = app.tenant_id is enforced by PostgreSQL),
 * - filters `branch_id = ANY($branches)` with the *authorised* branch set,
 * - compares raw timestamptz columns with precomputed bounds (index range scans), and only
 *   converts to local time in SELECT/GROUP BY,
 * - returns aggregated rows only (bounded by group count), never order histories.
 *
 * Definitions (docs/PHASE_6_ANALYTICS_AUDIT.md §2.1):
 * gross = Σ subtotal, net = Σ (subtotal − discount), billed = Σ total, all over completed orders
 * dated by completed_at. Collected = Σ payments.amount (payments.created_at). Refunds =
 * Σ refunds.amount (refunds.created_at), read from the refunds table only — payments/orders
 * refunded_minor columns are never summed, so nothing is counted twice.
 */

class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

const n = (v: unknown) => Number(v ?? 0);

/** Channel and payment-method filters on an `orders o` row. */
function orderFilters(scope: AnalyticsScope, p: Params): string {
  let sql = '';
  if (scope.channel) sql += ` AND o.channel = ${p.add(scope.channel)}`;
  if (scope.method) {
    sql += ` AND EXISTS (SELECT 1 FROM payments pm WHERE pm.order_id = o.id AND pm.method = ${p.add(scope.method)})`;
  }
  return sql;
}

/** For payment/refund rows: method directly, channel through the order. */
function moneyFilters(
  scope: AnalyticsScope,
  p: Params,
  payment = 'p',
): { join: string; where: string } {
  const join = scope.channel
    ? ` JOIN orders o ON o.id = ${payment}.order_id AND o.channel = ${p.add(scope.channel)}`
    : '';
  const where = scope.method ? ` AND ${payment}.method = ${p.add(scope.method)}` : '';
  return { join, where };
}

/**
 * `col` within current [start, end) or previous [prevStart, prevEnd): one index range
 * [prevStart, end) minus the gap between the periods (non-empty only for partial periods).
 */
function bothPeriods(col: string, scope: AnalyticsScope, p: Params) {
  const b = scope.bounds;
  const start = p.add(b.start);
  const end = p.add(b.end);
  const prevStart = p.add(b.prevStart);
  const prevEnd = p.add(b.prevEnd);
  return {
    where: `${col} >= ${prevStart} AND ${col} < ${end} AND NOT (${col} >= ${prevEnd} AND ${col} < ${start})`,
    cur: `${col} >= ${start}`,
    prev: `${col} < ${prevEnd}`,
  };
}

export type GroupKind = 'all' | 'branch' | 'dim';
const kindOf = (g: number): GroupKind => (g === 3 ? 'all' : g === 1 ? 'branch' : 'dim');

export interface SalesRow {
  kind: GroupKind;
  branchId: string | null;
  channel: string | null;
  orders: number;
  gross: number;
  discounts: number;
  tax: number;
  billed: number;
  prevOrders: number;
  prevGross: number;
  prevDiscounts: number;
  prevTax: number;
  prevBilled: number;
}

/** Completed-order sales for both periods, overall / per branch / per channel, in one scan. */
export async function salesQuery(db: Db, scope: AnalyticsScope): Promise<SalesRow[]> {
  const p = new Params();
  const branches = p.add(scope.branchIds);
  const t = bothPeriods('o.completed_at', scope, p);
  const f = orderFilters(scope, p);
  const sum = (expr: string, when: string) => `coalesce(sum(${expr}) FILTER (WHERE ${when}), 0)`;
  const rows = await db.query<Record<string, string | null>>(
    `SELECT GROUPING(o.branch_id, o.channel) AS g, o.branch_id, o.channel,
            count(*) FILTER (WHERE ${t.cur}) AS orders,
            ${sum('o.subtotal_minor', t.cur)} AS gross,
            ${sum('o.discount_minor', t.cur)} AS discounts,
            ${sum('o.tax_minor', t.cur)} AS tax,
            ${sum('o.total_minor', t.cur)} AS billed,
            count(*) FILTER (WHERE ${t.prev}) AS p_orders,
            ${sum('o.subtotal_minor', t.prev)} AS p_gross,
            ${sum('o.discount_minor', t.prev)} AS p_discounts,
            ${sum('o.tax_minor', t.prev)} AS p_tax,
            ${sum('o.total_minor', t.prev)} AS p_billed
       FROM orders o
      WHERE o.status = 'completed' AND o.branch_id = ANY(${branches}::uuid[]) AND ${t.where}${f}
      GROUP BY GROUPING SETS ((), (o.branch_id), (o.channel))`,
    p.values,
  );
  return rows.map((r) => ({
    kind: kindOf(n(r.g)),
    branchId: r.branch_id ?? null,
    channel: r.channel ?? null,
    orders: n(r.orders),
    gross: n(r.gross),
    discounts: n(r.discounts),
    tax: n(r.tax),
    billed: n(r.billed),
    prevOrders: n(r.p_orders),
    prevGross: n(r.p_gross),
    prevDiscounts: n(r.p_discounts),
    prevTax: n(r.p_tax),
    prevBilled: n(r.p_billed),
  }));
}

export interface OrdersRow {
  kind: GroupKind;
  branchId: string | null;
  channel: string | null;
  total: number;
  open: number;
  completed: number;
  cancelled: number;
  pending: number;
  preparing: number;
  ready: number;
  served: number;
  prevTotal: number;
  prevCompleted: number;
  prevCancelled: number;
}

/**
 * Orders placed in each period (created_at), by their current billing status and, for
 * non-cancelled orders, current kitchen status. `pending` = kitchen new/accepted.
 */
export async function ordersQuery(db: Db, scope: AnalyticsScope): Promise<OrdersRow[]> {
  const p = new Params();
  const branches = p.add(scope.branchIds);
  const t = bothPeriods('o.created_at', scope, p);
  const f = orderFilters(scope, p);
  const c = (extra: string, when = t.cur) =>
    `count(*) FILTER (WHERE ${when}${extra ? ` AND ${extra}` : ''})`;
  const live = `o.status <> 'cancelled'`;
  const rows = await db.query<Record<string, string | null>>(
    `SELECT GROUPING(o.branch_id, o.channel) AS g, o.branch_id, o.channel,
            ${c('')} AS total,
            ${c(`o.status = 'open'`)} AS open,
            ${c(`o.status = 'completed'`)} AS completed,
            ${c(`o.status = 'cancelled'`)} AS cancelled,
            ${c(`${live} AND o.kitchen_status IN ('new', 'accepted')`)} AS pending,
            ${c(`${live} AND o.kitchen_status = 'preparing'`)} AS preparing,
            ${c(`${live} AND o.kitchen_status = 'ready'`)} AS ready,
            ${c(`${live} AND o.kitchen_status = 'served'`)} AS served,
            ${c('', t.prev)} AS p_total,
            ${c(`o.status = 'completed'`, t.prev)} AS p_completed,
            ${c(`o.status = 'cancelled'`, t.prev)} AS p_cancelled
       FROM orders o
      WHERE o.branch_id = ANY(${branches}::uuid[]) AND ${t.where}${f}
      GROUP BY GROUPING SETS ((), (o.branch_id), (o.channel))`,
    p.values,
  );
  return rows.map((r) => ({
    kind: kindOf(n(r.g)),
    branchId: r.branch_id ?? null,
    channel: r.channel ?? null,
    total: n(r.total),
    open: n(r.open),
    completed: n(r.completed),
    cancelled: n(r.cancelled),
    pending: n(r.pending),
    preparing: n(r.preparing),
    ready: n(r.ready),
    served: n(r.served),
    prevTotal: n(r.p_total),
    prevCompleted: n(r.p_completed),
    prevCancelled: n(r.p_cancelled),
  }));
}

export interface MoneyRow {
  kind: GroupKind;
  branchId: string | null;
  method: string | null;
  amount: number;
  prevAmount: number;
  /** Payments only: distinct orders with at least one payment by this method. */
  orders: number;
}

/** Payments collected per period, overall / per branch / per method. */
export async function paymentsQuery(db: Db, scope: AnalyticsScope): Promise<MoneyRow[]> {
  const p = new Params();
  const branches = p.add(scope.branchIds);
  const t = bothPeriods('p.created_at', scope, p);
  const m = moneyFilters(scope, p);
  const rows = await db.query<Record<string, string | null>>(
    `SELECT GROUPING(p.branch_id, p.method) AS g, p.branch_id, p.method,
            coalesce(sum(p.amount_minor) FILTER (WHERE ${t.cur}), 0) AS amount,
            coalesce(sum(p.amount_minor) FILTER (WHERE ${t.prev}), 0) AS p_amount,
            count(DISTINCT p.order_id) FILTER (WHERE ${t.cur}) AS orders
       FROM payments p${m.join}
      WHERE p.branch_id = ANY(${branches}::uuid[]) AND ${t.where}${m.where}
      GROUP BY GROUPING SETS ((), (p.branch_id), (p.method))`,
    p.values,
  );
  return rows.map((r) => ({
    kind: kindOf(n(r.g)),
    branchId: r.branch_id ?? null,
    method: r.method ?? null,
    amount: n(r.amount),
    prevAmount: n(r.p_amount),
    orders: n(r.orders),
  }));
}

/** Refunds per period (by refund time), attributed to the refunded payment's branch/method. */
export async function refundsQuery(db: Db, scope: AnalyticsScope): Promise<MoneyRow[]> {
  const p = new Params();
  const branches = p.add(scope.branchIds);
  const t = bothPeriods('r.created_at', scope, p);
  const m = moneyFilters(scope, p);
  const rows = await db.query<Record<string, string | null>>(
    `SELECT GROUPING(p.branch_id, p.method) AS g, p.branch_id, p.method,
            coalesce(sum(r.amount_minor) FILTER (WHERE ${t.cur}), 0) AS amount,
            coalesce(sum(r.amount_minor) FILTER (WHERE ${t.prev}), 0) AS p_amount
       FROM refunds r JOIN payments p ON p.id = r.payment_id${m.join}
      WHERE p.branch_id = ANY(${branches}::uuid[]) AND ${t.where}${m.where}
      GROUP BY GROUPING SETS ((), (p.branch_id), (p.method))`,
    p.values,
  );
  return rows.map((r) => ({
    kind: kindOf(n(r.g)),
    branchId: r.branch_id ?? null,
    method: r.method ?? null,
    amount: n(r.amount),
    prevAmount: n(r.p_amount),
    orders: 0,
  }));
}

/**
 * Tables with an open dine-in order right now (distinct table labels). There is no tables
 * module, so this is the only real measure; it ignores the date range by design.
 */
export async function activeTablesQuery(db: Db, scope: AnalyticsScope): Promise<number> {
  if (scope.channel && scope.channel !== 'dine_in') return 0;
  const row = await db.one<{ n: string }>(
    `SELECT count(DISTINCT lower(o.table_label)) AS n FROM orders o
      WHERE o.branch_id = ANY($1::uuid[]) AND o.status = 'open' AND o.channel = 'dine_in'
        AND o.table_label IS NOT NULL`,
    [scope.branchIds],
  );
  return n(row?.n);
}

export interface TrendRow {
  bucket: string;
  netSales: number;
  completedOrders: number;
  ordersPlaced: number;
  cancelled: number;
  collected: number;
  refunds: number;
}

/** Zero-filled local-time buckets (hour/day/month) over the current period. */
export async function trendQuery(db: Db, scope: AnalyticsScope): Promise<TrendRow[]> {
  const p = new Params();
  const branches = p.add(scope.branchIds);
  const start = p.add(scope.bounds.start);
  const end = p.add(scope.bounds.end);
  const g = p.add(scope.range.granularity);
  const tz = p.add(scope.timezone);
  const f = orderFilters(scope, p);
  const m = moneyFilters(scope, p);
  const bucket = (col: string) => `date_trunc(${g}::text, ${col} AT TIME ZONE ${tz}::text)`;
  const inRange = (col: string) => `${col} >= ${start} AND ${col} < ${end}`;
  const rows = await db.query<Record<string, string | null>>(
    `WITH buckets AS (
       SELECT gs AS b FROM generate_series(
         ${bucket(`${start}::timestamptz`)},
         ${bucket(`(${end}::timestamptz - interval '1 microsecond')`)},
         ('1 ' || ${g}::text)::interval) gs),
     sales AS (
       SELECT ${bucket('o.completed_at')} AS b, count(*) AS n,
              sum(o.subtotal_minor - o.discount_minor) AS net
         FROM orders o
        WHERE o.status = 'completed' AND o.branch_id = ANY(${branches}::uuid[])
          AND ${inRange('o.completed_at')}${f}
        GROUP BY 1),
     placed AS (
       SELECT ${bucket('o.created_at')} AS b, count(*) AS n,
              count(*) FILTER (WHERE o.status = 'cancelled') AS cancelled
         FROM orders o
        WHERE o.branch_id = ANY(${branches}::uuid[]) AND ${inRange('o.created_at')}${f}
        GROUP BY 1),
     paid AS (
       SELECT ${bucket('p.created_at')} AS b, sum(p.amount_minor) AS amount
         FROM payments p${m.join}
        WHERE p.branch_id = ANY(${branches}::uuid[]) AND ${inRange('p.created_at')}${m.where}
        GROUP BY 1),
     refunded AS (
       SELECT ${bucket('r.created_at')} AS b, sum(r.amount_minor) AS amount
         FROM refunds r JOIN payments p ON p.id = r.payment_id${m.join}
        WHERE p.branch_id = ANY(${branches}::uuid[]) AND ${inRange('r.created_at')}${m.where}
        GROUP BY 1)
     SELECT to_char(buckets.b, 'YYYY-MM-DD"T"HH24:MI') AS bucket,
            sales.net, sales.n AS completed, placed.n AS placed, placed.cancelled,
            paid.amount AS collected, refunded.amount AS refunds
       FROM buckets
       LEFT JOIN sales ON sales.b = buckets.b
       LEFT JOIN placed ON placed.b = buckets.b
       LEFT JOIN paid ON paid.b = buckets.b
       LEFT JOIN refunded ON refunded.b = buckets.b
      ORDER BY buckets.b`,
    p.values,
  );
  return rows.map((r) => ({
    bucket: r.bucket!,
    netSales: n(r.net),
    completedOrders: n(r.completed),
    ordersPlaced: n(r.placed),
    cancelled: n(r.cancelled),
    collected: n(r.collected),
    refunds: n(r.refunds),
  }));
}

export interface ItemSalesRow {
  menuItemId: string;
  categoryId: string;
  name: string;
  categoryName: string | null;
  deleted: boolean;
  quantity: number;
  revenue: number;
  orders: number;
}

/**
 * Active (non-void) lines of completed orders in the period, per menu item and category.
 * Revenue = line total − allocated line discount (pre-tax), consistent with net sales.
 * Rows are bounded by the menu size, not by order volume.
 */
export async function itemSalesQuery(db: Db, scope: AnalyticsScope): Promise<ItemSalesRow[]> {
  const p = new Params();
  const branches = p.add(scope.branchIds);
  const start = p.add(scope.bounds.start);
  const end = p.add(scope.bounds.end);
  const f = orderFilters(scope, p);
  const rows = await db.query<Record<string, string | boolean | null>>(
    `WITH o AS (
       SELECT o.id FROM orders o
        WHERE o.status = 'completed' AND o.branch_id = ANY(${branches}::uuid[])
          AND o.completed_at >= ${start} AND o.completed_at < ${end}${f}),
     i AS (
       SELECT oi.menu_item_id, oi.category_id, sum(oi.quantity) AS quantity,
              sum(oi.line_total_minor - oi.discount_minor) AS revenue,
              count(DISTINCT oi.order_id) AS orders, max(oi.name) AS snapshot_name
         FROM order_items oi JOIN o ON o.id = oi.order_id
        WHERE oi.status = 'active'
        GROUP BY oi.menu_item_id, oi.category_id)
     SELECT i.*, mi.name AS item_name, (mi.id IS NULL OR mi.deleted_at IS NOT NULL) AS deleted,
            mc.name AS category_name
       FROM i
       LEFT JOIN menu_items mi ON mi.id = i.menu_item_id
       LEFT JOIN menu_categories mc ON mc.id = i.category_id`,
    p.values,
  );
  return rows.map((r) => ({
    menuItemId: r.menu_item_id as string,
    categoryId: r.category_id as string,
    name: (r.item_name ?? r.snapshot_name) as string,
    categoryName: (r.category_name as string | null) ?? null,
    deleted: Boolean(r.deleted),
    quantity: n(r.quantity),
    revenue: n(r.revenue),
    orders: n(r.orders),
  }));
}

/** Menu items currently on sale (available, not deleted) that sold nothing in the period. */
export async function unsoldItemsQuery(
  db: Db,
  scope: AnalyticsScope,
  soldIds: string[],
): Promise<{ id: string; name: string }[]> {
  return db.query<{ id: string; name: string }>(
    `SELECT mi.id, mi.name FROM menu_items mi
      WHERE mi.restaurant_id = $1 AND mi.deleted_at IS NULL AND mi.is_available
        AND mi.id <> ALL($2::uuid[])
      ORDER BY lower(mi.name) LIMIT 50`,
    [scope.restaurant.id, soldIds],
  );
}

export interface CustomerRow {
  customers: number;
  newCustomers: number;
  returningCustomers: number;
  repeatCustomers: number;
  identifiedOrders: number;
  identifiedNetSales: number;
  completedOrders: number;
  prevCustomers: number;
}

/**
 * Identified customers only (orders with customer_id); anonymous orders are never turned into
 * customers. A customer is "new" when their first non-cancelled order at the authorised
 * branches falls in the period, otherwise "returning". Derived through orders — never by
 * counting the tenant-wide customers table.
 */
export async function customersQuery(db: Db, scope: AnalyticsScope): Promise<CustomerRow> {
  const p = new Params();
  const branches = p.add(scope.branchIds);
  const t = bothPeriods('o.completed_at', scope, p);
  const start = p.add(scope.bounds.start);
  const f = orderFilters(scope, p);
  const row = await db.one<Record<string, string | null>>(
    `WITH completed AS (
       SELECT o.customer_id, ${t.cur} AS cur, o.subtotal_minor - o.discount_minor AS net
         FROM orders o
        WHERE o.status = 'completed' AND o.branch_id = ANY(${branches}::uuid[]) AND ${t.where}${f}),
     per AS (
       SELECT customer_id, count(*) FILTER (WHERE cur) AS orders, count(*) FILTER (WHERE NOT cur) AS p_orders,
              coalesce(sum(net) FILTER (WHERE cur), 0) AS net
         FROM completed WHERE customer_id IS NOT NULL GROUP BY customer_id),
     firsts AS (
       SELECT o.customer_id, min(o.created_at) AS first_at
         FROM orders o
        WHERE o.customer_id IN (SELECT customer_id FROM per WHERE orders > 0)
          AND o.branch_id = ANY(${branches}::uuid[]) AND o.status <> 'cancelled'
        GROUP BY o.customer_id)
     SELECT
       (SELECT count(*) FROM per WHERE orders > 0) AS customers,
       (SELECT count(*) FROM firsts WHERE first_at >= ${start}) AS new_customers,
       (SELECT count(*) FROM firsts WHERE first_at < ${start}) AS returning_customers,
       (SELECT count(*) FROM per WHERE orders >= 2) AS repeat_customers,
       (SELECT coalesce(sum(orders), 0) FROM per) AS identified_orders,
       (SELECT coalesce(sum(net), 0) FROM per) AS identified_net,
       (SELECT count(*) FROM completed WHERE cur) AS completed_orders,
       (SELECT count(*) FROM per WHERE p_orders > 0) AS prev_customers`,
    p.values,
  );
  return {
    customers: n(row?.customers),
    newCustomers: n(row?.new_customers),
    returningCustomers: n(row?.returning_customers),
    repeatCustomers: n(row?.repeat_customers),
    identifiedOrders: n(row?.identified_orders),
    identifiedNetSales: n(row?.identified_net),
    completedOrders: n(row?.completed_orders),
    prevCustomers: n(row?.prev_customers),
  };
}
