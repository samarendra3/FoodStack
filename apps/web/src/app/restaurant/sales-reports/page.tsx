'use client';

import {
  BarChart3,
  Building2,
  CreditCard,
  IndianRupee,
  Receipt,
  ShoppingBag,
  Store,
} from 'lucide-react';
import { useState } from 'react';
import {
  type BranchStats,
  CHANNEL_LABEL,
  type Filters,
  inr,
  METHOD_LABEL,
  type Summary,
  type Trend,
  useAnalytics,
  count,
} from '@/lib/analytics';
import { downloadCsv } from '@/lib/csv';
import { Donut, LineChart, RankedBars } from '../dashboard/charts';
import {
  Card,
  CsvButton,
  EmptyNote,
  ErrorNote,
  PageHeader,
  ReportFilters,
  Skeleton,
  Stat,
  StatGrid,
  bucketLabel,
  compact,
} from '../_kit/report-kit';

export default function SalesReportsPage() {
  const [filters, setFilters] = useState<Filters>({ preset: 'last7' });
  const summary = useAnalytics<Summary>('summary', filters);
  const trend = useAnalytics<Trend>('trend', filters);
  const branches = useAnalytics<BranchStats>('branches', filters);
  const s = summary.data;
  const t = trend.data;
  const cur = s?.currencyCode ?? 'INR';
  const money = (v: number) => inr(v, cur);

  const exportCsv = () => {
    if (!t || !s) return;
    downloadCsv(`sales-${t.range.from}-to-${t.range.to}.csv`, [
      ['Period', 'Net sales', 'Orders placed', 'Completed', 'Cancelled', 'Collected', 'Refunds'],
      ...t.points.map((p) => [
        p.bucket,
        (p.netSales / 100).toFixed(2),
        p.ordersPlaced,
        p.completedOrders,
        p.cancelled,
        (p.collected / 100).toFixed(2),
        (p.refunds / 100).toFixed(2),
      ]),
    ]);
  };

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Sales Reports"
        description="Revenue over time, by order type, payment method and branch."
        actions={<CsvButton onClick={exportCsv} disabled={!t} />}
      />
      <ReportFilters filters={filters} onChange={setFilters} meta={s} />
      {summary.isError ? <ErrorNote error={summary.error} /> : null}

      <StatGrid>
        <Stat
          icon={IndianRupee}
          label="Net sales"
          value={s ? money(s.revenue.netSales.value) : undefined}
          cmp={s?.revenue.netSales}
          format={money}
          loading={summary.isPending}
        />
        <Stat
          icon={ShoppingBag}
          label="Completed orders"
          value={s ? count(s.kpis.completedOrders.value) : undefined}
          cmp={s?.kpis.completedOrders}
          format={count}
          loading={summary.isPending}
        />
        <Stat
          icon={Receipt}
          label="Average order value"
          value={
            s && s.kpis.averageOrderValue.value !== null
              ? money(s.kpis.averageOrderValue.value)
              : s
                ? '—'
                : undefined
          }
          hint={
            s?.kpis.averageOrderValue.changePct !== null &&
            s?.kpis.averageOrderValue.changePct !== undefined
              ? `${s.kpis.averageOrderValue.changePct > 0 ? '+' : ''}${s.kpis.averageOrderValue.changePct}% vs previous`
              : 'Net sales ÷ completed orders'
          }
          loading={summary.isPending}
        />
        <Stat
          icon={CreditCard}
          label="Collected"
          value={s ? money(s.revenue.netCollected.value) : undefined}
          cmp={s?.revenue.netCollected}
          format={money}
          loading={summary.isPending}
        />
      </StatGrid>

      <Card
        icon={BarChart3}
        title="Sales trend"
        subtitle="Net sales and money collected, local time"
      >
        {trend.isPending ? (
          <Skeleton className="h-56" />
        ) : trend.isError ? (
          <ErrorNote error={trend.error} />
        ) : t && t.points.some((p) => p.netSales || p.collected) ? (
          <LineChart
            ariaLabel="Sales trend"
            series={[
              { key: 'netSales', label: 'Net sales' },
              { key: 'collected', label: 'Collected' },
            ]}
            points={t.points.map((p) => ({
              key: p.bucket,
              label: bucketLabel(t, p.bucket, false),
              long: bucketLabel(t, p.bucket, true),
              values: { netSales: p.netSales, collected: p.collected },
            }))}
            format={money}
            axisFormat={compact}
          />
        ) : (
          <EmptyNote
            icon={BarChart3}
            title="No sales in this period"
            text="Completed orders from the POS, waiter app and QR menu show up here."
          />
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card icon={Store} title="By order type" subtitle="Net sales per channel">
          {s && s.byChannel.some((c) => c.netSalesMinor > 0) ? (
            <Donut
              ariaLabel="Net sales by order type"
              center={compact(s.byChannel.reduce((a, c) => a + c.netSalesMinor, 0))}
              caption="net sales"
              parts={s.byChannel.map((c) => ({
                label: `${CHANNEL_LABEL[c.channel] ?? c.channel} · ${money(c.netSalesMinor)} · ${count(c.completedOrders)} orders`,
                value: c.netSalesMinor,
              }))}
            />
          ) : summary.isPending ? (
            <Skeleton className="h-40" />
          ) : (
            <EmptyNote icon={Store} title="No sales yet" text="Nothing sold in this period." />
          )}
        </Card>

        <Card icon={CreditCard} title="By payment method" subtitle="Collected, less refunds">
          {s && s.byMethod.some((m) => m.collectedMinor > 0) ? (
            <RankedBars
              ariaLabel="Net collected by payment method"
              format={money}
              rows={s.byMethod.map((m) => ({
                key: m.method,
                label: METHOD_LABEL[m.method] ?? m.method,
                value: m.netMinor,
                note: m.refundsMinor ? `${money(m.refundsMinor)} refunded` : undefined,
              }))}
            />
          ) : summary.isPending ? (
            <Skeleton className="h-40" />
          ) : (
            <EmptyNote
              icon={CreditCard}
              title="No payments yet"
              text="Nothing collected in this period."
            />
          )}
        </Card>
      </div>

      <Card icon={Building2} title="By branch" subtitle="Ranked by net sales">
        {branches.isPending ? (
          <Skeleton className="h-32" />
        ) : branches.isError ? (
          <ErrorNote error={branches.error} />
        ) : branches.data && branches.data.rows.length > 0 ? (
          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-muted-foreground uppercase dark:border-white/10">
                  <th className="px-4 py-2 font-medium sm:px-2">Branch</th>
                  <th className="px-2 py-2 text-right font-medium">Net sales</th>
                  <th className="px-2 py-2 text-right font-medium">Change</th>
                  <th className="px-2 py-2 text-right font-medium">Orders</th>
                  <th className="px-2 py-2 text-right font-medium">Avg. order</th>
                  <th className="px-4 py-2 text-right font-medium sm:px-2">Share</th>
                </tr>
              </thead>
              <tbody>
                {branches.data.rows.map((b) => (
                  <tr
                    key={b.id}
                    className="border-b border-slate-100 last:border-0 dark:border-white/5"
                  >
                    <td className="px-4 py-2.5 font-medium sm:px-2">{b.name}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums">
                      {money(b.netSales.value)}
                    </td>
                    <td className="px-2 py-2.5 text-right tabular-nums">
                      {b.netSales.changePct === null
                        ? '—'
                        : `${b.netSales.changePct > 0 ? '+' : ''}${b.netSales.changePct}%`}
                    </td>
                    <td className="px-2 py-2.5 text-right tabular-nums">
                      {count(b.completedOrders)}
                    </td>
                    <td className="px-2 py-2.5 text-right tabular-nums">
                      {b.averageOrderValueMinor === null ? '—' : money(b.averageOrderValueMinor)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums sm:px-2">
                      {b.sharePct === null ? '—' : `${b.sharePct}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyNote icon={Building2} title="No branches" text="Add a branch to compare sales." />
        )}
      </Card>
    </div>
  );
}
