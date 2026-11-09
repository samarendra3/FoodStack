'use client';

import { BarChart3, Trophy } from 'lucide-react';
import { useState } from 'react';
import { downloadCsv } from '@/lib/csv';
import { RankedBars } from '../dashboard/charts';
import { BranchPicker, daysAgo, money, Table, today, Toolbar, useOps } from '../_kit/ops-kit';
import {
  Card,
  control,
  CsvButton,
  EmptyNote,
  ErrorNote,
  PageHeader,
  Skeleton,
  Stat,
  StatGrid,
} from '../_kit/report-kit';

interface Perf {
  branches: { id: string; name: string }[];
  from: string;
  to: string;
  currencyCode: string;
  rows: {
    userId: string;
    name: string;
    orders: number;
    completed: number;
    cancelled: number;
    salesMinor: number;
    averageOrderMinor: number | null;
    averageMinutesToClose: number | null;
    hours: number | null;
    salesPerHourMinor: number | null;
  }[];
}

export default function StaffPerformancePage() {
  const [branchId, setBranchId] = useState('');
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(today());
  const q = useOps<Perf>(
    `/staff-performance?${new URLSearchParams({ from, to, ...(branchId ? { branchId } : {}) })}`,
  );
  const d = q.data;
  const m = (v: number) => money(v, d?.currencyCode);
  const top = d?.rows[0];
  const cancelRate = (r: Perf['rows'][number]) =>
    r.orders ? Math.round((r.cancelled / r.orders) * 1000) / 10 : 0;

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Staff Performance"
        description="Orders each person took on the POS or waiter app, what they sold and, with attendance, sales per hour."
        actions={
          <CsvButton
            disabled={!d?.rows.length}
            onClick={() =>
              downloadCsv(`staff-performance-${from}-to-${to}.csv`, [
                [
                  'Name',
                  'Orders',
                  'Completed',
                  'Cancelled',
                  'Sales',
                  'Avg order',
                  'Hours',
                  'Sales per hour',
                ],
                ...d!.rows.map((r) => [
                  r.name,
                  r.orders,
                  r.completed,
                  r.cancelled,
                  (r.salesMinor / 100).toFixed(2),
                  r.averageOrderMinor === null ? '' : (r.averageOrderMinor / 100).toFixed(2),
                  r.hours ?? '',
                  r.salesPerHourMinor === null ? '' : (r.salesPerHourMinor / 100).toFixed(2),
                ]),
              ])
            }
          />
        }
      />
      <Toolbar>
        <BranchPicker
          branches={d?.branches ?? []}
          value={branchId}
          onChange={setBranchId}
          allLabel="All branches"
        />
        <input
          type="date"
          aria-label="From"
          className={control}
          value={from}
          max={to}
          onChange={(e) => setFrom(e.target.value)}
        />
        <input
          type="date"
          aria-label="To"
          className={control}
          value={to}
          min={from}
          onChange={(e) => setTo(e.target.value)}
        />
      </Toolbar>
      {q.isError ? <ErrorNote error={q.error} /> : null}
      <StatGrid>
        <Stat
          icon={Trophy}
          label="Top seller"
          value={top?.name ?? (d ? '—' : undefined)}
          hint={top ? m(top.salesMinor) : undefined}
          loading={q.isPending}
        />
        <Stat label="Staff taking orders" value={d?.rows.length} loading={q.isPending} />
        <Stat
          label="Orders"
          value={d?.rows.reduce((t, r) => t + r.orders, 0)}
          loading={q.isPending}
        />
        <Stat
          label="Sales"
          value={d ? m(d.rows.reduce((t, r) => t + r.salesMinor, 0)) : undefined}
          loading={q.isPending}
        />
      </StatGrid>
      {q.isPending ? (
        <Skeleton className="h-56" />
      ) : !d?.rows.length ? (
        <Card>
          <EmptyNote
            icon={BarChart3}
            title="No orders by staff in this period"
            text="Orders placed from the POS or waiter app are credited to the person signed in."
          />
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card title="Sales by person">
            <RankedBars
              ariaLabel="Sales by person"
              format={m}
              rows={d.rows.slice(0, 10).map((r) => ({
                key: r.userId,
                label: r.name,
                value: r.salesMinor,
                note: `${r.completed} bills`,
              }))}
            />
          </Card>
          <Card className="lg:col-span-2">
            <Table
              rows={d.rows}
              rowKey={(r) => r.userId}
              cols={[
                {
                  key: 'n',
                  header: 'Name',
                  cell: (r) => <span className="font-medium">{r.name}</span>,
                },
                { key: 'o', header: 'Orders', align: 'right', cell: (r) => r.orders },
                {
                  key: 'c',
                  header: 'Cancelled',
                  align: 'right',
                  hideOnMobile: true,
                  cell: (r) => `${r.cancelled} (${cancelRate(r)}%)`,
                },
                { key: 's', header: 'Sales', align: 'right', cell: (r) => m(r.salesMinor) },
                {
                  key: 'a',
                  header: 'Avg bill',
                  align: 'right',
                  hideOnMobile: true,
                  cell: (r) => (r.averageOrderMinor === null ? '—' : m(r.averageOrderMinor)),
                },
                {
                  key: 't',
                  header: 'Order → paid',
                  align: 'right',
                  hideOnMobile: true,
                  cell: (r) =>
                    r.averageMinutesToClose === null ? '—' : `${r.averageMinutesToClose} min`,
                },
                {
                  key: 'h',
                  header: 'Hours',
                  align: 'right',
                  hideOnMobile: true,
                  cell: (r) => r.hours ?? '—',
                },
                {
                  key: 'p',
                  header: 'Sales / hour',
                  align: 'right',
                  cell: (r) => (r.salesPerHourMinor === null ? '—' : m(r.salesPerHourMinor)),
                },
              ]}
            />
          </Card>
        </div>
      )}
    </div>
  );
}
