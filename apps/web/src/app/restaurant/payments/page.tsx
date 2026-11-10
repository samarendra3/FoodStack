'use client';

import { type Column, DataTable } from '@/components/data-table/data-table';
import { usePagedList } from '@/lib/paged';
import { useRestaurantOverview } from '../overview';

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

const money = (minor: number, currency: string) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(minor / 100);
const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const METHOD: Record<PaymentRow['method'], string> = { cash: 'Cash', card: 'Card', upi: 'UPI' };

export default function PaymentsPage() {
  const overview = useRestaurantOverview();
  const branches = overview.data?.branches ?? [];
  const list = usePagedList<PaymentRow>(
    'payments-list',
    '/payments',
    {
      sortBy: 'createdAt',
      filters: { method: '', refunded: '', branchId: '', from: '', to: '' },
    },
    { cursor: true },
  );

  const columns: Column<PaymentRow>[] = [
    {
      key: 'when',
      header: 'Received',
      sortKey: 'createdAt',
      cell: (p) => when.format(new Date(p.createdAt)),
    },
    {
      key: 'order',
      header: 'Order',
      cell: (p) => <span className="font-medium">#{p.orderNumber}</span>,
    },
    { key: 'method', header: 'Method', cell: (p) => METHOD[p.method] },
    {
      key: 'reference',
      header: 'Reference',
      hideOnMobile: true,
      cell: (p) => p.reference ?? <span className="text-muted-foreground">—</span>,
    },
    { key: 'branch', header: 'Branch', hideOnMobile: true, cell: (p) => p.branchName },
    {
      key: 'amount',
      header: 'Amount',
      sortKey: 'amountMinor',
      align: 'right',
      cell: (p) => (
        <span>
          {money(p.amountMinor, p.currencyCode)}
          {p.refundedMinor ? (
            <span className="block text-xs text-red-600">
              −{money(p.refundedMinor, p.currencyCode)} refunded
            </span>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Payments</h1>
        <p className="text-sm text-muted-foreground">
          Money received at the POS, including split and partial payments.
        </p>
      </div>
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
          {
            key: 'refunded',
            label: 'Refunded',
            options: [
              { value: 'yes', label: 'Refunded' },
              { value: 'no', label: 'Not refunded' },
            ],
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
          filename: `payments-${new Date().toISOString().slice(0, 10)}.csv`,
          columns: [
            { header: 'Received', value: (p) => p.createdAt },
            { header: 'Order', value: (p) => p.orderNumber },
            { header: 'Branch', value: (p) => p.branchName },
            { header: 'Method', value: (p) => METHOD[p.method] },
            { header: 'Reference', value: (p) => p.reference ?? '' },
            { header: 'Amount', value: (p) => (p.amountMinor / 100).toFixed(2) },
            { header: 'Refunded', value: (p) => (p.refundedMinor / 100).toFixed(2) },
          ],
        }}
        empty={{ title: 'No payments yet', description: 'Payments taken on the POS appear here.' }}
      />
    </div>
  );
}
