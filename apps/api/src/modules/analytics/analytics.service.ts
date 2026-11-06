import { Injectable } from '@nestjs/common';
import { type Db, DbContext } from '../../core/db/db-context';
import { CacheEntry, CacheNs } from '../../shared/cache/cache.keys';
import { CacheService } from '../../shared/cache/cache.service';
import { AccessService } from '../auth/access.service';
import type { AuthContext } from '../auth/auth.types';
import { type AnalyticsScope, resolveScope, scopeDigest } from './analytics-scope';
import {
  activeTablesQuery,
  customersQuery,
  type ItemSalesRow,
  itemSalesQuery,
  ordersQuery,
  paymentsQuery,
  refundsQuery,
  type SalesRow,
  salesQuery,
  trendQuery,
  unsoldItemsQuery,
} from './analytics.queries';
import type { AnalyticsQuery, MenuAnalyticsQuery } from './analytics.schemas';

/** A figure and its previous-period value; `changePct` is null when there is no base. */
export interface Compared {
  value: number;
  previous: number;
  changePct: number | null;
}

export function compare(value: number, previous: number): Compared {
  const changePct = previous === 0 ? null : Math.round(((value - previous) / previous) * 1000) / 10;
  return { value, previous, changePct };
}

/** Average in minor units, rounded; null when there is nothing to average. */
const avg = (total: number, count: number) => (count === 0 ? null : Math.round(total / count));

const LOW_PERFORMER_MIN_ITEMS = 10;
const LOW_PERFORMER_MIN_DAYS = 7;
const TOP_N = 5;

