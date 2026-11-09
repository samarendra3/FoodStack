'use client';

import { Ban, CheckCircle2, ClipboardList, Clock, ShoppingBag, Store } from 'lucide-react';
import { useState } from 'react';
import {
  CHANNEL_LABEL,
  count,
  type Filters,
  inr,
  type Summary,
  type Trend,
  useAnalytics,
} from '@/lib/analytics';
import { downloadCsv } from '@/lib/csv';
import { LineChart, RankedBars } from '../dashboard/charts';
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
} from '../_kit/report-kit';

const STAGES = [
  ['pending', 'New (not started)'],
  ['preparing', 'Preparing'],
  ['ready', 'Ready'],
  ['served', 'Served'],
] as const;

export default function OrderReportsPage() {
  const [filters, setFilters] = useState<Filters>({ preset: 'last7' });
  const summary = useAnalytics<Summary>('summary', filters);
  const trend = useAnalytics<Trend>('trend', filters);
  const s = summary.data;
  const t = trend.data;
  const money = (v: number) => inr(v, s?.currencyCode ?? 'INR');
  const cancelRate =
    s && s.orders.total > 0 ? Math.round((s.orders.cancelled / s.orders.total) * 1000) / 10 : null;

  const exportCsv = () => {
    if (!t) return;
    downloadCsv(`orders-${t.range.from}-to-${t.range.to}.csv`, [
      ['Period', 'Orders placed', 'Completed', 'Cancelled'],
      ...t.points.map((p) => [p.bucket, p.ordersPlaced, p.completedOrders, p.cancelled]),
    ]);
  };

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Order Reports"
        description="Order volume, completion and cancellations across your restaurant."
        actions={<CsvButton onClick={exportCsv} disabled={!t} />}
      />
      <ReportFilters filters={filters} onChange={setFilters} meta={s} />
      {summary.isError ? <ErrorNote error={summary.error} /> : null}

      <StatGrid>
        <Stat
          icon={ClipboardList}
          label="Orders placed"
          value={s ? count(s.kpis.totalOrders.value) : undefined}
          cmp={s?.kpis.totalOrders}
          format={count}
          loading={summary.isPending}
        />
        <Stat
          icon={CheckCircle2}
          label="Completed"
          value={s ? count(s.kpis.completedOrders.value) : undefined}
          cmp={s?.kpis.completedOrders}
          format={count}
          loading={summary.isPending}
        />
        <Stat
          icon={Ban}
          label="Cancelled"
          value={s ? count(s.kpis.cancelledOrders.value) : undefined}
          cmp={s?.kpis.cancelledOrders}
          format={count}
          invert
          loading={summary.isPending}
        />
        <Stat
          icon={Clock}
          label="Open right now"
          value={s ? count(s.orders.open) : undefined}
          hint={cancelRate === null ? 'Not yet billed' : `Cancellation rate ${cancelRate}%`}
          loading={summary.isPending}
        />
      </StatGrid>

      <Card
        icon={ClipboardList}
        title="Order trend"
        subtitle="Placed, completed and cancelled, local time"
      >
        {trend.isPending ? (
          <Skeleton className="h-56" />
        ) : trend.isError ? (
          <ErrorNote error={trend.error} />
        ) : t && t.points.some((p) => p.ordersPlaced) ? (
          <LineChart
            ariaLabel="Order trend"
            series={[
              { key: 'placed', label: 'Placed' },
              { key: 'completed', label: 'Completed' },
              { key: 'cancelled', label: 'Cancelled' },
            ]}
            points={t.points.map((p) => ({
              key: p.bucket,
              label: bucketLabel(t, p.bucket, false),
              long: bucketLabel(t, p.bucket, true),
              values: {
                placed: p.ordersPlaced,
                completed: p.completedOrders,
                cancelled: p.cancelled,
              },
            }))}
            format={count}
            axisFormat={count}
          />
        ) : (
          <EmptyNote
            icon={ClipboardList}
            title="No orders in this period"
            text="Try a wider date range."
          />
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card icon={Store} title="By order type" subtitle="Orders and net sales per channel">
          {s && s.byChannel.some((c) => c.orders > 0) ? (
            <RankedBars
              ariaLabel="Orders by order type"
              format={count}
              rows={s.byChannel.map((c) => ({
                key: c.channel,
                label: CHANNEL_LABEL[c.channel] ?? c.channel,
                value: c.orders,
                note: `${count(c.completedOrders)} completed · ${money(c.netSalesMinor)}`,
              }))}
            />
          ) : summary.isPending ? (
            <Skeleton className="h-40" />
          ) : (
            <EmptyNote icon={Store} title="No orders yet" text="Nothing ordered in this period." />
          )}
        </Card>

        <Card
          icon={ShoppingBag}
          title="Kitchen pipeline"
          subtitle="Where this period's orders are now"
        >
          {s ? (
            <RankedBars
              ariaLabel="Orders by kitchen stage"
              format={count}
              colorIndex={1}
              rows={STAGES.map(([k, label]) => ({ key: k, label, value: s.orders[k] }))}
            />
          ) : (
            <Skeleton className="h-40" />
          )}
        </Card>
      </div>
    </div>
  );
}
