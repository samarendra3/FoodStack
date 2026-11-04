'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { type Column, DataTable } from '@/components/data-table/data-table';
import { useState } from 'react';
import type { Order } from '@/lib/orders';
import { usePagedList } from '@/lib/paged';
import { useRestaurantOverview } from '../overview';
import { OrderDetail } from './order-detail';
import { CHANNEL_LABEL, STATUS_STYLE } from './order-labels';

type OrderRow = Omit<Order, 'items' | 'discounts' | 'payments'> & {
  branchName: string;
  itemCount: number;
};

const money = (minor: number, currency: string) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(minor / 100);
const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export default function OrdersPage() {
  const overview = useRestaurantOverview();
  const [openId, setOpenId] = useState<string | null>(null);
  const list = usePagedList<OrderRow>('orders-list', '/orders', {
    sortBy: 'createdAt',
    filters: { status: '', channel: '', branchId: '', from: '', to: '' },
  });
  const branches = overview.data?.branches ?? [];

  const columns: Column<OrderRow>[] = [
    {
      key: 'number',
      header: 'Order',
      sortKey: 'orderNumber',
      cell: (o) => (
        <span className="font-semibold">
          #{o.orderNumber}
          {o.tableLabel ? (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              Table {o.tableLabel}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Placed',
      sortKey: 'createdAt',
      cell: (o) => when.format(new Date(o.createdAt)),
    },
    { key: 'branch', header: 'Branch', cell: (o) => o.branchName, hideOnMobile: true },
    {
      key: 'channel',
      header: 'Type',
      cell: (o) => CHANNEL_LABEL[o.channel] ?? o.channel,
      hideOnMobile: true,
    },
    {
      key: 'customer',
      header: 'Customer',
      hideOnMobile: true,
      cell: (o) =>
        o.customer ? (
          (o.customer.name ?? o.customer.phone)
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    { key: 'items', header: 'Items', align: 'right', cell: (o) => o.itemCount, hideOnMobile: true },
    {
      key: 'total',
      header: 'Total',
      sortKey: 'totalMinor',
      align: 'right',
      cell: (o) => (
        <span>
          {money(o.totalMinor, o.currencyCode)}
          {o.refundedMinor > 0 ? (
            <span className="block text-xs text-red-600">
              −{money(o.refundedMinor, o.currencyCode)} refunded
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortKey: 'status',
      cell: (o) => (
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-semibold capitalize',
            STATUS_STYLE[o.status],
          )}
        >
          {o.status === 'open' && o.dueMinor > 0 && o.paidMinor > 0 ? 'Part paid' : o.status}
        </span>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
        <p className="text-sm text-muted-foreground">
          Every order and bill across your branches. Click an order to see the bill.
        </p>
      </div>
      <DataTable
        list={list}
        columns={columns}
        getRowId={(o) => o.id}
        onRowClick={(o) => setOpenId(o.id)}
        searchPlaceholder="Order #, phone, name or table"
        dateRange
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'open', label: 'Open' },
              { value: 'completed', label: 'Completed' },
              { value: 'cancelled', label: 'Cancelled' },
            ],
          },
          {
            key: 'channel',
            label: 'Type',
            options: Object.entries(CHANNEL_LABEL).map(([value, label]) => ({ value, label })),
          },
          ...(branches.length > 1
            ? [
                {
                  key: 'branchId',
                  label: 'Branch',
                  options: branches.map((b) => ({ value: b.id, label: b.name })),
                },
              ]
            : []),
        ]}
        exportCsv={{
          filename: `orders-${new Date().toISOString().slice(0, 10)}.csv`,
          columns: [
            { header: 'Order', value: (o) => o.orderNumber },
            { header: 'Placed', value: (o) => o.createdAt },
            { header: 'Branch', value: (o) => o.branchName },
            { header: 'Type', value: (o) => CHANNEL_LABEL[o.channel] ?? o.channel },
            { header: 'Table', value: (o) => o.tableLabel ?? '' },
            { header: 'Customer phone', value: (o) => o.customer?.phone ?? '' },
            { header: 'Items', value: (o) => o.itemCount },
            { header: 'Subtotal', value: (o) => (o.subtotalMinor / 100).toFixed(2) },
            { header: 'Discount', value: (o) => (o.discountMinor / 100).toFixed(2) },
            { header: 'Tax', value: (o) => (o.taxMinor / 100).toFixed(2) },
            { header: 'Total', value: (o) => (o.totalMinor / 100).toFixed(2) },
            { header: 'Paid', value: (o) => (o.paidMinor / 100).toFixed(2) },
            { header: 'Refunded', value: (o) => (o.refundedMinor / 100).toFixed(2) },
            { header: 'Status', value: (o) => o.status },
          ],
        }}
        empty={{ title: 'No orders yet', description: 'Orders placed on the POS appear here.' }}
      />
      {openId ? (
        <OrderDetail id={openId} onClose={() => setOpenId(null)} onChanged={() => list.refetch()} />
      ) : null}
    </div>
  );
}
