'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { Ban, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { type Column, DataTable } from '@/components/data-table/data-table';
import { type Filters, inr, type Summary, useAnalytics, count } from '@/lib/analytics';
import type { Order } from '@/lib/orders';
import { usePagedList } from '@/lib/paged';
import { OrderDetail } from '../orders/order-detail';
import { CHANNEL_LABEL } from '../orders/order-labels';
import { useRestaurantOverview } from '../overview';
import { PageHeader, Stat, StatGrid } from '../_kit/report-kit';

/*
 * Refunds & Voids: refunded payments and cancelled orders in one place. Opening a row shows the
 * bill, where managers with order:refund / order:void can refund or cancel; the API re-checks.
 */

interface PaymentRow {
  id: string;
  orderId: string;
  orderNumber: number;
  branchName: string;
  method: 'cash' | 'card' | 'upi';
  amountMinor: number;
  refundedMinor: number;
  reference: string | null;
  currencyCode: string;
  createdAt: string;
}

type OrderRow = Omit<Order, 'items' | 'discounts' | 'payments'> & {
  branchName: string;
  itemCount: number;
  cancelReason?: string | null;
};

const money = (minor: number, currency: string) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(minor / 100);
const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const METHOD = { cash: 'Cash', card: 'Card', upi: 'UPI' } as const;

type Tab = 'refunds' | 'cancelled';

export default function RefundsPage() {
  const [tab, setTab] = useState<Tab>('refunds');
  const [openId, setOpenId] = useState<string | null>(null);
  const [filters] = useState<Filters>({ preset: 'last30' });
  const summary = useAnalytics<Summary>('summary', filters);
  const s = summary.data;
  const cur = s?.currencyCode ?? 'INR';

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Refunds & Voids"
        description="Refunded payments and cancelled orders. Open one to see the bill and its history."
      />

      <StatGrid>
        <Stat
          icon={Undo2}
          label="Refunded (30 days)"
          value={s ? inr(s.revenue.refunds.value, cur) : undefined}
          cmp={s?.revenue.refunds}
          format={(v) => inr(v, cur)}
          invert
          loading={summary.isPending}
        />
        <Stat
          icon={Ban}
          label="Cancelled orders (30 days)"
          value={s ? count(s.kpis.cancelledOrders.value) : undefined}
          cmp={s?.kpis.cancelledOrders}
          format={count}
          invert
          loading={summary.isPending}
        />
        <Stat
          label="Cancellation rate"
          value={
            s
              ? s.orders.total
                ? `${Math.round((s.orders.cancelled / s.orders.total) * 1000) / 10}%`
                : '0%'
              : undefined
          }
          hint="Cancelled ÷ orders placed"
          loading={summary.isPending}
        />
        <Stat
          label="Refund rate"
          value={
            s
              ? s.revenue.collected.value
                ? `${Math.round((s.revenue.refunds.value / s.revenue.collected.value) * 1000) / 10}%`
                : '0%'
              : undefined
          }
          hint="Refunds ÷ collected"
          loading={summary.isPending}
        />
      </StatGrid>

      <div
        role="tablist"
        aria-label="View"
        className="inline-flex rounded-lg border border-slate-200 p-1 text-sm dark:border-white/10"
      >
        {(
          [
            ['refunds', 'Refunded payments'],
            ['cancelled', 'Cancelled orders'],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cn(
              'rounded-md px-3 py-1.5 font-medium',
              tab === k
                ? 'bg-emerald-600 text-white'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-300',
            )}
          >
            {l}
          </button>
        ))}
      </div>

      {tab === 'refunds' ? <Refunds onOpen={setOpenId} /> : <Cancelled onOpen={setOpenId} />}

      {openId ? (
        <OrderDetail id={openId} onClose={() => setOpenId(null)} onChanged={() => undefined} />
      ) : null}
    </div>
  );
}

function useBranchFilter() {
  const overview = useRestaurantOverview();
  const branches = overview.data?.branches ?? [];
  return branches.length > 1
    ? [
        {
          key: 'branchId',
          label: 'Branch',
          options: branches.map((b) => ({ value: b.id, label: b.name })),
        },
      ]
    : [];
}

