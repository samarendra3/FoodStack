'use client';

import { Dialog } from '@foodstack/ui/components/dialog';
import { cn } from '@foodstack/ui/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Loader2, QrCode, Receipt, UserRound, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { authErrorMessage } from '@/lib/auth/errors';
import { useNotify } from '@/lib/notify';

/*
 * Table details: the current sitting grouped by guest (QR) plus staff orders, with every order's
 * number, time, amount and kitchen status, each guest's total / paid / outstanding and billing
 * history. Cashiers can take a payment for one guest or the whole table and close the sitting.
 */

interface SessionOrder {
  id: string;
  orderNumber: number;
  createdAt: string;
  status: 'open' | 'completed' | 'cancelled';
  kitchenStatus: 'new' | 'accepted' | 'preparing' | 'ready' | 'served';
  itemCount: number;
  totalMinor: number;
  paidMinor: number;
  dueMinor: number;
}
interface Bill {
  orders: SessionOrder[];
  totalMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  payments: {
    id: string;
    orderId: string;
    method: string;
    amountMinor: number;
    refundedMinor: number;
    createdAt: string;
  }[];
}
interface TableSession {
  session: {
    id: string;
    status: 'open' | 'closed';
    openedVia: 'qr' | 'staff';
    openedAt: string;
    closedAt: string | null;
    table: { id: string; label: string; area: string };
    branch: { id: string; name: string };
    currencyCode: string;
  };
  guests: (Bill & {
    id: string;
    name: string;
    number: number;
    joinedAt: string;
    lastSeenAt: string;
  })[];
  table: (Bill & { name: string }) | null;
  totals: { totalMinor: number; paidMinor: number; outstandingMinor: number };
  canTakePayment: boolean;
  sittings: { id: string; status: string; openedAt: string; closedAt: string | null }[];
}

type PayScope = { label: string; guestId?: string; unassigned?: boolean; dueMinor: number };