/**
 * Dashboard analytics for owners and managers. Order of operations per request:
 * 1. RLS transaction for the tenant; 2. permissions loaded fresh (never cached);
 * 3. filters resolved against them (403 on any unauthorised id); 4. only then the cache is
 * consulted, under a tenant namespace and a digest of the authorised scope.
 *
 * `core` (sales + orders + payments + refunds + active tables) is one cache entry shared by
 * /summary and /branches, so the two never run the same aggregation twice.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly db: DbContext,
    private readonly access: AccessService,
    private readonly cache: CacheService,
  ) {}

  summary(auth: AuthContext, query: AnalyticsQuery) {
    return this.withScope(auth, query, async (db, scope) => {
      const core = await this.core(db, auth, scope);
      const customers = await this.customerStats(db, auth, scope);
      const sales = core.sales.find((r) => r.kind === 'all') ?? emptySales();
      const orders = core.orders.find((r) => r.kind === 'all');
      const paid = core.payments.find((r) => r.kind === 'all');
      const refunded = core.refunds.find((r) => r.kind === 'all');
      const net = sales.gross - sales.discounts;
      const prevNet = sales.prevGross - sales.prevDiscounts;
      const collected = paid?.amount ?? 0;
      const prevCollected = paid?.prevAmount ?? 0;
      const refunds = refunded?.amount ?? 0;
      const prevRefunds = refunded?.prevAmount ?? 0;

      const methods = (['cash', 'card', 'upi'] as const).map((method) => {
        const p = core.payments.find((r) => r.kind === 'dim' && r.method === method);
        const r = core.refunds.find((x) => x.kind === 'dim' && x.method === method);
        return {
          method,
          collectedMinor: p?.amount ?? 0,
          refundsMinor: r?.amount ?? 0,
          netMinor: (p?.amount ?? 0) - (r?.amount ?? 0),
          orders: p?.orders ?? 0,
        };
      });
      const channels = (['dine_in', 'takeaway', 'delivery', 'qr'] as const).map((channel) => {
        const s = core.sales.find((r) => r.kind === 'dim' && r.channel === channel);
        const o = core.orders.find((r) => r.kind === 'dim' && r.channel === channel);
        return {
          channel,
          orders: o?.total ?? 0,
          completedOrders: s?.orders ?? 0,
          netSalesMinor: s ? s.gross - s.discounts : 0,
        };
      });

      return {
        ...meta(scope),
        kpis: {
          totalRevenue: compare(net, prevNet),
          totalOrders: compare(orders?.total ?? 0, orders?.prevTotal ?? 0),
          completedOrders: compare(orders?.completed ?? 0, orders?.prevCompleted ?? 0),
          pendingOrders: { value: orders?.pending ?? 0 },
          cancelledOrders: compare(orders?.cancelled ?? 0, orders?.prevCancelled ?? 0),
          averageOrderValue: {
            value: avg(net, sales.orders),
            previous: avg(prevNet, sales.prevOrders),
            changePct:
              sales.orders && sales.prevOrders
                ? compare(net / sales.orders, prevNet / sales.prevOrders).changePct
                : null,
          },
          totalCustomers: compare(customers.customers, customers.prevCustomers),
          activeTables: { value: core.activeTables },
        },
        revenue: {
          grossSales: compare(sales.gross, sales.prevGross),
          discounts: compare(sales.discounts, sales.prevDiscounts),
          netSales: compare(net, prevNet),
          tax: compare(sales.tax, sales.prevTax),
          billedTotal: compare(sales.billed, sales.prevBilled),
          collected: compare(collected, prevCollected),
          refunds: compare(refunds, prevRefunds),
          netCollected: compare(collected - refunds, prevCollected - prevRefunds),
          completedOrders: compare(sales.orders, sales.prevOrders),
        },
        orders: {
          total: orders?.total ?? 0,
          open: orders?.open ?? 0,
          completed: orders?.completed ?? 0,
          cancelled: orders?.cancelled ?? 0,
          pending: orders?.pending ?? 0,
          preparing: orders?.preparing ?? 0,
          ready: orders?.ready ?? 0,
          served: orders?.served ?? 0,
        },
        byChannel: channels,
        byMethod: methods,
      };
    });
  }

  trend(auth: AuthContext, query: AnalyticsQuery) {
    return this.withScope(auth, query, async (db, scope) => ({
      ...meta(scope),
      granularity: scope.range.granularity,
      points: await this.cached(auth, scope, 'trend', () => trendQuery(db, scope)),
    }));
  }

  branches(auth: AuthContext, query: AnalyticsQuery) {
    return this.withScope(auth, query, async (db, scope) => {
      const core = await this.core(db, auth, scope);
      const rows = scope.branches
        .filter((b) => scope.branchIds.includes(b.id))
        .map((b) => {
          const s =
            core.sales.find((r) => r.kind === 'branch' && r.branchId === b.id) ?? emptySales();
          const o = core.orders.find((r) => r.kind === 'branch' && r.branchId === b.id);
          const p = core.payments.find((r) => r.kind === 'branch' && r.branchId === b.id);
          const r = core.refunds.find((x) => x.kind === 'branch' && x.branchId === b.id);
          const net = s.gross - s.discounts;
          return {
            id: b.id,
            name: b.name,
            netSales: compare(net, s.prevGross - s.prevDiscounts),
            ordersPlaced: compare(o?.total ?? 0, o?.prevTotal ?? 0),
            completedOrders: s.orders,
            cancelledOrders: o?.cancelled ?? 0,
            averageOrderValueMinor: avg(net, s.orders),
            collectedMinor: p?.amount ?? 0,
            refundsMinor: r?.amount ?? 0,
          };
        })
        .sort((a, b) => b.netSales.value - a.netSales.value || a.name.localeCompare(b.name));
      const total = rows.reduce((t, r) => t + r.netSales.value, 0);
      return {
        ...meta(scope),
        branchCount: rows.length,
        rows: rows.map((r, i) => ({
          ...r,
          rank: i + 1,
          sharePct: total === 0 ? null : Math.round((r.netSales.value / total) * 1000) / 10,
        })),
      };
    });
  }

  menu(auth: AuthContext, query: MenuAnalyticsQuery) {
    const { sort, page, pageSize, ...filters } = query;
    return this.withScope(auth, filters, async (db, scope) => {
      const data = await this.cached(auth, scope, 'menu', async () => {
        const lines = await itemSalesQuery(db, scope);
        const items = mergeItems(lines);
        const unsold = await unsoldItemsQuery(
          db,
          scope,
          items.map((i) => i.menuItemId),
        );
        return { items, categories: mergeCategories(lines), unsold };
      });
      const byQty = [...data.items].sort(
        (a, b) => b.quantity - a.quantity || b.revenue - a.revenue || a.name.localeCompare(b.name),
      );
      const byRevenue = [...data.items].sort(
        (a, b) => b.revenue - a.revenue || b.quantity - a.quantity || a.name.localeCompare(b.name),
      );
      const enough =
        data.items.length >= LOW_PERFORMER_MIN_ITEMS && scope.range.days >= LOW_PERFORMER_MIN_DAYS;
      const sorted = sort === 'quantity' ? byQty : byRevenue;
      const totalRevenue = data.items.reduce((t, i) => t + i.revenue, 0);
      return {
        ...meta(scope),
        totals: {
          itemsSold: data.items.reduce((t, i) => t + i.quantity, 0),
          distinctItems: data.items.length,
          revenueMinor: totalRevenue,
        },
        topSelling: byQty.slice(0, TOP_N),
        bestPerforming: byRevenue.slice(0, TOP_N),
        lowPerforming: enough ? byQty.slice(-TOP_N).reverse() : null,
        lowPerformingNote: enough
          ? null
          : `Shown once at least ${LOW_PERFORMER_MIN_ITEMS} different items have sold over ${LOW_PERFORMER_MIN_DAYS}+ days.`,
        unsold: data.unsold,
        categories: data.categories.map((c) => ({
          ...c,
          sharePct: totalRevenue === 0 ? null : Math.round((c.revenue / totalRevenue) * 1000) / 10,
        })),
        items: {
          sort,
          page,
          pageSize,
          total: sorted.length,
          rows: sorted.slice((page - 1) * pageSize, page * pageSize),
        },
      };
    });
  }

  customers(auth: AuthContext, query: AnalyticsQuery) {
    return this.withScope(auth, query, async (db, scope) => {
      const c = await this.customerStats(db, auth, scope);
      return {
        ...meta(scope),
        totalCustomers: compare(c.customers, c.prevCustomers),
        newCustomers: c.newCustomers,
        returningCustomers: c.returningCustomers,
        repeatCustomers: c.repeatCustomers,
        repeatPurchaseRatePct:
          c.customers === 0 ? null : Math.round((c.repeatCustomers / c.customers) * 1000) / 10,
        averageSpendMinor: avg(c.identifiedNetSales, c.customers),
        identifiedOrders: c.identifiedOrders,
        completedOrders: c.completedOrders,
        identifiedOrderSharePct:
          c.completedOrders === 0
            ? null
            : Math.round((c.identifiedOrders / c.completedOrders) * 1000) / 10,
      };
    });
  }

  // ---- internals ----

  private withScope<T>(
    auth: AuthContext,
    query: AnalyticsQuery,
    work: (db: Db, scope: AnalyticsScope) => Promise<T>,
  ): Promise<T> {
    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, async (db) => {
      const access = await this.access.forRequest(db, auth);
      return work(db, await resolveScope(db, access, query));
    });
  }

  private core(db: Db, auth: AuthContext, scope: AnalyticsScope) {
    return this.cached(auth, scope, 'core', async () => {
      // Sequential on purpose: one transaction = one connection; parallel queries would queue.
      const sales = await salesQuery(db, scope);
      const orders = await ordersQuery(db, scope);
      const payments = await paymentsQuery(db, scope);
      const refunds = await refundsQuery(db, scope);
      const activeTables = await activeTablesQuery(db, scope);
      return { sales, orders, payments, refunds, activeTables };
    });
  }

  private customerStats(db: Db, auth: AuthContext, scope: AnalyticsScope) {
    return this.cached(auth, scope, 'customers', () => customersQuery(db, scope));
  }

  /** Cache-aside under the tenant's analytics namespace; the caller has passed resolveScope. */
  private cached<T>(
    auth: AuthContext,
    scope: AnalyticsScope,
    kind: string,
    load: () => Promise<T>,
  ) {
    const ttl = this.cache.ttl(scope.range.partial ? 'analytics' : 'analyticsClosed');
    return this.cache.getOrLoad(
      CacheNs.analytics(auth.tenantId!),
      CacheEntry.analytics(kind, scopeDigest(scope)),
      ttl,
      load,
    );
  }
}

