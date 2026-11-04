'use client';

import { type Column, DataTable } from '@/components/data-table/data-table';
import { usePagedList } from '@/lib/paged';

interface CustomerRow {
  id: string;
  name: string | null;
  phone: string;
  createdAt: string;
  orderCount: number;
  totalSpentMinor: number;
  lastOrderAt: string | null;
}

const money = (minor: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(minor / 100);
const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export default function CustomersPage() {
  const list = usePagedList<CustomerRow>('customers-list', '/customers', {
    sortBy: 'lastOrderAt',
    filters: { from: '', to: '' },
  });

  const columns: Column<CustomerRow>[] = [
    {
      key: 'name',
      header: 'Name',
      sortKey: 'name',
      cell: (c) => c.name ?? <span className="text-muted-foreground">No name</span>,
    },
    { key: 'phone', header: 'Phone', cell: (c) => <span className="tabular-nums">{c.phone}</span> },
    {
      key: 'orders',
      header: 'Completed orders',
      sortKey: 'orderCount',
      align: 'right',
      cell: (c) => c.orderCount,
    },
    {
      key: 'spent',
      header: 'Total spent',
      sortKey: 'totalSpentMinor',
      align: 'right',
      cell: (c) => money(c.totalSpentMinor),
    },
    {
      key: 'last',
      header: 'Last order',
      sortKey: 'lastOrderAt',
      hideOnMobile: true,
      cell: (c) =>
        c.lastOrderAt ? (
          day.format(new Date(c.lastOrderAt))
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'since',
      header: 'Customer since',
      sortKey: 'createdAt',
      hideOnMobile: true,
      cell: (c) => day.format(new Date(c.createdAt)),
    },
  ];

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
        <p className="text-sm text-muted-foreground">
          Guests captured by phone at the POS. Totals count completed orders, net of refunds.
        </p>
      </div>
      <DataTable
        list={list}
        columns={columns}
        getRowId={(c) => c.id}
        searchPlaceholder="Phone or name"
        dateRange
        exportCsv={{
          filename: `customers-${new Date().toISOString().slice(0, 10)}.csv`,
          columns: [
            { header: 'Name', value: (c) => c.name ?? '' },
            { header: 'Phone', value: (c) => c.phone },
            { header: 'Completed orders', value: (c) => c.orderCount },
            { header: 'Total spent', value: (c) => (c.totalSpentMinor / 100).toFixed(2) },
            { header: 'Last order', value: (c) => c.lastOrderAt ?? '' },
            { header: 'Customer since', value: (c) => c.createdAt },
          ],
        }}
        empty={{
          title: 'No customers yet',
          description: 'Customers appear when a phone number is added to an order.',
        }}
      />
    </div>
  );
}
