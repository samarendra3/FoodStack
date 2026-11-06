'use client';

import { Button } from '@foodstack/ui/components/button';
import { SuspendConfirmDialog } from '@foodstack/ui/components/confirm-dialog';
import { cn } from '@foodstack/ui/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, Loader2, PauseCircle, PlayCircle, Sparkles, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useAuth } from '@/components/auth/auth-provider';
import { type Column, DataTable } from '@/components/data-table/data-table';
import { authErrorMessage } from '@/lib/auth/errors';
import {
  type Cycle,
  type Invoice,
  METHOD_LABEL,
  money,
  PAYMENT_STATUS_META,
  type PaymentStatus,
  type Plan,
  STATUS_META,
  type SubscriptionStatus,
} from '@/lib/billing';
import { useNotify } from '@/lib/notify';
import { usePagedList } from '@/lib/paged';

interface RestaurantSubscription {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  tenantStatus: string;
  status: SubscriptionStatus;
  hasAccess: boolean;
  planId: string | null;
  planName: string | null;
  billingCycle: Cycle | null;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  remainingDays: number;
  statusReason: string | null;
  statusChangedAt: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  /** What the restaurant is on now (paid plan's agreed terms, or the Free Trial). */
  currentPlan: {
    name: string;
    billingCycle: Cycle | null;
    priceMinor: number | null;
    currencyCode: string;
  } | null;
  /** The open request awaiting payment; it becomes current only after verified payment. */
  requested: Invoice | null;
  /** The latest request or payment for this restaurant. */
  lastInvoice: Invoice | null;
}

/**
 * Refreshes every Super Admin subscription tab and the payments list. Billing actions change
 * rows in several tabs at once (e.g. a verified payment moves a restaurant from Pending to
 * Active), so all of them reload instead of showing cached rows.
 */
export function useRefreshSubscriptions() {
  const qc = useQueryClient();
  return () =>
    qc.invalidateQueries({
      predicate: (q) => {
        const k = String(q.queryKey[0]);
        return (
          k.startsWith('platform-subscriptions') ||
          k === 'platform-invoices' ||
          k === 'platform-subscription'
        );
      },
    });
}

export type SubscriptionGroup = 'pending' | 'active' | 'expired' | 'inactive';

interface SubscriptionDetail extends RestaurantSubscription {
  events: {
    id: string;
    event: string;
    fromStatus: string | null;
    toStatus: string | null;
    reason: string | null;
    actorName: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
  }[];
  invoices: Invoice[];
}

const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const dayTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const fmt = (d: string | null) => (d ? day.format(new Date(d)) : '—');

const EVENT_LABEL: Record<string, string> = {
  trial_expired: 'Trial expired',
  expired: 'Expired',
  past_due: 'Payment overdue',
  checkout_started: 'Checkout started',
  checkout_cancelled: 'Checkout cancelled',
  checkout_expired: 'Payment session expired',
  addon_purchased: 'Add-on purchased',
  addon_revoked: 'Add-on refunded',
  addon_expired: 'Add-on expired',
  payment_succeeded: 'Payment received',
  payment_failed: 'Payment failed',
  trial_extended: 'Trial extended',
  admin_activated: 'Plan granted by admin',
  suspended: 'Suspended',
  reinstated: 'Reinstated',
};

function StatusPill({ status }: { status: SubscriptionStatus }) {
  const m = STATUS_META[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        m.cls,
      )}
    >
      <span className={cn('size-1.5 rounded-full', m.dot)} /> {m.label}
    </span>
  );
}

function PaymentPill({ invoice }: { invoice: Invoice | null }) {
  if (!invoice?.paymentStatus) return <span className="text-muted-foreground">—</span>;
  const m = PAYMENT_STATUS_META[invoice.paymentStatus];
  return (
    <span
      className={cn(
        'inline-flex rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset',
        m.cls,
      )}
      title={invoice.failureReason ?? undefined}
    >
      {m.label}
    </span>
  );
}

