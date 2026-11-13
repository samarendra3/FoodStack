'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Loader2, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { hasPermissionAnywhere } from '@/lib/auth/access';
import { authErrorMessage } from '@/lib/auth/errors';
import type { Order } from '@/lib/orders';
import { CHANNEL_LABEL, STATUS_STYLE } from './order-labels';
import { OrderTimeline } from './order-timeline';

type Detail = Order & {
  refunds: {
    id: string;
    paymentId: string;
    amountMinor: number;
    reason: string;
    createdAt: string;
  }[];
};

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Bill view for one order with manager actions: cancel an unpaid order and refund payments.
 * Buttons show only for users holding the permission; the server checks again per branch.
 */
export function OrderDetail({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { client } = useAuth();
  const profile = useProfile();
  const order = useQuery({
    queryKey: ['order', id],
    queryFn: () => client.request<Detail>(`/orders/${id}`),
  });
  const [mode, setMode] = useState<
    { kind: 'cancel' } | { kind: 'refund'; paymentId: string; max: number } | null
  >(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const canVoid = hasPermissionAnywhere(profile, 'order:void');
  const canRefund = hasPermissionAnywhere(profile, 'order:refund');

  const act = useMutation({
    mutationFn: async () => {
      if (mode?.kind === 'cancel') {
        return client.request<Detail>(`/orders/${id}/cancel`, { method: 'POST', body: { reason } });
      }
      if (mode?.kind === 'refund') {
        return client.request<Detail>(`/payments/${mode.paymentId}/refunds`, {
          method: 'POST',
          body: { amountMinor: Math.round(Number(amount) * 100), reason },
        });
      }
      return undefined;
    },
    onSuccess: async () => {
      setMode(null);
      setReason('');
      setAmount('');
      await order.refetch();
      onChanged();
    },
    onError: (e) => setError(authErrorMessage(e)),
  });

  const o = order.data;
  const fmt = (m: number) =>
    o
      ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: o.currencyCode }).format(
          m / 100,
        )
      : '';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!reason.trim()) return setError('Enter a reason.');
    if (mode?.kind === 'refund') {
      const minor = Math.round(Number(amount) * 100);
      if (!(minor > 0) || minor > mode.max) return setError(`Enter up to ${fmt(mode.max)}.`);
    }
    act.mutate();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="Order details"
    >
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-950/40"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-lg flex-col overflow-y-auto bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold">{o ? `Order #${o.orderNumber}` : 'Order'}</h2>
            {o ? (
              <p className="text-xs text-muted-foreground">
                {when.format(new Date(o.createdAt))} · {CHANNEL_LABEL[o.channel]}
                {o.tableLabel ? ` · Table ${o.tableLabel}` : ''}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
          >
            <X className="size-4" />
          </button>
        </div>

        {order.isError ? (
          <p role="alert" className="m-5 rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {authErrorMessage(order.error)}
          </p>
        ) : !o ? (
          <div className="space-y-3 p-5">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : (
          <div className="flex-1 space-y-5 p-5">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize',
                  STATUS_STYLE[o.status],
                )}
              >
                {o.status}
              </span>
              <span className="text-xs text-muted-foreground">Kitchen: {o.kitchenStatus}</span>
              {o.customer ? (
                <span className="ml-auto text-sm">
                  {o.customer.name ? `${o.customer.name} · ` : ''}
                  {o.customer.phone}
                </span>
              ) : null}
            </div>

            <ul className="divide-y rounded-xl border">
              {o.items.map((i) => (
                <li
                  key={i.id}
                  className={cn(
                    'flex items-start gap-3 px-3 py-2.5 text-sm',
                    i.status === 'void' && 'text-muted-foreground line-through',
                  )}
                >
                  <span className="w-6 tabular-nums">{i.quantity}×</span>
                  <span className="flex-1">
                    {i.name}
                    {i.variantName ? (
                      <span className="text-muted-foreground"> ({i.variantName})</span>
                    ) : null}
                    {i.addons?.length ? (
                      <span className="block text-xs text-muted-foreground">
                        + {i.addons.map((a) => a.name).join(', ')}
                      </span>
                    ) : null}
                    {i.note ? <span className="block text-xs text-amber-700">{i.note}</span> : null}
                  </span>
                  <span className="tabular-nums">{fmt(i.lineTotalMinor)}</span>
                </li>
              ))}
            </ul>

            <dl className="space-y-1.5 text-sm">
              <Row k="Subtotal" v={fmt(o.subtotalMinor)} />
              {o.discounts.map((d) => (
                <Row key={d.promotionId} k={d.name} v={`− ${fmt(d.discountMinor)}`} green />
              ))}
              <Row k={`Tax (${o.taxRateBp / 100}%)`} v={fmt(o.taxMinor)} />
              <div className="flex justify-between border-t pt-2 text-base font-semibold">
                <dt>Total</dt>
                <dd className="tabular-nums">{fmt(o.totalMinor)}</dd>
              </div>
              {o.dueMinor > 0 ? <Row k="Due" v={fmt(o.dueMinor)} /> : null}
              {o.paymentPreference ? (
                <Row
                  k="Guest will pay"
                  v={
                    {
                      counter_cash: 'Cash at counter',
                      counter_card: 'Card at counter',
                      online: 'Online',
                    }[o.paymentPreference]
                  }
                />
              ) : null}
            </dl>

            <OrderTimeline orderId={id} fmt={fmt} />

            <section>
              <h3 className="mb-2 text-sm font-semibold">Payments</h3>
              {o.payments.length === 0 ? (
                <p className="text-sm text-muted-foreground">No payments yet.</p>
              ) : (
                <ul className="divide-y rounded-xl border">
                  {o.payments.map((p) => {
                    const refundable = p.amountMinor - p.refundedMinor;
                    return (
                      <li key={p.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                        <span className="w-12 font-medium uppercase">{p.method}</span>
                        <span className="flex-1 text-xs text-muted-foreground">
                          {when.format(new Date(p.createdAt))}
                        </span>
                        <span className="text-right tabular-nums">
                          {fmt(p.amountMinor)}
                          {p.refundedMinor ? (
                            <span className="block text-xs text-red-600">
                              −{fmt(p.refundedMinor)}
                            </span>
                          ) : null}
                        </span>
                        {canRefund && refundable > 0 ? (
                          <button
                            type="button"
                            onClick={() => {
                              setMode({ kind: 'refund', paymentId: p.id, max: refundable });
                              setAmount((refundable / 100).toFixed(2));
                              setError(null);
                            }}
                            className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                          >
                            Refund
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
              {o.refunds.length ? (
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {o.refunds.map((r) => (
                    <li key={r.id}>
                      Refunded {fmt(r.amountMinor)} · {r.reason} ·{' '}
                      {when.format(new Date(r.createdAt))}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>

            {canVoid && o.status === 'open' && o.paidMinor - o.refundedMinor === 0 && !mode ? (
              <button
                type="button"
                onClick={() => setMode({ kind: 'cancel' })}
                className="text-sm font-medium text-red-600 hover:underline"
              >
                Cancel this order
              </button>
            ) : null}

            {mode ? (
              <form onSubmit={submit} className="space-y-3 rounded-xl border p-4">
                <p className="text-sm font-semibold">
                  {mode.kind === 'cancel' ? 'Cancel order' : 'Refund payment'}
                </p>
                {mode.kind === 'refund' ? (
                  <input
                    inputMode="decimal"
                    aria-label="Refund amount"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
                    className="h-10 w-full rounded-lg border bg-background px-3 tabular-nums"
                  />
                ) : null}
                <input
                  aria-label="Reason"
                  value={reason}
                  maxLength={200}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason (required)"
                  className="h-10 w-full rounded-lg border bg-background px-3 text-sm"
                />
                {error ? (
                  <p role="alert" className="text-sm text-red-600">
                    {error}
                  </p>
                ) : null}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setMode(null)}
                    className="h-9 rounded-lg px-3 text-sm hover:bg-muted"
                  >
                    Back
                  </button>
                  <button
                    type="submit"
                    disabled={act.isPending}
                    className="flex h-9 items-center gap-1.5 rounded-lg bg-red-600 px-3 text-sm font-semibold text-white disabled:opacity-60"
                  >
                    {act.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                    {mode.kind === 'cancel' ? 'Cancel order' : 'Refund'}
                  </button>
                </div>
              </form>
            ) : null}
          </div>
        )}
      </aside>
    </div>
  );
}

function Row({ k, v, green }: { k: string; v: string; green?: boolean }) {
  return (
    <div
      className={cn(
        'flex justify-between',
        green ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground',
      )}
    >
      <dt>{k}</dt>
      <dd className="tabular-nums">{v}</dd>
    </div>
  );
}
