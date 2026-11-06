'use client';

import { Button } from '@foodstack/ui/components/button';
import { ConfirmDialog } from '@foodstack/ui/components/confirm-dialog';
import { Dialog } from '@foodstack/ui/components/dialog';
import { cn } from '@foodstack/ui/lib/utils';
import { useMutation } from '@tanstack/react-query';
import { Check, Loader2, Undo2, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useAuth } from '@/components/auth/auth-provider';
import { type Column, DataTable } from '@/components/data-table/data-table';
import { authErrorMessage } from '@/lib/auth/errors';
import { type Invoice, KIND_LABEL, METHOD_LABEL, money, PAYMENT_STATUS_META } from '@/lib/billing';
import { useNotify } from '@/lib/notify';
import { usePagedList } from '@/lib/paged';
import { AddonsAdmin } from './addons-admin';
import { PlansAdmin as Plans } from './plans-admin';
import {
  RestaurantSubscriptions,
  type SubscriptionGroup,
  useRefreshSubscriptions,
} from './restaurant-subscriptions';

type PlatformInvoice = Invoice & {
  tenantId: string;
  tenantName: string;
  ownerName?: string | null;
  ownerEmail?: string | null;
};

const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

type Tab = 'all' | SubscriptionGroup | 'payments' | 'plans' | 'addons';