const GROUP_COPY: Record<
  'all' | SubscriptionGroup,
  { empty: string; sort: string; order: 'asc' | 'desc' }
> = {
  all: { empty: 'Restaurants appear here once created.', sort: 'periodEnd', order: 'asc' },
  pending: {
    empty: 'No subscription requests are waiting for payment.',
    sort: 'requestedAt',
    order: 'desc',
  },
  active: { empty: 'No active paid subscriptions yet.', sort: 'periodEnd', order: 'asc' },
  expired: { empty: 'No expired subscriptions.', sort: 'periodEnd', order: 'desc' },
  inactive: { empty: 'No cancelled or suspended subscriptions.', sort: 'periodEnd', order: 'desc' },
};

/**
 * Super Admin subscriptions list. One component for every tab: `group` fixes the server-side
 * filter (pending requests, active, expired, cancelled / suspended); search, filters, sorting
 * and pagination all run on the server.
 */
export function RestaurantSubscriptions({ group }: { group?: SubscriptionGroup }) {
  const [open, setOpen] = useState<string | null>(null);
  const refreshAll = useRefreshSubscriptions();
  const copy = GROUP_COPY[group ?? 'all'];
  const list = usePagedList<RestaurantSubscription>(
    `platform-subscriptions-${group ?? 'all'}`,
    '/platform/billing/subscriptions',
    {
      sortBy: copy.sort,
      sortOrder: copy.order,
      filters: { group: group ?? '', status: '', paymentStatus: '' },
    },
  );

  const columns: Column<RestaurantSubscription>[] = [
    {
      key: 'name',
      header: 'Restaurant',
      sortKey: 'name',
      cell: (s) => (
        <button
          type="button"
          className="text-left font-medium hover:text-primary hover:underline"
          onClick={() => setOpen(s.tenantId)}
        >
          {s.tenantName}
          <span className="block text-xs font-normal text-muted-foreground">
            {s.ownerName ? `${s.ownerName} · ${s.ownerEmail}` : s.tenantSlug}
          </span>
        </button>
      ),
    },
    {
      key: 'current',
      header: 'Current plan',
      cell: (s) =>
        s.currentPlan ? (
          <span>
            <span className="font-medium">{s.currentPlan.name}</span>
            {s.currentPlan.billingCycle ? (
              <span className="block text-xs text-muted-foreground capitalize">
                {s.currentPlan.billingCycle}
              </span>
            ) : null}
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'requested',
      header: 'Requested plan',
      sortKey: 'requestedAt',
      hideOnMobile: true,
      cell: (s) =>
        s.requested ? (
          <span>
            {s.requested.planName}
            <span className="block text-xs text-muted-foreground">
              {s.requested.billingCycle
                ? `${s.requested.billingCycle} · `
                : s.requested.kind === 'addon'
                  ? 'Add-on · '
                  : ''}
              {money(s.requested.amountMinor, s.requested.currencyCode)} ·{' '}
              {fmt(s.requested.createdAt)}
            </span>
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
      hideOnMobile: true,
      cell: (s) =>
        s.currentPlan?.priceMinor != null && s.currentPlan.name !== 'Free Trial' ? (
          <span className="tabular-nums">
            {money(s.currentPlan.priceMinor, s.currentPlan.currencyCode)}
            <span className="block text-xs text-muted-foreground">
              per {s.currentPlan.billingCycle === 'yearly' ? 'year' : 'month'}
            </span>
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'payment',
      header: 'Payment',
      cell: (s) => <PaymentPill invoice={s.requested ?? s.lastInvoice} />,
    },
    { key: 'status', header: 'Subscription', cell: (s) => <StatusPill status={s.status} /> },
    {
      key: 'start',
      header: 'Start date',
      hideOnMobile: true,
      cell: (s) => fmt(s.periodStart ?? s.trialStartedAt),
    },
    {
      key: 'end',
      header: 'Expiry date',
      sortKey: 'periodEnd',
      cell: (s) =>
        s.periodEnd ? (
          <span>
            {fmt(s.periodEnd)}
            <span
              className={cn(
                'block text-xs',
                s.hasAccess && s.remainingDays <= 3 ? 'text-red-600' : 'text-muted-foreground',
              )}
            >
              {s.hasAccess ? `${s.remainingDays} days left` : 'No access'}
            </span>
          </span>
        ) : (
          'No end'
        ),
    },
    {
      key: 'txn',
      header: 'Transaction',
      hideOnMobile: true,
      cell: (s) =>
        s.lastInvoice?.transactionId ? (
          <span className="font-mono text-xs" title={s.lastInvoice.invoiceNumber}>
            {s.lastInvoice.transactionId}
          </span>
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
        getRowId={(s) => s.id}
        searchPlaceholder="Restaurant, invoice or transaction ID"
        filters={[
          ...(group
            ? []
            : [
                {
                  key: 'status',
                  label: 'Subscription',
                  options: (Object.keys(STATUS_META) as SubscriptionStatus[]).map((k) => ({
                    value: k,
                    label: STATUS_META[k].label,
                  })),
                },
              ]),
          {
            key: 'paymentStatus',
            label: 'Payment',
            options: (Object.keys(PAYMENT_STATUS_META) as PaymentStatus[]).map((k) => ({
              value: k,
              label: PAYMENT_STATUS_META[k].label,
            })),
          },
        ]}
        rowActions={(s) => (
          <Button size="sm" variant="outline" onClick={() => setOpen(s.tenantId)}>
            Manage
          </Button>
        )}
        empty={{ title: 'Nothing here', description: copy.empty }}
      />
      {open ? (
        <Detail tenantId={open} onClose={() => setOpen(null)} onChanged={() => void refreshAll()} />
      ) : null}
    </>
  );
}

type Action = 'extend' | 'activate' | 'suspend' | 'reinstate';

function Detail({
  tenantId,
  onClose,
  onChanged,
}: {
  tenantId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { client } = useAuth();
  const notify = useNotify();
  const [suspendReason, setSuspendReason] = useState('');
  const [action, setAction] = useState<Action | null>(null);
  const q = useQuery({
    queryKey: ['platform-subscription', tenantId],
    queryFn: () =>
      client.request<SubscriptionDetail>(`/platform/billing/subscriptions/${tenantId}`),
  });
  const s = q.data;
  const paid = Boolean(s?.planId) && s?.status !== 'expired';

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-950/50"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-xl flex-col overflow-y-auto bg-card shadow-2xl">
        <div className="flex items-start justify-between border-b p-5">
          <div>
            <h2 className="text-lg font-semibold">{s?.tenantName ?? 'Subscription'}</h2>
            {s ? <StatusPill status={s.status} /> : null}
          </div>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close">
            <X />
          </Button>
        </div>
        {q.isError ? (
          <p className="p-5 text-sm text-red-600">{authErrorMessage(q.error)}</p>
        ) : !s ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="space-y-6 p-5">
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <Fact k="Plan" v={s.planName ? `${s.planName} · ${s.billingCycle}` : 'Free trial'} />
              <Fact k="Remaining" v={s.hasAccess ? `${s.remainingDays} days` : 'No access'} />
              <Fact k="Trial started" v={fmt(s.trialStartedAt)} />
              <Fact k="Trial ends" v={fmt(s.trialEndsAt)} />
              <Fact k="Period start" v={fmt(s.periodStart)} />
              <Fact k="Period end" v={s.periodEnd ? fmt(s.periodEnd) : 'No end'} />
              {s.statusReason ? <Fact k="Reason" v={s.statusReason} /> : null}
            </dl>

            <div className="flex flex-wrap gap-2">
              {!paid && s.status !== 'suspended' ? (
                <Button size="sm" onClick={() => setAction('extend')}>
                  <CalendarPlus /> Extend trial
                </Button>
              ) : null}
              {s.status !== 'suspended' ? (
                <Button size="sm" variant="outline" onClick={() => setAction('activate')}>
                  <Sparkles /> Grant plan
                </Button>
              ) : null}
              {s.status === 'suspended' ? (
                <Button size="sm" onClick={() => setAction('reinstate')}>
                  <PlayCircle /> Reinstate
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setAction('suspend')}>
                  <PauseCircle /> Suspend
                </Button>
              )}
            </div>

            {action && action !== 'suspend' ? (
              <ActionForm
                action={action}
                tenantId={tenantId}
                onDone={() => {
                  setAction(null);
                  void q.refetch();
                  onChanged();
                  notify.success(
                    {
                      extend: 'Trial extended successfully',
                      activate: 'Plan granted successfully',
                      reinstate: 'Restaurant reinstated successfully',
                    }[action],
                    s.tenantName,
                  );
                }}
                onCancel={() => setAction(null)}
              />
            ) : null}
            <SuspendConfirmDialog
              open={action === 'suspend'}
              onClose={() => setAction(null)}
              entity="restaurant"
              title={`Suspend ${s.tenantName}?`}
              confirmLabel="Suspend Restaurant"
              description="Staff lose access to operations immediately. Data is kept, owners can still see their subscription, and payments do not lift a suspension. You can reinstate it at any time."
              details={[
                { label: 'Restaurant', value: s.tenantName },
                {
                  label: 'Plan',
                  value: s.planName ? `${s.planName} · ${s.billingCycle}` : 'Free trial',
                },
                { label: 'Status', value: STATUS_META[s.status]?.label ?? s.status },
              ]}
              confirmDisabled={suspendReason.trim().length < 3}
              errorMessage={authErrorMessage}
              onConfirm={async () => {
                await client.request(`/platform/billing/subscriptions/${tenantId}/suspend`, {
                  method: 'POST',
                  body: { reason: suspendReason.trim() },
                });
                setSuspendReason('');
                void q.refetch();
                onChanged();
                notify.success('Restaurant suspended successfully', s.tenantName);
              }}
            >
              <label className="block space-y-1 text-sm">
                <span className="font-medium">Reason</span>
                <input
                  value={suspendReason}
                  maxLength={300}
                  onChange={(e) => setSuspendReason(e.target.value)}
                  placeholder="e.g. Payment dispute"
                  aria-describedby="suspend-reason-hint"
                  className="h-9 w-full rounded-md border bg-background px-3 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-500/20"
                />
                <span id="suspend-reason-hint" className="block text-xs text-muted-foreground">
                  Kept in the subscription history (at least 3 characters).
                </span>
              </label>
            </SuspendConfirmDialog>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Payments & renewals</h3>
              {s.invoices.length === 0 ? (
                <p className="text-sm text-muted-foreground">No invoices yet.</p>
              ) : (
                <ul className="divide-y rounded-xl border text-sm">
                  {s.invoices.map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-3 p-3">
                      <span>
                        <span className="font-mono text-xs font-semibold">{i.invoiceNumber}</span>
                        <span className="block text-xs text-muted-foreground">
                          {i.planName} · {i.billingCycle} · {dayTime.format(new Date(i.createdAt))}
                        </span>
                        {i.failureReason && i.status === 'pending' ? (
                          <span className="block text-xs text-red-600">
                            Failed: {i.failureReason}
                          </span>
                        ) : null}
                      </span>
                      <span className="text-right">
                        {money(i.amountMinor, i.currencyCode)}
                        <span className="block text-xs capitalize text-muted-foreground">
                          {i.status}
                          {i.paymentMethod
                            ? ` · ${METHOD_LABEL[i.paymentMethod] ?? i.paymentMethod}`
                            : ''}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">History</h3>
              <ol className="space-y-3 border-l pl-4 text-sm">
                {s.events.map((e) => (
                  <li key={e.id}>
                    <p className="font-medium">
                      {EVENT_LABEL[e.event] ?? e.event}
                      {e.fromStatus && e.toStatus && e.fromStatus !== e.toStatus ? (
                        <span className="font-normal text-muted-foreground">
                          {' '}
                          · {e.fromStatus} → {e.toStatus}
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {dayTime.format(new Date(e.createdAt))}
                      {e.actorName ? ` · by ${e.actorName}` : ' · system'}
                      {e.reason ? ` · ${e.reason}` : ''}
                    </p>
                  </li>
                ))}
                {s.events.length === 0 ? (
                  <li className="text-muted-foreground">No changes yet.</li>
                ) : null}
              </ol>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}

function ActionForm({
  action,
  tenantId,
  onDone,
  onCancel,
}: {
  action: Action;
  tenantId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { client } = useAuth();
  const [days, setDays] = useState(7);
  const [reason, setReason] = useState('');
  const [planId, setPlanId] = useState('');
  const [cycle, setCycle] = useState<Cycle>('monthly');
  const [error, setError] = useState<string | null>(null);
  const plans = useQuery({
    queryKey: ['platform-plans'],
    queryFn: () => client.request<Plan[]>('/platform/billing/plans'),
    enabled: action === 'activate',
  });
  const run = useMutation({
    mutationFn: () => {
      const base = `/platform/billing/subscriptions/${tenantId}`;
      const body =
        action === 'extend'
          ? { days, reason: reason.trim() }
          : action === 'activate'
            ? { planId, billingCycle: cycle, reason: reason.trim() }
            : action === 'suspend'
              ? { reason: reason.trim() }
              : undefined;
      const path = action === 'extend' ? 'extend-trial' : action;
      return client.request(`${base}/${path}`, { method: 'POST', body });
    },
    onSuccess: onDone,
    onError: (e) => setError(authErrorMessage(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (action !== 'reinstate' && reason.trim().length < 3) {
      return setError('Give a short reason; it is kept in the history.');
    }
    if (action === 'activate' && !planId) return setError('Choose a plan.');
    setError(null);
    run.mutate();
  };
  const title = {
    extend: 'Extend free trial',
    activate: 'Grant a plan without payment',
    suspend: 'Suspend subscription',
    reinstate: 'Reinstate subscription',
  }[action];

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border bg-muted/30 p-4 text-sm">
      <h3 className="font-semibold">{title}</h3>
      {action === 'extend' ? (
        <label className="block space-y-1">
          <span className="font-medium">Days to add</span>
          <input
            type="number"
            min={1}
            max={90}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="h-9 w-32 rounded-lg border bg-background px-3"
          />
        </label>
      ) : null}
      {action === 'activate' ? (
        <div className="flex flex-wrap gap-2">
          <select
            value={planId}
            onChange={(e) => setPlanId(e.target.value)}
            className="h-9 flex-1 rounded-lg border bg-background px-3"
            aria-label="Plan"
          >
            <option value="">Choose a plan…</option>
            {plans.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            value={cycle}
            onChange={(e) => setCycle(e.target.value as Cycle)}
            className="h-9 rounded-lg border bg-background px-3"
            aria-label="Billing cycle"
          >
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </select>
        </div>
      ) : null}
      {action === 'suspend' ? (
        <p className="text-muted-foreground">
          Staff lose access to operations immediately. Data is kept, and owners can still see their
          subscription. Payments do not lift a suspension.
        </p>
      ) : null}
      {action === 'reinstate' ? (
        <p className="text-muted-foreground">
          Access returns according to the dates: trial, active plan, or expired.
        </p>
      ) : (
        <label className="block space-y-1">
          <span className="font-medium">Reason</span>
          <input
            value={reason}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
            className="h-9 w-full rounded-lg border bg-background px-3"
          />
        </label>
      )}
      {error ? (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          variant={action === 'suspend' ? 'destructive' : 'default'}
          disabled={run.isPending}
        >
          {run.isPending ? <Loader2 className="animate-spin" /> : null} Confirm
        </Button>
      </div>
    </form>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{k}</dt>
      <dd className="mt-0.5 font-medium">{v}</dd>
    </div>
  );
}
