import { Injectable } from '@nestjs/common';
import { DbContext } from '../../core/db/db-context';
import { CacheEntry, CacheNs } from '../../shared/cache/cache.keys';
import { CacheService } from '../../shared/cache/cache.service';

const MONTHS = 12;

/**
 * Super Admin analytics over platform-owned data only: tenants (each tenant is one restaurant
 * business), subscriptions, plans and paid SaaS invoices. Runs in the platform RLS context,
 * which cannot read tenant sales, so restaurants' own revenue is never aggregated here.
 * Months are UTC calendar months.
 */
@Injectable()
export class PlatformAnalyticsService {
  constructor(
    private readonly db: DbContext,
    private readonly cache: CacheService,
  ) {}

  overview(userId: string) {
    return this.db.run({ platform: true, userId }, (db) =>
      this.cache.getOrLoad(
        CacheNs.platformAnalytics(),
        CacheEntry.platformAnalytics,
        this.cache.ttl('platformAnalytics'),
        async () => {
          const months = await db.query<{
            month: string;
            new_tenants: string;
            total_tenants: string;
            revenue_minor: string;
            paid_invoices: string;
          }>(
            `WITH m AS (
               SELECT gs AS s, gs + interval '1 month' AS e FROM generate_series(
                 date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => $1::int - 1),
                 date_trunc('month', now() AT TIME ZONE 'UTC'), interval '1 month') gs),
             b AS (SELECT s, s AT TIME ZONE 'UTC' AS lo, e AT TIME ZONE 'UTC' AS hi FROM m)
             SELECT to_char(b.s, 'YYYY-MM') AS month,
                    (SELECT count(*) FROM tenants t WHERE t.created_at >= b.lo AND t.created_at < b.hi) AS new_tenants,
                    (SELECT count(*) FROM tenants t WHERE t.created_at < b.hi) AS total_tenants,
                    (SELECT coalesce(sum(i.amount_minor), 0) FROM subscription_invoices i
                      WHERE i.status = 'paid' AND i.paid_at >= b.lo AND i.paid_at < b.hi) AS revenue_minor,
                    (SELECT count(*) FROM subscription_invoices i
                      WHERE i.status = 'paid' AND i.paid_at >= b.lo AND i.paid_at < b.hi) AS paid_invoices
               FROM b ORDER BY b.s`,
            [MONTHS],
          );
          const tenants = await db.query<{ status: string; count: string }>(
            'SELECT status, count(*) AS count FROM tenants GROUP BY status',
          );
          const plans = await db.query<{ plan: string; cycle: string; count: string }>(
            `SELECT p.name AS plan, s.billing_cycle AS cycle, count(*) AS count
               FROM subscriptions s JOIN plans p ON p.id = s.plan_id
              WHERE s.status = 'active' AND s.current_period_end > now()
              GROUP BY p.name, s.billing_cycle ORDER BY count(*) DESC, p.name`,
          );
          const lifetime = await db.query<{ currency_code: string; revenue_minor: string }>(
            `SELECT currency_code, sum(amount_minor) AS revenue_minor FROM subscription_invoices
              WHERE status = 'paid' GROUP BY currency_code ORDER BY currency_code`,
          );
          const byStatus = Object.fromEntries(tenants.map((t) => [t.status, Number(t.count)]));
          return {
            tenants: {
              total: Object.values(byStatus).reduce((a, b) => a + b, 0),
              byStatus: { trial: 0, active: 0, suspended: 0, deactivated: 0, ...byStatus },
            },
            activeSubscriptions: plans.reduce((t, p) => t + Number(p.count), 0),
            subscriptionsByPlan: plans.map((p) => ({
              plan: p.plan,
              billingCycle: p.cycle,
              count: Number(p.count),
            })),
            lifetimeRevenue: lifetime.map((c) => ({
              currencyCode: c.currency_code.trim(),
              amountMinor: Number(c.revenue_minor),
            })),
            months: months.map((m) => ({
              month: m.month,
              newTenants: Number(m.new_tenants),
              totalTenants: Number(m.total_tenants),
              revenueMinor: Number(m.revenue_minor),
              paidInvoices: Number(m.paid_invoices),
            })),
            generatedAt: new Date().toISOString(),
          };
        },
      ),
    );
  }
}
