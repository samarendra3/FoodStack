'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/components/auth/auth-provider';
import { authErrorMessage } from '@/lib/auth/errors';
import { count, inr } from '@/lib/analytics';
import { RankedBars, SERIES } from '../../restaurant/dashboard/charts';
import { BarChart } from '../../restaurant/reports/bar-chart';
import { card } from '../restaurants-panel';

/** GET /platform/analytics: platform-owned data only (no restaurant sales). */
interface PlatformAnalytics {
  tenants: { total: number; byStatus: Record<string, number> };
  activeSubscriptions: number;
  subscriptionsByPlan: { plan: string; billingCycle: string; count: number }[];
  lifetimeRevenue: { currencyCode: string; amountMinor: number }[];
  months: {
    month: string;
    newTenants: number;
    totalTenants: number;
    revenueMinor: number;
    paidInvoices: number;
  }[];
  generatedAt: string;
}

const monthLabel = (m: string) =>
  new Intl.DateTimeFormat('en-IN', { month: 'short', timeZone: 'UTC' }).format(
    new Date(`${m}-01T00:00:00Z`),
  );

export function PlatformAnalyticsPanel() {
  const { client } = useAuth();
  const q = useQuery({
    queryKey: ['platform', 'analytics'],
    queryFn: () => client.request<PlatformAnalytics>('/platform/analytics'),
  });
  const d = q.data;
  if (q.isError) {
    return <div className={cn(card, 'p-5 text-sm text-red-600')}>{authErrorMessage(q.error)}</div>;
  }
  const inrOnly = d?.lifetimeRevenue.every((r) => r.currencyCode === 'INR') ?? true;
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <section className={cn(card, 'p-5 lg:col-span-2')} aria-labelledby="growth-title">
        <h2 id="growth-title" className="text-base font-semibold">
          Restaurant growth
        </h2>
        <p className="text-sm text-muted-foreground">
          New restaurants per month (UTC), last 12 months
        </p>
        <div className="mt-4">
          {!d ? (
            <div className="h-56 animate-pulse rounded-lg bg-muted" aria-busy="true" />
          ) : (
            <BarChart
              ariaLabel="New restaurants per month"
              series={[{ key: 'n', label: 'New restaurants', ...SERIES[0] }]}
              buckets={d.months.map((m) => ({
                key: m.month,
                label: monthLabel(m.month),
                values: { n: m.newTenants * 100 },
              }))}
              format={(v) => count(Math.round(v / 100))}
            />
          )}
        </div>
      </section>
      <section className={cn(card, 'p-5')} aria-labelledby="subs-title">
        <h2 id="subs-title" className="text-base font-semibold">
          Active subscriptions
        </h2>
        <p className="text-sm text-muted-foreground">Paid plans in their current period</p>
        {!d ? (
          <div className="mt-4 h-40 animate-pulse rounded-lg bg-muted" />
        ) : (
          <>
            <p className="mt-3 text-3xl font-semibold tabular-nums">
              {count(d.activeSubscriptions)}
            </p>
            <div className="mt-4">
              {d.subscriptionsByPlan.length ? (
                <RankedBars
                  ariaLabel="Active subscriptions by plan"
                  format={count}
                  rows={d.subscriptionsByPlan.map((p) => ({
                    key: `${p.plan}-${p.billingCycle}`,
                    label: p.plan,
                    note: p.billingCycle,
                    value: p.count,
                  }))}
                />
              ) : (
                <p className="text-sm text-muted-foreground">No paid subscriptions yet.</p>
              )}
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              On trial: {count(d.tenants.byStatus.trial ?? 0)} · Suspended:{' '}
              {count(d.tenants.byStatus.suspended ?? 0)}
            </p>
          </>
        )}
      </section>
      <section className={cn(card, 'p-5 lg:col-span-3')} aria-labelledby="rev-title">
        <h2 id="rev-title" className="text-base font-semibold">
          Subscription revenue
        </h2>
        <p className="text-sm text-muted-foreground">
          Verified subscription invoices by payment month (FoodStack revenue, not restaurant sales)
          {d && d.lifetimeRevenue.length
            ? ` · lifetime ${d.lifetimeRevenue.map((r) => inr(r.amountMinor, r.currencyCode)).join(' + ')}`
            : ''}
        </p>
        <div className="mt-4">
          {!d ? (
            <div className="h-56 animate-pulse rounded-lg bg-muted" />
          ) : d.months.every((m) => !m.revenueMinor) ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No subscription payments in the last 12 months.
            </p>
          ) : (
            <BarChart
              ariaLabel="Subscription revenue per month"
              series={[
                {
                  key: 'r',
                  label: inrOnly ? 'Revenue (INR)' : 'Revenue (all currencies)',
                  ...SERIES[2],
                },
              ]}
              buckets={d.months.map((m) => ({
                key: m.month,
                label: monthLabel(m.month),
                values: { r: m.revenueMinor },
              }))}
              format={(v) => inr(v)}
            />
          )}
        </div>
      </section>
    </div>
  );
}