function Refunds({ onOpen }: { onOpen: (id: string) => void }) {
  const branchFilter = useBranchFilter();
  const list = usePagedList<PaymentRow>(
    'refunds-list',
    '/payments',
    {
      sortBy: 'createdAt',
      filters: { refunded: 'yes', method: '', branchId: '', from: '', to: '' },
    },
    { cursor: true },
  );
  const columns: Column<PaymentRow>[] = [
    {
      key: 'when',
      header: 'Paid',
      sortKey: 'createdAt',
      cell: (p) => when.format(new Date(p.createdAt)),
    },
    {
      key: 'order',
      header: 'Order',
      cell: (p) => (
        <button
          type="button"
          onClick={() => onOpen(p.orderId)}
          className="font-medium text-emerald-700 hover:underline dark:text-emerald-400"
        >
          #{p.orderNumber}
        </button>
      ),
    },
    { key: 'method', header: 'Method', cell: (p) => METHOD[p.method] },
    { key: 'branch', header: 'Branch', hideOnMobile: true, cell: (p) => p.branchName },
    {
      key: 'paid',
      header: 'Paid',
      align: 'right',
      hideOnMobile: true,
      cell: (p) => money(p.amountMinor, p.currencyCode),
    },
    {
      key: 'refunded',
      header: 'Refunded',
      align: 'right',
      cell: (p) => (
        <span className="font-medium text-red-600">−{money(p.refundedMinor, p.currencyCode)}</span>
      ),
    },
  ];
  return (
    <DataTable
      list={list}
      columns={columns}
      getRowId={(p) => p.id}
      searchPlaceholder="Order # or reference"
      dateRange
      filters={[
        {
          key: 'method',
          label: 'Method',
          options: Object.entries(METHOD).map(([value, label]) => ({ value, label })),
        },
        ...branchFilter,
      ]}
      exportCsv={{
        filename: `refunds-${new Date().toISOString().slice(0, 10)}.csv`,
        columns: [
          { header: 'Paid at', value: (p) => p.createdAt },
          { header: 'Order', value: (p) => p.orderNumber },
          { header: 'Branch', value: (p) => p.branchName },
          { header: 'Method', value: (p) => METHOD[p.method] },
          { header: 'Paid', value: (p) => (p.amountMinor / 100).toFixed(2) },
          { header: 'Refunded', value: (p) => (p.refundedMinor / 100).toFixed(2) },
        ],
      }}
      empty={{ title: 'No refunds', description: 'Refunds made from an order’s bill appear here.' }}
    />
  );
}

function Cancelled({ onOpen }: { onOpen: (id: string) => void }) {
  const branchFilter = useBranchFilter();
  const list = usePagedList<OrderRow>(
    'cancelled-orders',
    '/orders',
    {
      sortBy: 'createdAt',
      filters: { status: 'cancelled', channel: '', branchId: '', from: '', to: '' },
    },
    { cursor: true },
  );
  const columns: Column<OrderRow>[] = [
    {
      key: 'number',
      header: 'Order',
      sortKey: 'orderNumber',
      cell: (o) => (
        <button
          type="button"
          onClick={() => onOpen(o.id)}
          className="font-medium text-emerald-700 hover:underline dark:text-emerald-400"
        >
          #{o.orderNumber}
        </button>
      ),
    },
    {
      key: 'created',
      header: 'Placed',
      sortKey: 'createdAt',
      cell: (o) => when.format(new Date(o.createdAt)),
    },
    {
      key: 'channel',
      header: 'Type',
      hideOnMobile: true,
      cell: (o) => CHANNEL_LABEL[o.channel] ?? o.channel,
    },
    { key: 'branch', header: 'Branch', hideOnMobile: true, cell: (o) => o.branchName },
    {
      key: 'reason',
      header: 'Reason',
      cell: (o) => o.cancelReason ?? <span className="text-muted-foreground">—</span>,
    },
    {
      key: 'total',
      header: 'Value',
      align: 'right',
      cell: (o) => money(o.totalMinor, o.currencyCode),
    },
  ];
  return (
    <DataTable
      list={list}
      columns={columns}
      getRowId={(o) => o.id}
      searchPlaceholder="Order # or table"
      dateRange
      filters={[
        {
          key: 'channel',
          label: 'Type',
          options: Object.entries(CHANNEL_LABEL).map(([value, label]) => ({ value, label })),
        },
        ...branchFilter,
      ]}
      exportCsv={{
        filename: `cancelled-orders-${new Date().toISOString().slice(0, 10)}.csv`,
        columns: [
          { header: 'Placed', value: (o) => o.createdAt },
          { header: 'Order', value: (o) => o.orderNumber },
          { header: 'Branch', value: (o) => o.branchName },
          { header: 'Reason', value: (o) => o.cancelReason ?? '' },
          { header: 'Value', value: (o) => (o.totalMinor / 100).toFixed(2) },
        ],
      }}
      empty={{
        title: 'No cancelled orders',
        description: 'Orders cancelled from the bill appear here with their reason.',
      }}
    />
  );
}
