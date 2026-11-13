'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { Banknote, CheckCircle2, ChefHat, CreditCard, Loader2, QrCode, X } from 'lucide-react';
import { motion } from 'motion/react';
import { type FormEvent, useRef, useState } from 'react';
import { authErrorMessage } from '@/lib/auth/errors';
import { useProfile } from '@/components/auth/auth-provider';
import { type Order, type PaymentMethod, useOrderMutations } from '@/lib/orders';
import { printReceipt, useReceiptHeader } from '@/lib/receipt';

const METHODS: { id: PaymentMethod; label: string; icon: typeof Banknote }[] = [
  { id: 'cash', label: 'Cash', icon: Banknote },
  { id: 'card', label: 'Card', icon: CreditCard },
  { id: 'upi', label: 'UPI', icon: QrCode },
];

const money = (minor: number, currency: string) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(minor / 100);

/**
 * Shown after an order is sent to the kitchen: confirmation plus payment. Several payments can
 * settle one bill (split between methods or guests); the server refuses anything above the due.
 */
export function PaymentDialog({
  order,
  defaultMethod,
  onClose,
}: {
  order: Order;
  defaultMethod: PaymentMethod | null;
  onClose: () => void;
}) {
  const { pay } = useOrderMutations();
  const profile = useProfile();
  const header = useReceiptHeader(order.branchId);
  const [current, setCurrent] = useState(order);
  const [method, setMethod] = useState<PaymentMethod>(defaultMethod ?? 'cash');
  const [amount, setAmount] = useState((order.dueMinor / 100).toFixed(2));
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  // One key per collection attempt (kept across retries, renewed after success).
  const requestKey = useRef(`pos-pay-${crypto.randomUUID()}`);
  const fmt = (m: number) => money(m, current.currencyCode);
  const amountMinor = Math.round(Number(amount) * 100);
  const tenderedMinor = Math.round(Number(tendered) * 100);
  const changeMinor = method === 'cash' && tendered ? tenderedMinor - amountMinor : null;
  const paid = current.status === 'completed';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!(amountMinor > 0) || amountMinor > current.dueMinor) {
      return setError(`Enter an amount up to ${fmt(current.dueMinor)}.`);
    }
    if (changeMinor !== null && changeMinor < 0)
      return setError('Cash received is less than the amount.');
    try {
      const next = await pay.mutateAsync({
        orderId: current.id,
        method,
        amountMinor,
        reference: reference.trim() || null,
        requestId: requestKey.current,
      });
      requestKey.current = `pos-pay-${crypto.randomUUID()}`;
      setCurrent(next);
      if (next.status === 'completed') {
        // Fully paid: print the customer bill straight away.
        printReceipt({
          header: header.data ?? null,
          fallbackName: profile.activeTenant?.name ?? 'Restaurant',
          orders: [next],
          tableText: next.tableLabel,
          cashier: profile.user.fullName,
          payment: {
            method,
            amountMinor: next.paidMinor,
            tenderedMinor: method === 'cash' && tendered ? tenderedMinor : null,
          },
        });
      }
      setAmount((next.dueMinor / 100).toFixed(2));
      setTendered('');
      setReference('');
    } catch (err) {
      setError(authErrorMessage(err));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Order ${current.orderNumber}`}
    >
      <motion.div
        className="absolute inset-0 bg-slate-950/50"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        onClick={onClose}
      />
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className="relative max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl dark:bg-slate-900"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-white/10"
        >
          <X className="size-4" />
        </button>

        <div className="flex items-center gap-3">
          <span
            className={cn(
              'flex size-11 items-center justify-center rounded-xl',
              paid
                ? 'bg-emerald-600 text-white'
                : 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15',
            )}
          >
            {paid ? <CheckCircle2 className="size-6" /> : <ChefHat className="size-6" />}
          </span>
          <div>
            <h2 className="text-lg font-bold">
              Order #{current.orderNumber} {paid ? 'paid' : 'sent to kitchen'}
            </h2>
            <p className="text-sm text-slate-500">
              {current.tableLabel ? `Table ${current.tableLabel} · ` : ''}
              {current.items
                .filter((i) => i.status === 'active')
                .reduce((n, i) => n + i.quantity, 0)}{' '}
              items
            </p>
          </div>
        </div>

        <dl className="mt-5 space-y-1.5 rounded-xl bg-slate-50 p-4 text-sm dark:bg-white/5">
          <Row k="Subtotal" v={fmt(current.subtotalMinor)} />
          {current.discounts.map((d) => (
            <Row key={d.promotionId} k={d.name} v={`− ${fmt(d.discountMinor)}`} green />
          ))}
          <Row k={`Tax (${current.taxRateBp / 100}%)`} v={fmt(current.taxMinor)} />
          <div className="flex justify-between border-t border-dashed border-slate-200 pt-2 text-base font-bold dark:border-white/10">
            <dt>Total</dt>
            <dd className="tabular-nums">{fmt(current.totalMinor)}</dd>
          </div>
          {current.payments.map((p) => (
            <Row key={p.id} k={`Paid · ${p.method.toUpperCase()}`} v={fmt(p.amountMinor)} />
          ))}
          {!paid ? (
            <div className="flex justify-between pt-1 font-semibold text-amber-700 dark:text-amber-300">
              <dt>Due</dt>
              <dd className="tabular-nums">{fmt(current.dueMinor)}</dd>
            </div>
          ) : null}
        </dl>

        {paid ? (
          <button
            type="button"
            onClick={onClose}
            className="mt-5 h-12 w-full rounded-xl bg-emerald-600 font-semibold text-white hover:bg-emerald-700"
          >
            New order
          </button>
        ) : (
          <form onSubmit={submit} noValidate className="mt-5 space-y-4">
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Payment method">
              {METHODS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={method === id}
                  onClick={() => setMethod(id)}
                  className={cn(
                    'flex h-14 flex-col items-center justify-center gap-1 rounded-xl border text-xs font-semibold',
                    method === id
                      ? 'border-emerald-600 bg-emerald-50 text-emerald-700 ring-2 ring-emerald-600/15 dark:bg-emerald-500/15 dark:text-emerald-300'
                      : 'border-slate-200 hover:bg-slate-50 dark:border-white/10 dark:hover:bg-white/5',
                  )}
                >
                  <Icon className="size-5" /> {label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1.5 text-sm">
                <span className="font-medium">Amount</span>
                <input
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
                  className="h-11 w-full rounded-lg border border-slate-200 bg-transparent px-3 text-lg font-semibold tabular-nums outline-none focus:border-emerald-500 dark:border-white/10"
                />
              </label>
              {method === 'cash' ? (
                <label className="space-y-1.5 text-sm">
                  <span className="font-medium">Cash received</span>
                  <input
                    inputMode="decimal"
                    value={tendered}
                    onChange={(e) => setTendered(e.target.value.replace(/[^\d.]/g, ''))}
                    placeholder="Optional"
                    className="h-11 w-full rounded-lg border border-slate-200 bg-transparent px-3 text-lg tabular-nums outline-none focus:border-emerald-500 dark:border-white/10"
                  />
                </label>
              ) : (
                <label className="space-y-1.5 text-sm">
                  <span className="font-medium">Reference</span>
                  <input
                    value={reference}
                    maxLength={80}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder={method === 'upi' ? 'UPI ref (optional)' : 'Last 4 / slip no.'}
                    className="h-11 w-full rounded-lg border border-slate-200 bg-transparent px-3 outline-none focus:border-emerald-500 dark:border-white/10"
                  />
                </label>
              )}
            </div>
            {changeMinor !== null && changeMinor >= 0 ? (
              <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                Change to return: {fmt(changeMinor)}
              </p>
            ) : null}
            <p className="text-xs text-slate-500">
              To split the bill, enter part of the amount, take it, then take the rest.
            </p>
            {error ? (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            ) : null}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="h-12 flex-1 rounded-xl border border-slate-200 font-semibold hover:bg-slate-50 dark:border-white/10 dark:hover:bg-white/5"
              >
                Pay later
              </button>
              <button
                type="submit"
                disabled={pay.isPending}
                className="flex h-12 flex-[2] items-center justify-center gap-2 rounded-xl bg-emerald-600 font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
              >
                {pay.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                Take {amountMinor > 0 ? fmt(amountMinor) : 'payment'}
              </button>
            </div>
          </form>
        )}
      </motion.div>
    </div>
  );
}

function Row({ k, v, green }: { k: string; v: string; green?: boolean }) {
  return (
    <div
      className={cn(
        'flex justify-between',
        green ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-600 dark:text-slate-300',
      )}
    >
      <dt className="truncate">{k}</dt>
      <dd className="tabular-nums">{v}</dd>
    </div>
  );
}