function meta(scope: AnalyticsScope) {
  return {
    restaurant: scope.restaurant,
    restaurants: scope.restaurants,
    branches: scope.branches,
    branchIds: scope.branchIds,
    timezone: scope.timezone,
    currencyCode: scope.restaurant.currencyCode,
    range: {
      from: scope.range.from,
      to: scope.range.to,
      previousFrom: scope.range.prevFrom,
      previousTo: scope.range.prevTo,
      days: scope.range.days,
      partial: scope.range.partial,
      start: scope.bounds.start,
      end: scope.bounds.end,
      previousStart: scope.bounds.prevStart,
      previousEnd: scope.bounds.prevEnd,
    },
    filters: { channel: scope.channel, method: scope.method },
    generatedAt: new Date().toISOString(),
  };
}

function emptySales(): SalesRow {
  return {
    kind: 'all',
    branchId: null,
    channel: null,
    orders: 0,
    gross: 0,
    discounts: 0,
    tax: 0,
    billed: 0,
    prevOrders: 0,
    prevGross: 0,
    prevDiscounts: 0,
    prevTax: 0,
    prevBilled: 0,
  };
}

/** One row per menu item (an item moved between categories appears once, under its latest). */
function mergeItems(lines: ItemSalesRow[]) {
  const map = new Map<
    string,
    {
      menuItemId: string;
      name: string;
      categoryName: string | null;
      deleted: boolean;
      quantity: number;
      revenue: number;
      orders: number;
    }
  >();
  for (const l of lines) {
    const row = map.get(l.menuItemId);
    if (row) {
      row.quantity += l.quantity;
      row.revenue += l.revenue;
      row.orders += l.orders;
    } else {
      map.set(l.menuItemId, {
        menuItemId: l.menuItemId,
        name: l.name,
        categoryName: l.categoryName,
        deleted: l.deleted,
        quantity: l.quantity,
        revenue: l.revenue,
        orders: l.orders,
      });
    }
  }
  return [...map.values()];
}

function mergeCategories(lines: ItemSalesRow[]) {
  const map = new Map<
    string,
    { categoryId: string; name: string; quantity: number; revenue: number }
  >();
  for (const l of lines) {
    const row = map.get(l.categoryId) ?? {
      categoryId: l.categoryId,
      name: l.categoryName ?? 'Removed category',
      quantity: 0,
      revenue: 0,
    };
    row.quantity += l.quantity;
    row.revenue += l.revenue;
    map.set(l.categoryId, row);
  }
  return [...map.values()].sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name));
}