export default function SubscriptionsAdminPage() {
  const [tab, setTab] = useState<Tab>('all');
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
            ['all', 'All Subscriptions'],
            ['pending', 'Pending Requests'],
            ['active', 'Active'],
            ['expired', 'Expired'],
            ['inactive', 'Cancelled / Suspended'],
            ['payments', 'Payments'],
            ['plans', 'Plans'],
            ['addons', 'Add-ons'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => {
              // Each tab's table keeps its sort/filters in the address bar; start the next one clean.
              if (id !== tab)
                window.history.replaceState(window.history.state, '', window.location.pathname);
              setTab(id);
            }}
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
      {tab === 'all' ? (
        <RestaurantSubscriptions key="all" />
      ) : tab === 'pending' || tab === 'active' || tab === 'expired' || tab === 'inactive' ? (
        <RestaurantSubscriptions key={tab} group={tab} />
      ) : tab === 'payments' ? (
        <Payments />
      ) : tab === 'plans' ? (
        <Plans />
      ) : (
        <AddonsAdmin />
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
  const notify = useNotify();
  const refreshAll = useRefreshSubscriptions();
  const [cancelling, setCancelling] = useState<PlatformInvoice | null>(null);
  const [refunding, setRefunding] = useState<PlatformInvoice | null>(null);
  const [reason, setReason] = useState('');
  const invoiceDetails = (i: PlatformInvoice) => [
    { label: 'Restaurant', value: i.tenantName },
    { label: 'Invoice', value: i.invoiceNumber },
    {
      label: 'Request',
      value: i.billingCycle ? `${i.planName} · ${i.billingCycle}` : i.planName,
    },
    { label: 'Amount', value: money(i.amountMinor, i.currencyCode) },
  ];

  const columns: Column<PlatformInvoice>[] = [
    {
      key: 'number',
      header: 'Invoice',
      cell: (i) => <span className="font-mono text-xs font-semibold">{i.invoiceNumber}</span>,
    },
    {
      key: 'tenant',
      header: 'Restaurant',
      cell: (i) => (
        <span>
          <span className="font-medium">{i.tenantName}</span>
          {i.ownerName ? (
            <span className="block text-xs text-muted-foreground">{i.ownerName}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'plan',
      header: 'Request',
      cell: (i) => (
        <span>
          {i.billingCycle ? `${i.planName} · ${i.billingCycle}` : i.planName}
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
      cell: (i) => {
        const m = PAYMENT_STATUS_META[i.paymentStatus ?? 'awaiting_payment'];
        return (
          <span>
            <span
              className={cn(
                'inline-flex rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset',
                m.cls,
              )}
              title={i.failureReason ?? i.refundReason ?? undefined}
            >
              {m.label}
            </span>
            {i.status === 'paid' && i.paymentMethod ? (
              <span className="block text-xs text-muted-foreground">
                {METHOD_LABEL[i.paymentMethod]}
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: 'txn',
      header: 'Transaction',
      hideOnMobile: true,
      cell: (i) =>
        i.transactionId ? (
          <span className="font-mono text-xs">{i.transactionId}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
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
              { value: 'failed', label: 'Payment failed' },
              { value: 'paid', label: 'Paid' },
              { value: 'expired', label: 'Session expired' },
              { value: 'cancelled', label: 'Cancelled' },
              { value: 'refunded', label: 'Refunded' },
            ],
          },
        ]}
        rowActions={(i) =>
          i.status === 'pending' ? (
            <>
              <Button size="sm" onClick={() => setPaying(i)}>
                <Check /> Mark paid
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCancelling(i)}>
                <X /> Cancel
              </Button>
            </>
          ) : i.status === 'paid' && i.kind === 'addon' ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setReason('');
                setRefunding(i);
              }}
            >
              <Undo2 /> Refund
            </Button>
          ) : null
        }
        empty={{
          title: 'Nothing here',
          description: 'Plan and add-on payments from restaurants appear here.',
        }}
      />
      {paying ? (
        <MarkPaid
          invoice={paying}
          onClose={() => setPaying(null)}
          onDone={() => {
            void refreshAll();
            notify.success(
              'Payment verified',
              `${paying.invoiceNumber} is paid and ${paying.tenantName} has been updated.`,
            );
          }}
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(cancelling)}
        onClose={() => setCancelling(null)}
        variant="warning"
        title="Cancel payment request?"
        description="The restaurant can request again later. Nothing changes on their subscription."
        details={cancelling ? invoiceDetails(cancelling) : undefined}
        confirmLabel="Cancel Request"
        cancelLabel="Keep"
        errorMessage={authErrorMessage}
        onConfirm={async () => {
          const i = cancelling!;
          await client.request<void>(`/platform/billing/invoices/${i.id}/cancel`, {
            method: 'POST',
          });
          await refreshAll();
          notify.success('Payment request cancelled', i.invoiceNumber);
        }}
      />
      <ConfirmDialog
        open={Boolean(refunding)}
        onClose={() => setRefunding(null)}
        variant="danger"
        icon={Undo2}
        title="Refund add-on purchase?"
        description="The extra capacity is removed immediately. Return the money to the restaurant through your payment provider."
        details={refunding ? invoiceDetails(refunding) : undefined}
        confirmLabel="Refund"
        confirmDisabled={reason.trim().length < 3}
        errorMessage={authErrorMessage}
        onConfirm={async () => {
          const i = refunding!;
          await client.request(`/platform/billing/invoices/${i.id}/refund`, {
            method: 'POST',
            body: { reason: reason.trim() },
          });
          await refreshAll();
          notify.success('Add-on refunded', `${i.invoiceNumber} · capacity removed`);
        }}
      >
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Reason</span>
          <input
            value={reason}
            maxLength={300}
            autoFocus
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Bought by mistake"
            aria-describedby="refund-reason-hint"
            className="h-9 w-full rounded-md border bg-background px-3 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
          />
          <span id="refund-reason-hint" className="block text-xs text-muted-foreground">
            Recorded in the restaurant&apos;s history (at least 3 characters).
          </span>
        </label>
      </ConfirmDialog>
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
    <Dialog open onClose={onClose} label="Mark invoice paid" dismissible={!pay.isPending}>
      <form onSubmit={submit} className="space-y-4 p-6">
        <h2 className="text-lg font-semibold">Confirm payment received</h2>
        <p className="text-sm text-muted-foreground">
          {invoice.tenantName} · {invoice.invoiceNumber} ·{' '}
          <strong>{money(invoice.amountMinor, invoice.currencyCode)}</strong> for {invoice.planName}{' '}
          {invoice.billingCycle ? `(${invoice.billingCycle})` : ''}. Only confirm after the money is
          in your account.
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
    </Dialog>
  );
}