const KITCHEN = {
  new: ['New', 'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300'],
  accepted: ['Accepted', 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'],
  preparing: ['Preparing', 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'],
  ready: ['Ready', 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'],
  served: ['Served', 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300'],
} as const;
const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const btn =
  'inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 px-2.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/5';

export function TableSessionPanel({
  tableId,
  tableLabel,
  onClose,
}: {
  tableId: string;
  tableLabel: string;
  onClose: () => void;
}) {
  const { client } = useAuth();
  const profile = useProfile();
  const qc = useQueryClient();
  const notify = useNotify();
  const [sittingId, setSittingId] = useState<string | null>(null);
  const [pay, setPay] = useState<PayScope | null>(null);
  const [copied, setCopied] = useState(false);
  const key = ['table-session', profile.activeTenant?.id, tableId, sittingId];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      client.request<TableSession | null>(
        sittingId ? `/table-sessions?sessionId=${sittingId}` : `/table-sessions?tableId=${tableId}`,
      ),
    refetchInterval: 10_000,
  });
  const d = q.data;
  const money = (m: number) =>
    new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: d?.session.currencyCode ?? 'INR',
    }).format(m / 100);
  // The link carries the table's QR secret; only managers may see it (others get no link).
  const qr = useQuery({
    queryKey: ['table-qr', tableId],
    queryFn: () => client.request<{ key: string }>(`/tables/${tableId}/qr`),
    retry: false,
  });
  const qrUrl =
    typeof window !== 'undefined' && profile.activeTenant && qr.data
      ? `${window.location.origin}/t/${profile.activeTenant.id}/${tableId}?k=${qr.data.key}`
      : '';

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['table-session'] });
    await qc.invalidateQueries({ queryKey: ['tables'] });
  };
  const close = async () => {
    try {
      await client.request(`/table-sessions/${d!.session.id}/close`, { method: 'POST' });
      notify.success(`Table ${tableLabel} closed`);
      await refresh();
    } catch (e) {
      notify.error(e);
    }
  };

  return (
    <Dialog open onClose={onClose} size="xl" label={`Table ${tableLabel}`}>
      <div className="flex max-h-[88dvh] flex-col">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-white/10">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">Table {tableLabel}</h2>
            <p className="text-sm text-muted-foreground">
              {d
                ? `${d.session.status === 'open' ? 'Open' : 'Closed'} sitting · started ${dateTime.format(new Date(d.session.openedAt))}${d.session.openedVia === 'qr' ? ' by QR scan' : ''}`
                : 'No sitting yet'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {d && d.sittings.length > 1 ? (
              <select
                aria-label="Sitting"
                value={sittingId ?? ''}
                onChange={(e) => setSittingId(e.target.value || null)}
                className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-white/10 dark:bg-white/5"
              >
                <option value="">Latest sitting</option>
                {d.sittings.map((s) => (
                  <option key={s.id} value={s.id}>
                    {dateTime.format(new Date(s.openedAt))} · {s.status}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10"
            >
              <X className="size-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {q.isError ? (
            <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">
              {authErrorMessage(q.error)}
            </p>
          ) : null}
          {q.isPending ? <Loader2 className="mx-auto size-5 animate-spin text-slate-400" /> : null}

          {qrUrl ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 p-3 text-sm dark:bg-white/5">
              <QrCode className="size-4 text-slate-500" />
              <span className="text-muted-foreground">Guest ordering link for this table:</span>
              <code className="min-w-0 flex-1 truncate text-xs">{qrUrl}</code>
              <button
                type="button"
                className={btn}
                onClick={() => {
                  void navigator.clipboard.writeText(qrUrl).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}{' '}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          ) : null}

          {d === null ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nobody has ordered at this table yet. Guests start a sitting by scanning the QR code.
            </p>
          ) : d ? (
            <>
              <div className="grid grid-cols-3 gap-3">
                <Total label="Table total" value={money(d.totals.totalMinor)} />
                <Total
                  label="Paid"
                  value={money(d.totals.paidMinor)}
                  tone="text-emerald-700 dark:text-emerald-400"
                />
                <Total
                  label="Outstanding"
                  value={money(d.totals.outstandingMinor)}
                  tone="text-amber-700 dark:text-amber-400"
                />
              </div>

              {[
                ...d.guests.map((g) => ({
                  ...g,
                  key: g.id,
                  sub: `Guest ${g.number} · joined ${time.format(new Date(g.joinedAt))}`,
                  scope: { label: g.name, guestId: g.id } as Omit<PayScope, 'dueMinor'>,
                })),
                ...(d.table
                  ? [
                      {
                        ...d.table,
                        key: 'table',
                        sub: 'Orders taken by staff',
                        scope: { label: 'Staff orders', unassigned: true } as Omit<
                          PayScope,
                          'dueMinor'
                        >,
                      },
                    ]
                  : []),
              ].map((g) => (
                <section
                  key={g.key}
                  className="rounded-xl border border-slate-200 dark:border-white/10"
                >
                  <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-3 dark:border-white/10">
                    <span className="flex size-8 items-center justify-center rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                      <UserRound className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">{g.name}</p>
                      <p className="text-xs text-muted-foreground">{g.sub}</p>
                    </div>
                    <div className="grid grid-cols-3 gap-4 text-right text-sm">
                      <Mini label="Total" value={money(g.totalMinor)} />
                      <Mini label="Paid" value={money(g.paidMinor)} />
                      <Mini
                        label="Due"
                        value={money(g.outstandingMinor)}
                        strong={g.outstandingMinor > 0}
                      />
                    </div>
                    {d.canTakePayment && g.outstandingMinor > 0 && d.session.status === 'open' ? (
                      <button
                        type="button"
                        className={cn(
                          btn,
                          'border-emerald-600 text-emerald-700 dark:text-emerald-300',
                        )}
                        onClick={() => setPay({ ...g.scope, dueMinor: g.outstandingMinor })}
                      >
                        Take payment
                      </button>
                    ) : null}
                  </div>
                  <ul className="divide-y divide-slate-100 text-sm dark:divide-white/5">
                    {g.orders.length === 0 ? (
                      <li className="px-4 py-3 text-muted-foreground">No orders yet.</li>
                    ) : null}
                    {g.orders.map((o) => (
                      <li
                        key={o.id}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"
                      >
                        <span className="font-medium tabular-nums">#{o.orderNumber}</span>
                        <span className="text-muted-foreground">
                          {time.format(new Date(o.createdAt))}
                        </span>
                        <span className="text-muted-foreground">{o.itemCount} items</span>
                        <span
                          className={cn(
                            'rounded px-1.5 py-0.5 text-xs font-medium',
                            KITCHEN[o.kitchenStatus][1],
                          )}
                        >
                          {KITCHEN[o.kitchenStatus][0]}
                        </span>
                        <span className="ml-auto flex items-center gap-2">
                          {o.status === 'completed' ? (
                            <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                              Paid
                            </span>
                          ) : o.status === 'cancelled' ? (
                            <span className="text-xs font-medium text-red-600">Cancelled</span>
                          ) : o.paidMinor > 0 ? (
                            <span className="text-xs text-amber-700">{money(o.dueMinor)} due</span>
                          ) : null}
                          <span
                            className={cn(
                              'font-semibold tabular-nums',
                              o.status === 'cancelled' && 'line-through opacity-60',
                            )}
                          >
                            {money(o.totalMinor)}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  {g.payments.length > 0 ? (
                    <div className="border-t border-slate-200 bg-slate-50 px-4 py-2.5 text-xs dark:border-white/10 dark:bg-white/5">
                      <p className="mb-1 flex items-center gap-1 font-medium text-muted-foreground">
                        <Receipt className="size-3.5" /> Billing history
                      </p>
                      <ul className="space-y-0.5">
                        {g.payments.map((p) => (
                          <li key={p.id} className="flex justify-between gap-3">
                            <span>
                              {dateTime.format(new Date(p.createdAt))} · {p.method.toUpperCase()} ·
                              order #{g.orders.find((o) => o.id === p.orderId)?.orderNumber}
                            </span>
                            <span className="tabular-nums">
                              {money(p.amountMinor)}
                              {p.refundedMinor ? (
                                <span className="text-red-600"> (−{money(p.refundedMinor)})</span>
                              ) : null}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </section>
              ))}
            </>
          ) : null}
        </div>

        {d && d.session.status === 'open' ? (
          <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-white/10">
            {d.canTakePayment && d.totals.outstandingMinor > 0 ? (
              <button
                type="button"
                className={btn}
                onClick={() =>
                  setPay({ label: 'Whole table', dueMinor: d.totals.outstandingMinor })
                }
              >
                Pay whole table ({money(d.totals.outstandingMinor)})
              </button>
            ) : null}
            <button
              type="button"
              className={cn(
                btn,
                'bg-slate-900 text-white hover:bg-slate-800 dark:bg-white dark:text-slate-900',
              )}
              disabled={d.totals.outstandingMinor > 0}
              title={d.totals.outstandingMinor > 0 ? 'Settle every bill first' : undefined}
              onClick={close}
            >
              Close table
            </button>
          </div>
        ) : null}
      </div>

      {pay && d ? (
        <PayDialog
          scope={pay}
          money={money}
          onClose={() => setPay(null)}
          onPay={async (method, amountMinor) => {
            await client.request(`/table-sessions/${d.session.id}/payments`, {
              method: 'POST',
              body: {
                method,
                amountMinor,
                ...(pay.guestId ? { guestId: pay.guestId } : {}),
                ...(pay.unassigned ? { unassigned: true } : {}),
              },
            });
            notify.success(`Payment recorded for ${pay.label}`);
            await refresh();
          }}
        />
      ) : null}
    </Dialog>
  );
}

function PayDialog({
  scope,
  money,
  onClose,
  onPay,
}: {
  scope: PayScope;
  money: (m: number) => string;
  onClose: () => void;
  onPay: (method: 'cash' | 'card' | 'upi', amountMinor: number) => Promise<void>;
}) {
  const [method, setMethod] = useState<'cash' | 'card' | 'upi'>('cash');
  const [amount, setAmount] = useState(String(scope.dueMinor / 100));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onPay(method, Math.round(Number(amount) * 100));
      onClose();
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      size="sm"
      label={`Payment for ${scope.label}`}
    >
      <form onSubmit={submit} className="space-y-4 p-5">
        <div>
          <h3 className="text-base font-semibold">Payment · {scope.label}</h3>
          <p className="text-sm text-muted-foreground">
            {money(scope.dueMinor)} due. Applied to the oldest open orders first.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {(['cash', 'card', 'upi'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={method === m}
              onClick={() => setMethod(m)}
              className={cn(
                'h-9 rounded-md text-sm font-medium uppercase ring-1 ring-inset',
                method === m
                  ? 'bg-emerald-600 text-white ring-emerald-600'
                  : 'ring-slate-200 dark:ring-white/10',
              )}
            >
              {m}
            </button>
          ))}
        </div>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Amount (₹)</span>
          <input
            type="number"
            min="0.01"
            step="0.01"
            max={scope.dueMinor / 100}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="h-9 w-full rounded-md border border-slate-200 bg-white px-2.5 text-sm dark:border-white/10 dark:bg-white/5"
          />
        </label>
        {error ? <p className="rounded-md bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className={btn}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !(Number(amount) > 0)}
            className={cn(btn, 'border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700')}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null} Record payment
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function Total({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-white/10">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('text-lg font-semibold tabular-nums', tone)}>{value}</p>
    </div>
  );
}

function Mini({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <p className="text-[11px] text-muted-foreground uppercase">{label}</p>
      <p
        className={cn('tabular-nums', strong && 'font-semibold text-amber-700 dark:text-amber-400')}
      >
        {value}
      </p>
    </div>
  );
}
