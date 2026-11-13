'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Loader2, Search, X } from 'lucide-react';
import { type FormEvent, useMemo, useRef, useState } from 'react';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { hasPermissionAnywhere } from '@/lib/auth/access';
import { authErrorMessage } from '@/lib/auth/errors';
import { useNotify } from '@/lib/notify';
import { useRestaurantOverview } from '../overview';
import { OrderDetail } from '../orders/order-detail';
import { BranchPicker, Toolbar } from '../_kit/ops-kit';
import { buttonPrimary, Card, control, ErrorNote, PageHeader, Skeleton } from '../_kit/report-kit';

type PaymentStatus =
  'pending' | 'partially_paid' | 'paid' | 'partially_refunded' | 'refunded' | 'cancelled';

interface Bill {
  id: string;
  orderNumber: string;
  channel: string;
  tableLabel: string | null;
  billLabel: string | null;
  customerName: string | null;
  customerPhone: string | null;
  status: string;
  paymentStatus: PaymentStatus;
  kitchenStatus: string;
  paymentPreference: string | null;
  methods: string[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  refundedMinor: number;
  dueMinor: number;
  currencyCode: string;
  needsReview: boolean;
  createdAt: string;
}
interface Desk {
  date: string;
  totals: Partial<Record<PaymentStatus, { count: number; totalMinor: number; dueMinor: number }>>;
  bills: Bill[];
}
interface Reconciliation {
  date: string;
  methods: {
    method: string;
    payments: number;
    collectedMinor: number;
    refundedMinor: number;
    netMinor: number;
  }[];
  totalCollectedMinor: number;
  totalRefundedMinor: number;
  totalNetMinor: number;
  openBills: { count: number; dueMinor: number };
  needsReview: {
    intentId: string;
    orderId: string;
    orderNumber: string;
    amountMinor: number;
    gatewayPaymentId: string | null;
    reason: string | null;
    since: string;
  }[];
  staleOnlineAttempts: number;
  integrity: {
    paidMismatch: number;
    completedUnpaid: number;
    orphanOnlinePayments: number;
    ok: boolean;
  };
}

const TABS = [
  { id: 'due', label: 'To collect', statuses: 'pending,partially_paid' },
  { id: 'paid', label: 'Paid', statuses: 'paid' },
  { id: 'refunds', label: 'Refunded', statuses: 'partially_refunded,refunded' },
  { id: 'cancelled', label: 'Cancelled', statuses: 'cancelled' },
  { id: 'recon', label: 'Reconciliation', statuses: '' },
] as const;
type Tab = (typeof TABS)[number]['id'];

const STATUS: Record<PaymentStatus, { label: string; cls: string }> = {
  pending: { label: 'Pending', cls: 'bg-amber-50 text-amber-800 ring-amber-600/20' },
  partially_paid: { label: 'Part paid', cls: 'bg-sky-50 text-sky-800 ring-sky-600/20' },
  paid: { label: 'Paid', cls: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20' },
  partially_refunded: {
    label: 'Part refunded',
    cls: 'bg-violet-50 text-violet-800 ring-violet-600/20',
  },
  refunded: { label: 'Refunded', cls: 'bg-slate-100 text-slate-700 ring-slate-500/20' },
  cancelled: { label: 'Cancelled', cls: 'bg-red-50 text-red-700 ring-red-600/20' },
};
const PREF: Record<string, string> = {
  counter_cash: 'Cash at counter',
  counter_card: 'Card at counter',
  online: 'Online',
};
const METHOD: Record<string, string> = { cash: 'Cash', card: 'Card', upi: 'UPI', online: 'Online' };
const money = (m: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(m / 100);

/**
 * Billing desk: every bill of the day by payment status, fast collection at the counter, and an
 * end-of-day reconciliation (collections by method, refunds, online payments needing review,
 * integrity checks). Collecting needs POS access; viewing needs order access.
 */
export default function BillingPage() {
  const { client } = useAuth();
  const profile = useProfile();
  const overview = useRestaurantOverview();
  const branches = overview.data?.branches ?? [];
  const [picked, setPicked] = useState('');
  const branchId = picked || branches[0]?.id || '';
  const [tab, setTab] = useState<Tab>('due');
  const [date, setDate] = useState('');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [collecting, setCollecting] = useState<Bill | null>(null);
  const canCollect = hasPermissionAnywhere(profile, 'pos:access');
  const statuses = TABS.find((t) => t.id === tab)!.statuses;

  const desk = useQuery({
    queryKey: ['billing', branchId, statuses, date, search],
    enabled: Boolean(branchId) && tab !== 'recon',
    queryFn: () =>
      client.request<Desk>(
        `/billing/bills?${new URLSearchParams({
          branchId,
          paymentStatus: statuses,
          ...(date ? { date } : {}),
          ...(search.trim() ? { q: search.trim() } : {}),
        })}`,
      ),
    refetchInterval: 15_000,
  });
  const recon = useQuery({
    queryKey: ['reconciliation', branchId, date],
    enabled: Boolean(branchId) && tab === 'recon',
    queryFn: () =>
      client.request<Reconciliation>(
        `/billing/reconciliation?${new URLSearchParams({ branchId, ...(date ? { date } : {}) })}`,
      ),
  });
  const t = desk.data?.totals ?? {};
  const due = (t.pending?.dueMinor ?? 0) + (t.partially_paid?.dueMinor ?? 0);

  return (
    <div className="mx-auto max-w-[96rem] space-y-5">
      <PageHeader
        title="Billing desk"
        description="Collect pending bills, check what was paid and how, and reconcile the day."
      />
      <Toolbar>
        <BranchPicker branches={branches} value={branchId} onChange={setPicked} />
        <input
          type="date"
          aria-label="Day"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className={cn(control, 'w-auto')}
        />
        {tab !== 'recon' ? (
          <label className="relative min-w-48 flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Table, bill, order no. or phone"
              className={cn(control, 'pl-9')}
            />
          </label>
        ) : null}
      </Toolbar>

      <div className="grid gap-3 sm:grid-cols-3">
        <Tile
          label="To collect"
          value={money(due)}
          hint={`${(t.pending?.count ?? 0) + (t.partially_paid?.count ?? 0)} bills`}
        />
        <Tile
          label="Paid bills"
          value={String(t.paid?.count ?? 0)}
          hint={money(t.paid?.totalMinor ?? 0)}
        />
        <Tile
          label="Refunded"
          value={String((t.refunded?.count ?? 0) + (t.partially_refunded?.count ?? 0))}
          hint="full or partial"
        />
      </div>

      <div
        role="tablist"
        className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-white/10"
      >
        {TABS.map((x) => (
          <button
            key={x.id}
            role="tab"
            aria-selected={tab === x.id}
            onClick={() => setTab(x.id)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              tab === x.id
                ? 'border-emerald-600 text-emerald-700 dark:text-emerald-300'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200',
            )}
          >
            {x.label}
          </button>
        ))}
      </div>

      {tab === 'recon' ? (
        <ReconciliationView q={recon} />
      ) : desk.isError ? (
        <ErrorNote error={desk.error} />
      ) : desk.isPending ? (
        <Skeleton className="h-64" />
      ) : desk.data.bills.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No bills here.</p>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500 uppercase">
                <tr className="border-b border-slate-200 dark:border-white/10">
                  <th className="px-3 py-2">Order</th>
                  <th className="px-3 py-2">Table / customer</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2 text-right">Paid</th>
                  <th className="px-3 py-2 text-right">Due</th>
                  <th className="px-3 py-2">Payment</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {desk.data.bills.map((b) => (
                  <tr
                    key={b.id}
                    className="border-b border-slate-100 last:border-0 dark:border-white/5"
                  >
                    <td className="px-3 py-2.5">
                      <span className="font-semibold tabular-nums">#{b.orderNumber}</span>
                      <span className="block text-xs text-slate-500">
                        {new Date(b.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      {b.tableLabel ? `Table ${b.tableLabel}` : b.channel}
                      {b.billLabel ? ` · ${b.billLabel}` : ''}
                      {b.customerName || b.customerPhone ? (
                        <span className="block text-xs text-slate-500">
                          {[b.customerName, b.customerPhone].filter(Boolean).join(' · ')}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {money(b.totalMinor)}
                      {b.discountMinor ? (
                        <span className="block text-xs text-slate-500">
                          −{money(b.discountMinor)} off
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {money(b.paidMinor)}
                      {b.refundedMinor ? (
                        <span className="block text-xs text-red-600">
                          −{money(b.refundedMinor)} refunded
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold tabular-nums">
                      {b.dueMinor ? money(b.dueMinor) : '—'}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={cn(
                          'inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
                          STATUS[b.paymentStatus].cls,
                        )}
                      >
                        {STATUS[b.paymentStatus].label}
                      </span>
                      {b.needsReview ? (
                        <span className="ml-1 inline-flex items-center gap-0.5 text-xs text-red-600">
                          <AlertTriangle className="size-3" /> review
                        </span>
                      ) : null}
                      <span className="block text-xs text-slate-500">
                        {b.methods.length
                          ? b.methods.map((m) => METHOD[m] ?? m).join(', ')
                          : b.paymentPreference
                            ? `Wants: ${PREF[b.paymentPreference] ?? b.paymentPreference}`
                            : ''}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => setOpenId(b.id)}
                        className="rounded-md px-2.5 py-1.5 text-xs font-medium ring-1 ring-slate-300 ring-inset hover:bg-slate-50 dark:ring-white/15 dark:hover:bg-white/5"
                      >
                        Open bill
                      </button>
                      {canCollect && b.dueMinor > 0 ? (
                        <button
                          type="button"
                          onClick={() => setCollecting(b)}
                          className="ml-2 rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                        >
                          Collect
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {openId ? (
        <OrderDetail
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => void desk.refetch()}
        />
      ) : null}
      {collecting ? <CollectDialog bill={collecting} onClose={() => setCollecting(null)} /> : null}
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-slate-900">
      <p className="text-xs font-medium text-slate-500 uppercase">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

/**
 * Collect at the counter. One request key per dialog: a double tap or a retry after a network
 * error returns the first result instead of charging twice.
 */
function CollectDialog({ bill, onClose }: { bill: Bill; onClose: () => void }) {
  const { client } = useAuth();
  const qc = useQueryClient();
  const notify = useNotify();
  const key = useRef(`desk-${crypto.randomUUID()}`);
  const [method, setMethod] = useState<'cash' | 'card' | 'upi'>(
    bill.paymentPreference === 'counter_card' ? 'card' : 'cash',
  );
  const [amount, setAmount] = useState((bill.dueMinor / 100).toFixed(2));
  const [reference, setReference] = useState('');
  const minor = Math.round(Number(amount) * 100);
  const pay = useMutation({
    mutationFn: () =>
      client.request(`/orders/${bill.id}/payments`, {
        method: 'POST',
        idempotencyKey: key.current,
        body: { method, amountMinor: minor, reference: reference.trim() || null },
      }),
    onSuccess: () => {
      notify.success(`Collected ${money(minor)} for order #${bill.orderNumber}`);
      void qc.invalidateQueries({ queryKey: ['billing'] });
      void qc.invalidateQueries({ queryKey: ['reconciliation'] });
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (minor > 0 && minor <= bill.dueMinor) pay.mutate();
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900"
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold">Collect · #{bill.orderNumber}</h2>
            <p className="text-sm text-slate-500">Due {money(bill.dueMinor)}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 text-slate-500">
            <X className="size-5" />
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {(['cash', 'card', 'upi'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMethod(m)}
              className={cn(
                'rounded-lg border py-2 text-sm font-medium',
                method === m
                  ? 'border-emerald-600 bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10'
                  : 'border-slate-200 dark:border-white/10',
              )}
            >
              {METHOD[m]}
            </button>
          ))}
        </div>
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Amount</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            className={control}
          />
        </label>
        {method !== 'cash' ? (
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Reference (terminal slip / UPI ref)</span>
            <input
              value={reference}
              maxLength={80}
              onChange={(e) => setReference(e.target.value)}
              className={control}
            />
          </label>
        ) : null}
        {minor > bill.dueMinor ? <p className="text-sm text-red-600">More than is due.</p> : null}
        {pay.isError ? <p className="text-sm text-red-600">{authErrorMessage(pay.error)}</p> : null}
        <button
          type="submit"
          disabled={pay.isPending || !(minor > 0) || minor > bill.dueMinor}
          className={cn(buttonPrimary, 'w-full justify-center')}
        >
          {pay.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          Collect {minor > 0 ? money(minor) : ''}
        </button>
      </form>
    </div>
  );
}

function ReconciliationView({ q }: { q: ReturnType<typeof useQuery<Reconciliation>> }) {
  const { client } = useAuth();
  const qc = useQueryClient();
  const notify = useNotify();
  const profile = useProfile();
  const canResolve = hasPermissionAnywhere(profile, 'order:refund');
  const resolve = useMutation({
    mutationFn: (v: { intentId: string; note: string }) =>
      client.request(`/billing/payment-reviews/${v.intentId}/resolve`, {
        method: 'POST',
        body: { note: v.note },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reconciliation'] }),
    onError: (e) => notify.error(e),
  });
  const r = q.data;
  const rows = useMemo(() => r?.methods ?? [], [r]);
  if (q.isError) return <ErrorNote error={q.error} />;
  if (!r) return <Skeleton className="h-64" />;
  return (
    <div className="space-y-4">
      <div
        className={cn(
          'flex items-center gap-2 rounded-xl border p-3 text-sm',
          r.integrity.ok
            ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200'
            : 'border-red-200 bg-red-50 text-red-900 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-200',
        )}
      >
        {r.integrity.ok ? (
          <CheckCircle2 className="size-5" />
        ) : (
          <AlertTriangle className="size-5" />
        )}
        {r.integrity.ok
          ? 'Books balance: every bill matches its payments.'
          : `Check needed: ${r.integrity.paidMismatch} bill(s) whose paid total differs from payments, ${r.integrity.completedUnpaid} closed but not fully paid, ${r.integrity.orphanOnlinePayments} online payment(s) without a confirmed attempt.`}
      </div>
      <Card>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500 uppercase">
            <tr className="border-b border-slate-200 dark:border-white/10">
              <th className="px-3 py-2">Method</th>
              <th className="px-3 py-2 text-right">Payments</th>
              <th className="px-3 py-2 text-right">Collected</th>
              <th className="px-3 py-2 text-right">Refunded</th>
              <th className="px-3 py-2 text-right">Net</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.method} className="border-b border-slate-100 dark:border-white/5">
                <td className="px-3 py-2">{METHOD[m.method] ?? m.method}</td>
                <td className="px-3 py-2 text-right tabular-nums">{m.payments}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(m.collectedMinor)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(m.refundedMinor)}</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">
                  {money(m.netMinor)}
                </td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className="px-3 py-2">Total</td>
              <td />
              <td className="px-3 py-2 text-right tabular-nums">{money(r.totalCollectedMinor)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{money(r.totalRefundedMinor)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{money(r.totalNetMinor)}</td>
            </tr>
          </tbody>
        </table>
      </Card>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Still owing today: <strong>{r.openBills.count}</strong> bill(s),{' '}
        {money(r.openBills.dueMinor)}.
        {r.staleOnlineAttempts
          ? ` ${r.staleOnlineAttempts} online payment attempt(s) were started but never finished.`
          : ''}
      </p>
      <section>
        <h3 className="mb-2 text-sm font-semibold">Online payments needing review</h3>
        {r.needsReview.length === 0 ? (
          <p className="text-sm text-slate-500">None.</p>
        ) : (
          <ul className="space-y-2">
            {r.needsReview.map((x) => (
              <li
                key={x.intentId}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-red-200 p-3 text-sm dark:border-red-500/20"
              >
                <span className="font-semibold">#{x.orderNumber}</span>
                <span className="tabular-nums">{money(x.amountMinor)}</span>
                <span className="text-slate-500">{x.gatewayPaymentId ?? 'no payment id'}</span>
                <span className="flex-1 text-slate-600 dark:text-slate-300">{x.reason}</span>
                {canResolve ? (
                  <button
                    type="button"
                    disabled={resolve.isPending}
                    onClick={() => {
                      const note = window.prompt(
                        'How was it handled? (e.g. refunded in Razorpay, collected at counter)',
                      );
                      if (note && note.trim().length >= 3)
                        resolve.mutate({ intentId: x.intentId, note: note.trim() });
                    }}
                    className="rounded-md px-2.5 py-1.5 text-xs font-medium ring-1 ring-slate-300 ring-inset dark:ring-white/15"
                  >
                    Mark resolved
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
