'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import {
  Armchair,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Ban,
  Building2,
  CheckCircle2,
  ClipboardList,
  Clock,
  Coins,
  CreditCard,
  Flame,
  type LucideIcon,
  NotebookText,
  Plus,
  Receipt,
  ShoppingCart,
  Tags,
  UserPlus,
  UsersRound,
  Zap,
} from 'lucide-react';
import { motion } from 'motion/react';
import Link from 'next/link';
import { type ReactNode, useState } from 'react';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { AnimatedBar, AnimatedNumber, SpotlightCard } from '@/components/motion/primitives';
import {
  type BranchStats,
  CHANNEL_LABEL,
  type Compared,
  type CustomerStats,
  count,
  type Filters,
  inr,
  METHOD_LABEL,
  type MenuStats,
  PRESETS,
  type Preset,
  type Summary,
  type Trend,
  useAnalytics,
} from '@/lib/analytics';
import { canAccessPath, hasPermissionAnywhere } from '@/lib/auth/access';
import { authErrorMessage } from '@/lib/auth/errors';
import { useEntitlement } from '@/lib/billing';
import { BarChart } from '../reports/bar-chart';
import { Donut, LineChart, RankedBars, SERIES } from './charts';

const ease = [0.22, 1, 0.36, 1] as const;
const fullDate = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});
const pillDate = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

const rise = (i: number) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.45, delay: 0.04 + i * 0.04, ease },
});

const control =
  'h-9 rounded-md border border-slate-200 bg-white px-2.5 text-sm text-slate-700 shadow-xs focus-visible:ring-2 focus-visible:ring-emerald-500/40 focus-visible:outline-none dark:border-white/10 dark:bg-white/5 dark:text-slate-200 [&>option]:text-slate-900';

