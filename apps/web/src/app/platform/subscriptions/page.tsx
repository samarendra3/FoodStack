'use client';

import { Button } from '@foodstack/ui/components/button';
import { cn } from '@foodstack/ui/lib/utils';
import { useMutation } from '@tanstack/react-query';
import { Check, Loader2, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useAuth } from '@/components/auth/auth-provider';
import { type Column, DataTable } from '@/components/data-table/data-table';
import { authErrorMessage } from '@/lib/auth/errors';
import { type Invoice, KIND_LABEL, METHOD_LABEL, money } from '@/lib/billing';
import { usePagedList } from '@/lib/paged';
import { PlansAdmin as Plans } from './plans-admin';
import { RestaurantSubscriptions } from './restaurant-subscriptions';

type PlatformInvoice = Invoice & { tenantId: string; tenantName: string };

const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export default function SubscriptionsAdminPage() {
  const [tab, setTab] = useState<'restaurants' | 'payments' | 'plans'>('restaurants');
  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Subscriptions</h1>
        <p className="text-sm text-muted-foreground">
          Trials and plans for every restaurant, offline payments to verify, and the plan catalogue.
          Online payments activate automatically once the gateway confirms them.
        </p>
      </div>
      <div className="flex gap-1 border-b" role="tablist">
        {(
          [
            ['restaurants', 'Restaurants'],
            ['payments', 'Payments to verify'],
            ['plans', 'Plans'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              '-mb-px border-b-2 px-4 py-2.5 text-sm font-medium',
              tab === id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'restaurants' ? (
        <RestaurantSubscriptions />
      ) : tab === 'payments' ? (
        <Payments />
      ) : (
        <Plans />
      )}
    </div>
  );
}

function Payments() {
  const { client } = useAuth();
  const [paying, setPaying] = useState<PlatformInvoice | null>(null);
  const list = usePagedList<PlatformInvoice>('platform-invoices', '/platform/billing/invoices', {
    sortBy: 'createdAt',
    filters: { status: 'pending' },
  });
  const cancel = useMutation({
    mutationFn: (id: string) =>
      client.request<void>(`/platform/billing/invoices/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => list.refetch(),
  });

  const columns: Column<PlatformInvoice>[] = [
    {
      key: 'number',
      header: 'Invoice',
      cell: (i) => <span className="font-mono text-xs font-semibold">{i.invoiceNumber}</span>,
    },
    {
      key: 'tenant',
      header: 'Restaurant',
      cell: (i) => <span className="font-medium">{i.tenantName}</span>,
    },
    {
      key: 'plan',
      header: 'Request',
      cell: (i) => (
        <span>
          {i.planName} · {i.billingCycle}
          <span className="block text-xs text-muted-foreground">{KIND_LABEL[i.kind]}</span>
        </span>
      ),
    },
    {
      key: 'date',
      header: 'Requested',
      sortKey: 'createdAt',
      hideOnMobile: true,
      cell: (i) => day.format(new Date(i.createdAt)),
    },
    {
      key: 'amount',
      header: 'Amount',
      sortKey: 'amountMinor',
      align: 'right',
      cell: (i) => money(i.amountMinor, i.currencyCode),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (i) =>
        i.status === 'paid' ? (
          <span className="text-xs text-emerald-700">
            Paid · {i.paymentMethod ? METHOD_LABEL[i.paymentMethod] : ''}
          </span>
        ) : (
          <span className="text-xs capitalize text-muted-foreground">{i.status}</span>
        ),
    },
  ];

  return (
    <>
      <DataTable
        list={list}
        columns={columns}
        getRowId={(i) => i.id}
        searchPlaceholder="Invoice number or restaurant"
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'pending', label: 'Pending' },
              { value: 'paid', label: 'Paid' },
              { value: 'cancelled', label: 'Cancelled' },
            ],
          },
        ]}
        rowActions={(i) =>
          i.status === 'pending' ? (
            <>
              <Button size="sm" onClick={() => setPaying(i)}>
                <Check /> Mark paid
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={cancel.isPending}
                onClick={() => window.confirm(`Cancel ${i.invoiceNumber}?`) && cancel.mutate(i.id)}
              >
                <X /> Cancel
              </Button>
            </>
          ) : null
        }
        empty={{
          title: 'Nothing to verify',
          description: 'Plan requests from restaurants appear here.',
        }}
      />
      {paying ? (
        <MarkPaid invoice={paying} onClose={() => setPaying(null)} onDone={() => list.refetch()} />
      ) : null}
    </>
  );
}

function MarkPaid({
  invoice,
  onClose,
  onDone,
}: {
  invoice: PlatformInvoice;
  onClose: () => void;
  onDone: () => void;
}) {
  const { client } = useAuth();
  const [method, setMethod] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pay = useMutation({
    mutationFn: () =>
      client.request(`/platform/billing/invoices/${invoice.id}/mark-paid`, {
        method: 'POST',
        body: {
          paymentMethod: method,
          paymentReference: reference.trim(),
          note: note.trim() || null,
        },
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (e) => setError(authErrorMessage(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!reference.trim()) return setError('Enter the transaction / UTR reference you verified.');
    pay.mutate();
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Mark invoice paid"
    >
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-950/50"
        onClick={onClose}
      />
      <form
        onSubmit={submit}
        className="relative w-full max-w-md space-y-4 rounded-2xl bg-card p-6 shadow-2xl"
      >
        <h2 className="text-lg font-semibold">Confirm payment received</h2>
        <p className="text-sm text-muted-foreground">
          {invoice.tenantName} · {invoice.invoiceNumber} ·{' '}
          <strong>{money(invoice.amountMinor, invoice.currencyCode)}</strong> for {invoice.planName}{' '}
          ({invoice.billingCycle}). Only confirm after the money is in your account.
        </p>
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">Method</span>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="h-10 w-full rounded-lg border bg-background px-3"
          >
            {Object.entries(METHOD_LABEL)
              .filter(([v]) => v !== 'online') // online payments are verified by the gateway
              .map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
          </select>
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">Transaction reference / UTR</span>
          <input
            value={reference}
            maxLength={80}
            onChange={(e) => setReference(e.target.value)}
            className="h-10 w-full rounded-lg border bg-background px-3"
          />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">Note (optional)</span>
          <input
            value={note}
            maxLength={300}
            onChange={(e) => setNote(e.target.value)}
            className="h-10 w-full rounded-lg border bg-background px-3"
          />
        </label>
        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pay.isPending}>
            {pay.isPending ? <Loader2 className="animate-spin" /> : <Check />} Confirm & activate
          </Button>
        </div>
      </form>
    </div>
  );
}
