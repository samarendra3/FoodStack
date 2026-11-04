'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { type Column, DataTable } from '@/components/data-table/data-table';
import { type Invoice, KIND_LABEL, METHOD_LABEL, money } from '@/lib/billing';
import { Button } from '@foodstack/ui/components/button';
import { Download } from 'lucide-react';
import { useProfile } from '@/components/auth/auth-provider';
import { printInvoice } from '@/lib/invoice-print';
import { usePagedList } from '@/lib/paged';

const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const STATUS: Record<Invoice['status'], { label: string; cls: string }> = {
  pending: {
    label: 'Pending payment',
    cls: 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  },
  paid: {
    label: 'Paid',
    cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  },
  cancelled: {
    label: 'Cancelled',
    cls: 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300',
  },
};

export function BillingTab() {
  const list = usePagedList<Invoice>('billing', '/billing/invoices', {
    sortBy: 'createdAt',
    filters: { status: '', from: '', to: '' },
  });

  const profile = useProfile();
  const columns: Column<Invoice>[] = [
    {
      key: 'number',
      header: 'Invoice',
      cell: (i) => <span className="font-mono text-xs font-semibold">{i.invoiceNumber}</span>,
    },
    {
      key: 'plan',
      header: 'Plan',
      cell: (i) => (
        <span>
          {i.planName} <span className="text-xs text-muted-foreground">· {i.billingCycle}</span>
          <span className="block text-xs text-muted-foreground">{KIND_LABEL[i.kind]}</span>
        </span>
      ),
    },
    {
      key: 'date',
      header: 'Billing date',
      sortKey: 'createdAt',
      cell: (i) => day.format(new Date(i.createdAt)),
    },
    {
      key: 'period',
      header: 'Period',
      hideOnMobile: true,
      cell: (i) =>
        i.periodStart && i.periodEnd ? (
          <span className="text-xs">
            {day.format(new Date(i.periodStart))} – {day.format(new Date(i.periodEnd))}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'amount',
      header: 'Amount',
      sortKey: 'amountMinor',
      align: 'right',
      cell: (i) => money(i.amountMinor, i.currencyCode),
    },
    {
      key: 'method',
      header: 'Payment method',
      hideOnMobile: true,
      cell: (i) =>
        i.paymentMethod ? (
          (METHOD_LABEL[i.paymentMethod] ?? i.paymentMethod)
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (i) => (
        <span
          className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', STATUS[i.status].cls)}
        >
          {STATUS[i.status].label}
        </span>
      ),
    },
  ];

  return (
    <DataTable
      list={list}
      columns={columns}
      getRowId={(i) => i.id}
      searchPlaceholder="Invoice number or plan"
      dateRange
      rowActions={(i) => (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => printInvoice(i, profile.activeTenant?.name ?? '')}
          aria-label={'Download invoice ' + i.invoiceNumber}
        >
          <Download /> Invoice
        </Button>
      )}
      filters={[
        {
          key: 'status',
          label: 'Status',
          options: Object.entries(STATUS).map(([value, s]) => ({ value, label: s.label })),
        },
      ]}
      exportCsv={{
        filename: `foodstack-invoices-${new Date().toISOString().slice(0, 10)}.csv`,
        columns: [
          { header: 'Invoice', value: (i) => i.invoiceNumber },
          { header: 'Plan', value: (i) => i.planName },
          { header: 'Cycle', value: (i) => i.billingCycle },
          { header: 'Type', value: (i) => KIND_LABEL[i.kind] },
          { header: 'Billing date', value: (i) => i.createdAt },
          { header: 'Period start', value: (i) => i.periodStart ?? '' },
          { header: 'Period end', value: (i) => i.periodEnd ?? '' },
          { header: 'Amount', value: (i) => (i.amountMinor / 100).toFixed(2) },
          { header: 'Currency', value: (i) => i.currencyCode },
          {
            header: 'Payment method',
            value: (i) =>
              i.paymentMethod ? (METHOD_LABEL[i.paymentMethod] ?? i.paymentMethod) : '',
          },
          { header: 'Reference', value: (i) => i.paymentReference ?? '' },
          { header: 'Status', value: (i) => STATUS[i.status].label },
        ],
      }}
      empty={{
        title: 'No invoices yet',
        description: 'Invoices appear here when you choose or renew a plan.',
      }}
    />
  );
}