export default function RestaurantDashboardPage() {
  const profile = useProfile();
  const canReport = hasPermissionAnywhere(profile, 'report:view');
  const [filters, setFilters] = useState<Filters>({ preset: 'today' });
  const [tab, setTab] = useState<'overview' | 'sales'>('overview');
  const summary = useAnalytics<Summary>('summary', filters, {}, canReport);

  return (
    <div data-own-motion className="mx-auto max-w-[96rem] space-y-5">
      <Welcome />
      <TrialCard />

      {!canReport ? (
        <>
          <TeamCard />
          <SpotlightCard className="p-5 text-sm text-muted-foreground">
            Sales analytics are available to owners, admins, branch managers and accountants.
          </SpotlightCard>
          <QuickActions />
        </>
      ) : (
        <>
          <Toolbar
            filters={filters}
            onChange={setFilters}
            summary={summary.data}
            tab={tab}
            onTab={setTab}
          />
          {summary.isError ? (
            <p
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
            >
              {authErrorMessage(summary.error)}
            </p>
          ) : null}
          {tab === 'overview' ? (
            <Overview filters={filters} summary={summary.data} loading={summary.isPending} />
          ) : (
            <SalesDetail filters={filters} currency={summary.data?.currencyCode ?? 'INR'} />
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- toolbar

function Toolbar({
  filters,
  onChange,
  summary,
  tab,
  onTab,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  summary?: Summary;
  tab: 'overview' | 'sales';
  onTab: (t: 'overview' | 'sales') => void;
}) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  const restaurants = summary?.restaurants ?? [];
  const branches = summary?.branches ?? [];
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div
        role="tablist"
        aria-label="Dashboard view"
        className="flex rounded-xl border border-slate-200 p-1 text-sm dark:border-white/10"
      >
        {(
          [
            ['overview', 'Overview'],
            ['sales', 'Menu & customers'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => onTab(key)}
            className={cn(
              'relative isolate rounded-lg px-3 py-1 font-medium whitespace-nowrap transition-colors',
              tab === key
                ? 'text-white'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-300',
            )}
          >
            {tab === key ? (
              <motion.span
                layoutId="dash-tab"
                className="absolute inset-0 -z-10 rounded-lg bg-emerald-600"
                transition={{ type: 'spring', stiffness: 420, damping: 34 }}
              />
            ) : null}
            {label}
          </button>
        ))}
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        aria-label="Analytics filters"
        onSubmit={(e) => e.preventDefault()}
      >
        <select
          aria-label="Date range"
          className={control}
          value={filters.preset}
          onChange={(e) => set({ preset: e.target.value as Preset })}
        >
          {PRESETS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        {filters.preset === 'custom' ? (
          <>
            <input
              type="date"
              aria-label="From"
              className={control}
              value={filters.from ?? ''}
              max={filters.to}
              onChange={(e) => set({ from: e.target.value || undefined })}
            />
            <input
              type="date"
              aria-label="To"
              className={control}
              value={filters.to ?? ''}
              min={filters.from}
              onChange={(e) => set({ to: e.target.value || undefined })}
            />
          </>
        ) : null}
        {restaurants.length > 1 ? (
          <select
            aria-label="Restaurant"
            className={control}
            value={filters.restaurantId ?? summary?.restaurant.id ?? ''}
            onChange={(e) => set({ restaurantId: e.target.value, branchId: undefined })}
          >
            {restaurants.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        ) : null}
        {branches.length > 1 ? (
          <select
            aria-label="Branch"
            className={control}
            value={filters.branchId ?? ''}
            onChange={(e) => set({ branchId: e.target.value || undefined })}
          >
            <option value="">All branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        ) : null}
        <select
          aria-label="Order type"
          className={control}
          value={filters.channel ?? ''}
          onChange={(e) => set({ channel: e.target.value || undefined })}
        >
          <option value="">All order types</option>
          {Object.entries(CHANNEL_LABEL).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select
          aria-label="Payment method"
          className={control}
          value={filters.method ?? ''}
          onChange={(e) => set({ method: e.target.value || undefined })}
        >
          <option value="">All payment methods</option>
          {Object.entries(METHOD_LABEL).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </form>
      {summary ? (
        <p className="w-full text-xs text-muted-foreground">
          {rangeText(summary)} · {summary.timezone}
          {summary.branches.length === 1 ? ` · ${summary.branches[0]!.name}` : ''} · compared with{' '}
          {summary.range.previousFrom === summary.range.previousTo
            ? summary.range.previousFrom
            : `${summary.range.previousFrom} – ${summary.range.previousTo}`}
          {summary.range.partial ? ' up to the same time' : ''} · updated{' '}
          {new Date(summary.generatedAt).toLocaleTimeString()}
        </p>
      ) : null}
    </div>
  );
}

const rangeText = (s: { range: { from: string; to: string } }) =>
  s.range.from === s.range.to ? s.range.from : `${s.range.from} – ${s.range.to}`;

// ---------------------------------------------------------------- overview

function Overview({
  filters,
  summary,
  loading,
}: {
  filters: Filters;
  summary?: Summary;
  loading: boolean;
}) {
  const cur = summary?.currencyCode ?? 'INR';
  const money = (v: number) => inr(v, cur);
  const k = summary?.kpis;
  const multiBranch = (summary?.branchIds.length ?? 0) > 1;
  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          i={0}
          icon={Coins}
          tone="emerald"
          label="Total revenue"
          hint="Net sales: completed orders, after discounts, before tax"
          value={k?.totalRevenue.value}
          cmp={k?.totalRevenue}
          format={money}
          loading={loading}
        />
        <Kpi
          i={1}
          icon={ShoppingCart}
          tone="violet"
          label="Total orders"
          hint="Orders placed in the period"
          value={k?.totalOrders.value}
          cmp={k?.totalOrders}
          loading={loading}
        />
        <Kpi
          i={2}
          icon={CheckCircle2}
          tone="blue"
          label="Completed orders"
          hint="Fully paid"
          value={k?.completedOrders.value}
          cmp={k?.completedOrders}
          loading={loading}
        />
        <Kpi
          i={3}
          icon={Clock}
          tone="orange"
          label="Pending orders"
          hint="Not yet being prepared (kitchen new or accepted)"
          value={k?.pendingOrders.value}
          loading={loading}
        />
        <Kpi
          i={4}
          icon={Ban}
          tone="slate"
          label="Cancelled orders"
          value={k?.cancelledOrders.value}
          cmp={k?.cancelledOrders}
          invert
          loading={loading}
        />
        <Kpi
          i={5}
          icon={Receipt}
          tone="emerald"
          label="Average order value"
          hint="Net sales ÷ completed orders"
          value={k?.averageOrderValue.value ?? undefined}
          empty={k && k.averageOrderValue.value === null ? 'No completed orders' : undefined}
          cmp={
            k?.averageOrderValue.value !== null && k?.averageOrderValue.previous !== null && k
              ? {
                  value: k.averageOrderValue.value!,
                  previous: k.averageOrderValue.previous!,
                  changePct: k.averageOrderValue.changePct,
                }
              : undefined
          }
          format={money}
          loading={loading}
        />
        <Kpi
          i={6}
          icon={UsersRound}
          tone="blue"
          label="Customers"
          hint="Identified customers with a completed order"
          value={k?.totalCustomers.value}
          cmp={k?.totalCustomers}
          loading={loading}
        />
        <Kpi
          i={7}
          icon={Armchair}
          tone="orange"
          label="Active tables"
          hint="Tables with an open dine-in order right now"
          value={k?.activeTables.value}
          loading={loading}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <RevenueTrend filters={filters} currency={cur} />
        </div>
        <OrderStatus summary={summary} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <RevenueBreakdown summary={summary} />
        <PaymentMethods summary={summary} />
        <QuickActions />
      </div>

      {multiBranch ? <BranchComparison filters={filters} currency={cur} /> : null}
    </>
  );
}

function RevenueTrend({ filters, currency }: { filters: Filters; currency: string }) {
  const trend = useAnalytics<Trend>('trend', filters);
  const t = trend.data;
  const [metric, setMetric] = useState<'money' | 'orders'>('money');
  const label = (b: string, long: boolean) => {
    if (!t) return b;
    const d = new Date(`${b}:00Z`);
    const opts: Intl.DateTimeFormatOptions =
      t.granularity === 'hour'
        ? { hour: 'numeric', ...(long ? { day: 'numeric', month: 'short' } : {}) }
        : t.granularity === 'day'
          ? { day: 'numeric', month: 'short', ...(long ? { weekday: 'short' } : {}) }
          : { month: 'short', ...(long ? { year: 'numeric' } : {}) };
    return new Intl.DateTimeFormat('en-IN', { ...opts, timeZone: 'UTC' }).format(d);
  };
  const empty = t && t.points.every((p) => !p.netSales && !p.ordersPlaced && !p.collected);
  return (
    <SpotlightCard {...rise(8)} className="h-full p-5">
      <CardHead
        icon={BarChart3}
        title={metric === 'money' ? 'Revenue trend' : 'Order trend'}
        subtitle={
          metric === 'money'
            ? 'Net sales and payments collected, local time'
            : 'Orders placed and cancelled, local time'
        }
        aside={
          <div
            className="flex rounded-lg border border-slate-200 p-0.5 text-xs dark:border-white/10"
            role="group"
            aria-label="Trend metric"
          >
            {(
              [
                ['money', 'Revenue'],
                ['orders', 'Orders'],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                type="button"
                aria-pressed={metric === k}
                onClick={() => setMetric(k)}
                className={cn(
                  'rounded-md px-2.5 py-1 font-medium',
                  metric === k
                    ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                    : 'text-muted-foreground',
                )}
              >
                {l}
              </button>
            ))}
          </div>
        }
      />
      <div className="mt-4">
        {trend.isError ? (
          <ErrorNote error={trend.error} />
        ) : !t ? (
          <ChartSkeleton />
        ) : empty ? (
          <EmptyNote
            icon={BarChart3}
            title="No sales in this period"
            text="Revenue appears here once orders are billed at the POS."
          />
        ) : metric === 'money' ? (
          <LineChart
            ariaLabel="Net sales and collected payments over time"
            series={[
              { key: 'net', label: 'Net sales' },
              { key: 'collected', label: 'Collected' },
            ]}
            points={t.points.map((p) => ({
              key: p.bucket,
              label: label(p.bucket, false),
              long: label(p.bucket, true),
              values: { net: p.netSales, collected: p.collected - p.refunds },
            }))}
            format={(v) => inr(v, currency)}
            axisFormat={(v) => compactInr(v)}
          />
        ) : (
          <BarChart
            ariaLabel="Orders placed and cancelled over time"
            series={[
              { key: 'placed', label: 'Orders placed', ...SERIES[0] },
              { key: 'cancelled', label: 'Cancelled', ...SERIES[1] },
            ]}
            buckets={t.points.map((p) => ({
              key: p.bucket,
              label: label(p.bucket, false),
              values: { placed: p.ordersPlaced * 100, cancelled: p.cancelled * 100 },
            }))}
            format={(v) => count(Math.round(v / 100))}
          />
        )}
      </div>
    </SpotlightCard>
  );
}

const compactInr = (minor: number) =>
  `₹${new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(minor / 100)}`;

function OrderStatus({ summary }: { summary?: Summary }) {
  const o = summary?.orders;
  return (
    <SpotlightCard {...rise(9)} className="h-full p-5">
      <CardHead icon={ClipboardList} title="Order status" subtitle="Orders placed in the period" />
      <div className="mt-5">
        {!o ? (
          <ChartSkeleton short />
        ) : o.total === 0 ? (
          <EmptyNote
            icon={ClipboardList}
            title="No orders in this period"
            text="Orders from the POS and waiters appear here."
          />
        ) : (
          <>
            <Donut
              ariaLabel="Orders by billing status"
              center={count(o.total)}
              caption="orders"
              parts={[
                { label: 'Completed (paid)', value: o.completed },
                { label: 'Open (unpaid)', value: o.open },
                { label: 'Cancelled', value: o.cancelled },
              ]}
            />
            <dl className="mt-5 grid grid-cols-4 gap-2 border-t pt-4 text-center text-xs">
              {(
                [
                  ['Pending', o.pending],
                  ['Preparing', o.preparing],
                  ['Ready', o.ready],
                  ['Served', o.served],
                ] as const
              ).map(([l, v]) => (
                <div key={l}>
                  <dt className="text-muted-foreground">{l}</dt>
                  <dd className="mt-0.5 text-base font-semibold tabular-nums">{count(v)}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-center text-[11px] text-muted-foreground">
              Kitchen status of non-cancelled orders
            </p>
          </>
        )}
      </div>
    </SpotlightCard>
  );
}

function RevenueBreakdown({ summary }: { summary?: Summary }) {
  const r = summary?.revenue;
  const cur = summary?.currencyCode ?? 'INR';
  const rows: [string, Compared | undefined, string?][] = [
    ['Gross sales', r?.grossSales, 'Item totals of completed orders'],
    ['Discounts', r?.discounts],
    ['Net sales', r?.netSales, 'Gross − discounts, before tax'],
    ['Tax', r?.tax],
    ['Billed total', r?.billedTotal],
    ['Payments collected', r?.collected, 'All payments received, incl. part-payments'],
    ['Refunds', r?.refunds, 'Refunds issued in the period'],
    ['Net collected', r?.netCollected, 'Collected − refunds'],
  ];
  return (
    <SpotlightCard {...rise(10)} className="h-full p-5">
      <CardHead
        icon={Coins}
        title="Revenue breakdown"
        subtitle="Sales by completion time; money by payment and refund time"
      />
      <dl className="mt-4 divide-y text-sm">
        {rows.map(([label, c, hint]) => (
          <div
            key={label}
            className={cn(
              'flex items-center justify-between gap-3 py-2',
              (label === 'Net sales' || label === 'Net collected') && 'font-semibold',
            )}
          >
            <dt className="min-w-0">
              {label}
              {hint ? (
                <span className="block text-[11px] font-normal text-muted-foreground">{hint}</span>
              ) : null}
            </dt>
            <dd className="text-right tabular-nums">
              {c ? (
                <>
                  {label === 'Discounts' || label === 'Refunds' ? (c.value ? '−' : '') : ''}
                  {inr(Math.abs(c.value), cur)}
                  {c.value < 0 ? <span className="sr-only"> (negative)</span> : null}
                </>
              ) : (
                <span className="inline-block h-4 w-16 animate-pulse rounded bg-muted" />
              )}
            </dd>
          </div>
        ))}
      </dl>
    </SpotlightCard>
  );
}

function PaymentMethods({ summary }: { summary?: Summary }) {
  const cur = summary?.currencyCode ?? 'INR';
  const rows = summary?.byMethod ?? [];
  const any = rows.some((m) => m.collectedMinor || m.refundsMinor);
  return (
    <SpotlightCard {...rise(11)} className="h-full p-5">
      <CardHead icon={CreditCard} title="Payment methods" subtitle="Net collected per method" />
      <div className="mt-4">
        {!summary ? (
          <ChartSkeleton short />
        ) : !any ? (
          <EmptyNote
            icon={CreditCard}
            title="No payments in this period"
            text="Cash, card and UPI payments appear here."
          />
        ) : (
          <>
            <RankedBars
              ariaLabel="Net collected by payment method"
              format={(v) => inr(v, cur)}
              rows={rows.map((m) => ({
                key: m.method,
                label: METHOD_LABEL[m.method] ?? m.method,
                value: Math.max(0, m.netMinor),
                note: `${count(m.orders)} order${m.orders === 1 ? '' : 's'}${m.refundsMinor ? ` · ${inr(m.refundsMinor, cur)} refunded` : ''}`,
              }))}
            />
            <p className="mt-4 text-[11px] text-muted-foreground">
              An order paid by two methods counts under both.
            </p>
          </>
        )}
      </div>
      {summary ? (
        <div className="mt-5 border-t pt-4">
          <p className="mb-3 text-sm font-medium">By order type</p>
          <RankedBars
            ariaLabel="Net sales by order type"
            colorIndex={2}
            format={(v) => inr(v, cur)}
            rows={summary.byChannel
              .filter((c) => c.orders || c.netSalesMinor)
              .map((c) => ({
                key: c.channel,
                label: CHANNEL_LABEL[c.channel] ?? c.channel,
                value: c.netSalesMinor,
                note: `${count(c.orders)} orders`,
              }))}
          />
        </div>
      ) : null}
    </SpotlightCard>
  );
}

function BranchComparison({ filters, currency }: { filters: Filters; currency: string }) {
  const q = useAnalytics<BranchStats>('branches', filters);
  const d = q.data;
  return (
    <SpotlightCard {...rise(12)} className="p-5">
      <CardHead icon={Building2} title="Branch performance" subtitle="Ranked by net sales" />
      <div className="mt-4">
        {q.isError ? (
          <ErrorNote error={q.error} />
        ) : !d ? (
          <ChartSkeleton short />
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            <BarChart
              ariaLabel="Net sales per branch"
              series={[{ key: 'net', label: 'Net sales', ...SERIES[0] }]}
              buckets={d.rows.map((r) => ({
                key: r.id,
                label: r.name,
                values: { net: r.netSales.value },
              }))}
              format={(v) => inr(v, currency)}
            />
            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full min-w-[34rem] text-sm">
                <thead className="bg-muted/60 text-left text-xs font-semibold text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">#</th>
                    <th className="px-3 py-2">Branch</th>
                    <th className="px-3 py-2 text-right">Net sales</th>
                    <th className="px-3 py-2 text-right">Change</th>
                    <th className="px-3 py-2 text-right">Orders</th>
                    <th className="px-3 py-2 text-right">Avg order</th>
                    <th className="px-3 py-2 text-right">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.id} className="border-t">
                      <td className="px-3 py-2 tabular-nums">{r.rank}</td>
                      <td className="px-3 py-2 font-medium">{r.name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {inr(r.netSales.value, currency)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Delta pct={r.netSales.changePct} />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {count(r.ordersPlaced.value)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.averageOrderValueMinor === null
                          ? '—'
                          : inr(r.averageOrderValueMinor, currency)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.sharePct === null ? '—' : `${r.sharePct}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </SpotlightCard>
  );
}

// ---------------------------------------------------------------- menu & customers

function SalesDetail({ filters, currency }: { filters: Filters; currency: string }) {
  const [sort, setSort] = useState<'revenue' | 'quantity'>('revenue');
  const [page, setPage] = useState(1);
  const menu = useAnalytics<MenuStats>('menu', filters, { sort, page, pageSize: 10 });
  const m = menu.data;
  const money = (v: number) => inr(v, currency);
  return (
    <>
      <CustomersRow filters={filters} currency={currency} />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <SpotlightCard {...rise(1)} className="p-5">
          <CardHead icon={Flame} title="Top-selling items" subtitle="By quantity sold" />
          <div className="mt-4">
            {!m ? (
              <ChartSkeleton short />
            ) : m.topSelling.length === 0 ? (
              <EmptyNote
                icon={Flame}
                title="No items sold in this period"
                text="Best sellers rank here once orders are completed."
              />
            ) : (
              <RankedBars
                ariaLabel="Top-selling items by quantity"
                format={count}
                rows={m.topSelling.map((i) => ({
                  key: i.menuItemId,
                  label: i.name,
                  value: i.quantity,
                  note: i.deleted ? 'removed' : undefined,
                }))}
              />
            )}
          </div>
        </SpotlightCard>
        <SpotlightCard {...rise(2)} className="p-5">
          <CardHead
            icon={Tags}
            title="Category sales"
            subtitle="Item revenue after discounts, before tax"
          />
          <div className="mt-4">
            {!m ? (
              <ChartSkeleton short />
            ) : m.categories.length === 0 ? (
              <EmptyNote
                icon={Tags}
                title="No category sales yet"
                text="Categories rank here once orders are completed."
              />
            ) : (
              <RankedBars
                ariaLabel="Revenue by menu category"
                colorIndex={1}
                format={money}
                rows={m.categories.map((c) => ({
                  key: c.categoryId,
                  label: c.name,
                  value: c.revenue,
                  note: c.sharePct === null ? undefined : `${c.sharePct}%`,
                }))}
              />
            )}
          </div>
        </SpotlightCard>
        <SpotlightCard {...rise(3)} className="p-5">
          <CardHead
            icon={NotebookText}
            title="Needs attention"
            subtitle="Lowest sellers and items with no sales"
          />
          <div className="mt-4 space-y-4 text-sm">
            {!m ? (
              <ChartSkeleton short />
            ) : (
              <>
                {m.lowPerforming ? (
                  <RankedBars
                    ariaLabel="Lowest-selling items"
                    colorIndex={3}
                    format={count}
                    rows={m.lowPerforming.map((i) => ({
                      key: i.menuItemId,
                      label: i.name,
                      value: i.quantity,
                    }))}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">{m.lowPerformingNote}</p>
                )}
                <div>
                  <p className="font-medium">
                    Not sold in this period ({count(m.unsold.length)}
                    {m.unsold.length === 50 ? '+' : ''})
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {m.unsold.length
                      ? m.unsold
                          .slice(0, 12)
                          .map((u) => u.name)
                          .join(', ') + (m.unsold.length > 12 ? '…' : '')
                      : 'Every available item sold at least once.'}
                  </p>
                </div>
              </>
            )}
          </div>
        </SpotlightCard>
      </div>

      <SpotlightCard {...rise(4)} className="p-5">
        <CardHead
          icon={ClipboardList}
          title="Item performance"
          subtitle={
            m
              ? `${count(m.totals.itemsSold)} sold · ${count(m.totals.distinctItems)} items · ${money(m.totals.revenueMinor)}`
              : undefined
          }
          aside={
            <select
              aria-label="Sort items"
              className={control}
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as 'revenue' | 'quantity');
                setPage(1);
              }}
            >
              <option value="revenue">By revenue</option>
              <option value="quantity">By quantity</option>
            </select>
          }
        />
        <div className="mt-4 overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="bg-muted/60 text-left text-xs font-semibold text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2 text-right">Quantity</th>
                <th className="px-3 py-2 text-right">Orders</th>
                <th className="px-3 py-2 text-right">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {!m ? (
                Array.from({ length: 5 }, (_, i) => (
                  <tr key={i} className="border-t">
                    <td colSpan={5} className="px-3 py-2">
                      <div className="h-4 animate-pulse rounded bg-muted" />
                    </td>
                  </tr>
                ))
              ) : m.items.rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                    No items sold in this period.
                  </td>
                </tr>
              ) : (
                m.items.rows.map((i) => (
                  <tr key={i.menuItemId} className="border-t">
                    <td className="px-3 py-2 font-medium">
                      {i.name}
                      {i.deleted ? (
                        <span className="ml-1.5 text-xs text-muted-foreground">(removed)</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{i.categoryName ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{count(i.quantity)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{count(i.orders)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(i.revenue)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {m && m.items.total > m.items.pageSize ? (
          <div className="mt-3 flex items-center justify-end gap-2 text-sm">
            <span className="text-muted-foreground">
              Page {m.items.page} of {Math.ceil(m.items.total / m.items.pageSize)}
            </span>
            <button
              type="button"
              className={control}
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </button>
            <button
              type="button"
              className={control}
              disabled={page * m.items.pageSize >= m.items.total}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        ) : null}
      </SpotlightCard>
    </>
  );
}

function CustomersRow({ filters, currency }: { filters: Filters; currency: string }) {
  const q = useAnalytics<CustomerStats>('customers', filters);
  const c = q.data;
  const pct = (v: number | null) => (v === null ? '—' : `${v}%`);
  const tiles: [string, string | undefined, string][] = [
    ['Customers', c && count(c.totalCustomers.value), 'With a completed order'],
    ['New', c && count(c.newCustomers), 'First order in this period'],
    ['Returning', c && count(c.returningCustomers), 'Ordered before this period'],
    ['Repeat purchase rate', c && pct(c.repeatPurchaseRatePct), '2+ orders in this period'],
    [
      'Average spend',
      c && (c.averageSpendMinor === null ? '—' : inr(c.averageSpendMinor, currency)),
      'Net sales per customer',
    ],
    [
      'Orders with a customer',
      c && pct(c.identifiedOrderSharePct),
      c ? `${count(c.identifiedOrders)} of ${count(c.completedOrders)} completed` : '',
    ],
  ];
  return (
    <SpotlightCard {...rise(0)} className="p-5">
      <CardHead
        icon={UsersRound}
        title="Customers"
        subtitle="Only orders with a customer name and phone count — walk-in orders are never guessed"
      />
      {q.isError ? (
        <div className="mt-4">
          <ErrorNote error={q.error} />
        </div>
      ) : (
        <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
          {tiles.map(([label, value, hint]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums">
                {value ?? <span className="inline-block h-6 w-12 animate-pulse rounded bg-muted" />}
              </dd>
              <dd className="text-[11px] text-muted-foreground">{hint}</dd>
            </div>
          ))}
        </dl>
      )}
    </SpotlightCard>
  );
}

// ---------------------------------------------------------------- shared pieces

function Welcome() {
  const profile = useProfile();
  const today = new Date();
  const restaurant = profile.activeTenant?.name ?? 'your restaurant';
  return (
    <motion.section
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease }}
      className="flex flex-wrap items-end justify-between gap-4"
    >
      <div className="min-w-0">
        <p className="text-sm text-slate-500 dark:text-slate-400">{fullDate.format(today)}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900 dark:text-white">
          Welcome back, {profile.user.fullName}
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Here&apos;s how{' '}
          <span className="font-medium text-slate-700 dark:text-slate-200">{restaurant}</span> is
          doing.
        </p>
      </div>
    </motion.section>
  );
}

const TONES = {
  emerald: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15',
  violet: 'bg-violet-50 text-violet-600 dark:bg-violet-500/15',
  orange: 'bg-orange-50 text-orange-500 dark:bg-orange-500/15',
  blue: 'bg-blue-50 text-blue-600 dark:bg-blue-500/15',
  slate: 'bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-slate-300',
};

function Delta({ pct, invert = false }: { pct: number | null | undefined; invert?: boolean }) {
  if (pct === null || pct === undefined)
    return <span className="text-xs text-muted-foreground">—</span>;
  const up = pct > 0;
  const good = pct === 0 ? null : invert ? !up : up;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-xs font-medium tabular-nums',
        good === null
          ? 'text-muted-foreground'
          : good
            ? 'text-emerald-700 dark:text-emerald-400'
            : 'text-red-600 dark:text-red-400',
      )}
    >
      {pct !== 0 ? <Icon className="size-3.5" aria-hidden /> : null}
      {up ? '+' : ''}
      {pct}%<span className="sr-only">{up ? ' increase' : pct < 0 ? ' decrease' : ''}</span>
    </span>
  );
}

function Kpi({
  i,
  icon: Icon,
  tone,
  label,
  hint,
  value,
  cmp,
  format,
  empty,
  invert,
  loading,
}: {
  i: number;
  icon: LucideIcon;
  tone: keyof typeof TONES;
  label: string;
  hint?: string;
  value?: number;
  cmp?: Compared;
  format?: (v: number) => string;
  empty?: string;
  invert?: boolean;
  loading: boolean;
}) {
  return (
    <SpotlightCard {...rise(i)} className="flex h-full flex-row-reverse items-start gap-4 p-5">
      <span
        className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', TONES[tone])}
      >
        <Icon className="size-[18px]" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-500 dark:text-slate-400" title={hint}>
          {label}
        </p>
        {value !== undefined ? (
          <>
            <p className="mt-1 text-2xl leading-none font-semibold tracking-tight tabular-nums">
              {format ? format(value) : <AnimatedNumber value={value} />}
            </p>
            <p className="mt-1.5 flex items-center gap-1.5 truncate text-xs text-slate-500">
              {cmp ? (
                <>
                  <Delta pct={cmp.changePct} invert={invert} />
                  <span>vs {format ? format(cmp.previous) : count(cmp.previous)}</span>
                </>
              ) : (
                hint
              )}
            </p>
          </>
        ) : loading ? (
          <div className="mt-2 h-7 w-20 animate-pulse rounded bg-slate-100 dark:bg-white/10" />
        ) : (
          <>
            <p className="mt-1 text-2xl leading-none font-semibold text-slate-300 dark:text-slate-600">
              —
            </p>
            <p className="mt-1.5 truncate text-xs text-slate-500">{empty ?? 'No data'}</p>
          </>
        )}
      </div>
    </SpotlightCard>
  );
}

function CardHead({
  icon: Icon,
  title,
  subtitle,
  aside,
}: {
  icon?: LucideIcon;
  title: string;
  subtitle?: string;
  aside?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        {Icon ? <Icon className="mt-0.5 size-[18px] text-slate-400" aria-hidden /> : null}
        <div>
          <h2 className="text-base font-semibold tracking-tight text-slate-900 dark:text-white">
            {title}
          </h2>
          {subtitle ? <p className="text-sm text-slate-500">{subtitle}</p> : null}
        </div>
      </div>
      {aside}
    </div>
  );
}

function EmptyNote({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15">
        <Icon className="size-5" aria-hidden />
      </span>
      <p className="mt-3 text-sm font-semibold">{title}</p>
      <p className="mt-1 max-w-xs text-xs text-slate-500">{text}</p>
    </div>
  );
}

function ErrorNote({ error }: { error: unknown }) {
  return (
    <p
      role="alert"
      className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300"
    >
      {authErrorMessage(error)}
    </p>
  );
}

function ChartSkeleton({ short = false }: { short?: boolean }) {
  return (
    <div
      className={cn('flex animate-pulse items-end gap-2', short ? 'h-32' : 'h-56')}
      aria-busy="true"
      aria-label="Loading chart"
    >
      {[40, 65, 50, 80, 60, 90, 70, 55].map((h, i) => (
        <div key={i} className="flex-1 rounded-t bg-muted" style={{ height: `${h}%` }} />
      ))}
    </div>
  );
}

interface TeamSummary {
  members: { status: 'active' | 'invited' | 'suspended' }[];
}

function TeamCard() {
  const { client } = useAuth();
  const profile = useProfile();
  const canSeeTeam = hasPermissionAnywhere(profile, 'member:read');
  const team = useQuery({
    queryKey: ['restaurant', 'team', profile.activeTenant?.id],
    queryFn: () => client.request<TeamSummary>('/team'),
    enabled: canSeeTeam,
  });
  if (!canSeeTeam) return null;
  const active = team.data?.members.filter((m) => m.status === 'active').length;
  return (
    <Link href="/restaurant/team" className="block max-w-sm rounded-xl">
      <Kpi
        i={0}
        icon={UsersRound}
        tone="blue"
        label="Team members"
        value={active}
        loading={team.isPending}
      />
    </Link>
  );
}

function QuickActions() {
  const profile = useProfile();
  const actions: { label: string; icon: LucideIcon; href?: string }[] = [
    { label: 'New Order', icon: Plus, href: canAccessPath(profile, '/pos') ? '/pos' : undefined },
    {
      label: 'Orders',
      icon: ClipboardList,
      href: canAccessPath(profile, '/restaurant/orders') ? '/restaurant/orders' : undefined,
    },
    {
      label: 'Menu',
      icon: NotebookText,
      href: canAccessPath(profile, '/restaurant/menu') ? '/restaurant/menu' : undefined,
    },
    {
      label: 'Add Staff',
      icon: UserPlus,
      href: hasPermissionAnywhere(profile, 'member:invite') ? '/restaurant/team' : undefined,
    },
  ];
  return (
    <SpotlightCard {...rise(13)} className="h-full p-5">
      <CardHead icon={Zap} title="Quick actions" />
      <div className="mt-4 grid grid-cols-2 gap-3">
        {actions.map((a) => {
          const base =
            'group/qa relative flex min-h-24 flex-col items-center justify-center gap-2 rounded-lg p-3 text-center transition-all duration-200';
          const inner = (
            <>
              <a.icon
                className="size-6 transition-transform duration-300 group-hover/qa:-translate-y-0.5 group-hover/qa:scale-110"
                strokeWidth={1.75}
                aria-hidden
              />
              <span className="text-sm font-medium">{a.label}</span>
            </>
          );
          return a.href ? (
            <Link
              key={a.label}
              href={a.href}
              className={cn(
                base,
                'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100 ring-inset hover:bg-emerald-100 active:scale-[0.97] dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20 dark:hover:bg-emerald-500/15',
              )}
            >
              {inner}
            </Link>
          ) : (
            <span
              key={a.label}
              aria-disabled="true"
              className={cn(base, 'cursor-not-allowed bg-slate-50 text-slate-400 dark:bg-white/5')}
            >
              {inner}
            </span>
          );
        })}
      </div>
    </SpotlightCard>
  );
}

/** Remaining free-trial days, with the end date and a link to the plans. */
function TrialCard() {
  const ent = useEntitlement();
  const e = ent.data;
  if (!e?.isTrial || !e.trialEndsAt) return null;
  const total = e.trialStartedAt
    ? Math.max(
        1,
        Math.round(
          (new Date(e.trialEndsAt).getTime() - new Date(e.trialStartedAt).getTime()) / 86_400_000,
        ),
      )
    : 15;
  const used = Math.min(1, Math.max(0, 1 - e.remainingDays / total));
  const soon = e.remainingDays <= 3;
  return (
    <SpotlightCard {...rise(0)} className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            'text-3xl font-semibold tabular-nums',
            soon ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400',
          )}
        >
          <AnimatedNumber value={e.remainingDays} />
        </span>
        <span className="text-sm text-muted-foreground">
          day{e.remainingDays === 1 ? '' : 's'} left in your free trial
        </span>
      </div>
      <div className="flex-1 space-y-1.5">
        <div
          className="h-2 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label="Free trial used"
          aria-valuenow={Math.round(used * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <AnimatedBar
            value={Math.round(used * 100)}
            className={soon ? 'bg-red-500' : 'bg-emerald-500'}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Trial ends {pillDate.format(new Date(e.trialEndsAt))} · 1 branch included
        </p>
      </div>
      {e.canManage ? (
        <Link
          href="/restaurant/profile#subscription"
          className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
        >
          View plans <ArrowRight className="size-4" />
        </Link>
      ) : null}
    </SpotlightCard>
  );
}
