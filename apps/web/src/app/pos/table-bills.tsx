'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Banknote,
  CheckCircle2,
  CreditCard,
  Loader2,
  Printer,
  QrCode,
  Receipt,
  X,
} from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { authErrorMessage } from '@/lib/auth/errors';
import { type Order, type PaymentMethod, useOrderMutations } from '@/lib/orders';
import { printReceipt, type ReceiptInput, useReceiptHeader } from '@/lib/receipt';
import { type DiningTable, useTables } from '@/lib/tables';

const METHODS: { id: PaymentMethod; label: string; icon: typeof Banknote }[] = [
  { id: 'cash', label: 'Cash', icon: Banknote },
  { id: 'card', label: 'Card', icon: CreditCard },
  { id: 'upi', label: 'UPI', icon: QrCode },
];

const money = (minor: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(minor / 100);

const muted = 'text-slate-500 dark:text-slate-400';

/** Open dine-in orders at a table, with their items (the list endpoint has no table filter). */
function useTableOrders(branchId: string, label: string | null) {
  const { client } = useAuth();
  const profile = useProfile();
  return useQuery({
    queryKey: ['orders', profile.activeTenant?.id, 'table', branchId, label?.toLowerCase()],
    queryFn: async () => {
      const q = new URLSearchParams({ branchId, status: 'open', limit: '100' });
      const rows = await client.request<{ id: string; tableLabel: string | null }[]>(
        `/orders?${q}`,
      );
      const mine = rows.filter((o) => o.tableLabel?.toLowerCase() === label!.toLowerCase());
      return Promise.all(mine.map((o) => client.request<Order>(`/orders/${o.id}`)));
    },
    enabled: Boolean(label),
  });
}

/** POS button + dialog: bill and settle tables served by waiters (or earlier POS orders). */
export function TableBillsButton({ branchId }: { branchId: string }) {
  const tables = useTables(branchId || undefined);
  const [open, setOpen] = useState(false);
  const busy = (tables.data?.tables ?? []).filter((t) => t.status === 'occupied');
  if (!tables.data?.tables.length) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-white/5"
      >
        <Receipt className="size-4" aria-hidden />
        Table bills
        {busy.length ? (
          <span className="rounded bg-amber-100 px-1.5 text-xs leading-5 font-semibold text-amber-800 tabular-nums dark:bg-amber-500/20 dark:text-amber-300">
            {busy.length}
          </span>
        ) : null}
      </button>
      {open ? (
        <TableBillsDialog branchId={branchId} tables={busy} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function TableBillsDialog({
  branchId,
  tables,
  onClose,
}: {
  branchId: string;
  tables: DiningTable[];
  onClose: () => void;
}) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Table bills"
        className="relative flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-xl border border-slate-200 bg-white sm:rounded-xl dark:border-white/10 dark:bg-slate-900"
      >
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-white/10">
          {label ? (
            <button
              type="button"
              onClick={() => setLabel(null)}
              aria-label="Back to tables"
              className="flex size-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-white/10"
            >
              <ArrowLeft className="size-4" />
            </button>
          ) : null}
          <h2 className="text-sm font-semibold">{label ? `Table ${label}` : 'Table bills'}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto flex size-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-white/10"
          >
            <X className="size-4" />
          </button>
        </div>

        {label ? (
          <TableBill branchId={branchId} label={label} onDone={() => setLabel(null)} />
        ) : tables.length === 0 ? (
          <p className={cn('px-4 py-12 text-center text-sm', muted)}>
            No occupied tables. Bills appear here once a table has an order.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 overflow-y-auto dark:divide-white/5">
            {tables.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setLabel(t.label)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-white/5"
                >
                  <span className="flex size-10 items-center justify-center rounded-md border border-amber-300 text-sm font-semibold dark:border-amber-500/40">
                    {t.label}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{t.area}</span>
                    <span className={cn('block text-xs', muted)}>
                      {t.openOrders} order{t.openOrders > 1 ? 's' : ''}
                      {t.bills > 1 ? ` · ${t.bills} separate bills` : ''}
                    </span>
                  </span>
                  <span className="text-sm font-semibold tabular-nums">
                    {money(t.openTotalMinor)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TableBill({
  branchId,
  label,
  onDone,
}: {
  branchId: string;
  label: string;
  onDone: () => void;
}) {
  const profile = useProfile();
  const qc = useQueryClient();
  const orders = useTableOrders(branchId, label);
  const { pay } = useOrderMutations();
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [settled, setSettled] = useState<{
    bill: string;
    total: number;
    change: number | null;
    more: boolean;
    receipt: ReceiptInput;
  } | null>(null);
  const header = useReceiptHeader(branchId);
  const [bill, setBill] = useState<string | null>(null);

  // Separate bills at this table; orders without a bill belong to bill A.
  const all = orders.data ?? [];
  const bills = [...new Set(all.map((o) => o.billLabel ?? 'A'))].sort();
  const selected = bill && bills.includes(bill) ? bill : (bills[0] ?? 'A');
  const list = all.filter((o) => (o.billLabel ?? 'A') === selected);
  const billName = bills.length > 1 ? `Table ${label} · Bill ${selected}` : `Table ${label}`;
  const items = list.flatMap((o) => o.items.filter((i) => i.status === 'active'));
  const sum = (f: (o: Order) => number) => list.reduce((s, o) => s + f(o), 0);
  const subtotal = sum((o) => o.subtotalMinor);
  const discount = sum((o) => o.discountMinor);
  const tax = sum((o) => o.taxMinor);
  const total = sum((o) => o.totalMinor);
  const paid = sum((o) => o.paidMinor);
  const due = sum((o) => o.dueMinor);
  const taxRate = list[0] ? list[0].taxRateBp / 100 : 0;
  const tenderedMinor = Math.round(Number(tendered) * 100);
  const change = method === 'cash' && tendered ? tenderedMinor - due : null;

  const collect = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (change !== null && change < 0) return setError('Cash received is less than the bill.');
    setPaying(true);
    try {
      const billed = list; // what this payment covers, for the printed bill
      const tableText = bills.length > 1 ? `${label} · Bill ${selected}` : label;
      // One payment per order (the server settles orders individually).
      for (const o of billed) {
        if (o.dueMinor > 0) {
          await pay.mutateAsync({
            orderId: o.id,
            method,
            amountMinor: o.dueMinor,
            reference: reference.trim() || null,
          });
        }
      }
      const receipt: ReceiptInput = {
        header: header.data ?? null,
        fallbackName: profile.activeTenant?.name ?? 'Restaurant',
        orders: billed,
        tableText,
        cashier: profile.user.fullName,
        payment: {
          method,
          amountMinor: due,
          tenderedMinor: method === 'cash' && tendered ? tenderedMinor : null,
        },
      };
      printReceipt(receipt); // the customer bill prints as soon as payment is taken
      setSettled({ bill: billName, total: due, change, more: bills.length > 1, receipt });
      setTendered('');
      setReference('');
      await qc.invalidateQueries({ queryKey: ['tables', profile.activeTenant?.id] });
    } catch (err) {
      setError(authErrorMessage(err));
      void orders.refetch(); // some orders may already be paid
    } finally {
      setPaying(false);
    }
  };

  if (settled) {
    return (
      <div className="px-4 py-10 text-center">
        <CheckCircle2 className="mx-auto size-10 text-emerald-600" />
        <p className="mt-3 font-semibold">{settled.bill} settled</p>
        <p className={cn('mt-1 text-sm', muted)}>
          {money(settled.total)} collected by {method.toUpperCase()}.
          {settled.change ? ` Give back ${money(settled.change)}.` : ''}
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <button
            type="button"
            onClick={() => printReceipt(settled.receipt)}
            className="inline-flex h-10 items-center gap-1.5 rounded-md border border-slate-200 px-4 text-sm font-medium hover:bg-slate-50 dark:border-white/10 dark:hover:bg-white/5"
          >
            <Printer className="size-4" aria-hidden /> Reprint bill
          </button>
          <button
            type="button"
            onClick={() => {
              if (!settled.more) return onDone();
              setSettled(null);
              setBill(null);
              void orders.refetch();
            }}
            className="inline-flex h-10 items-center rounded-md bg-emerald-600 px-5 text-sm font-medium text-white hover:bg-emerald-700"
          >
            {settled.more ? 'Next bill' : 'Done'}
          </button>
        </div>
      </div>
    );
  }

  if (orders.isPending)
    return <Loader2 className="mx-auto my-12 size-5 animate-spin text-slate-400" />;
  if (orders.isError) {
    return <p className="p-4 text-sm text-red-600">{authErrorMessage(orders.error)}</p>;
  }
  if (list.length === 0) {
    return (
      <p className={cn('px-4 py-12 text-center text-sm', muted)}>
        This table has no open orders any more.
      </p>
    );
  }

  return (
    <form onSubmit={collect} className="flex min-h-0 flex-1 flex-col">
      {bills.length > 1 ? (
        <div className="flex gap-1.5 overflow-x-auto border-b border-slate-200 px-4 py-2.5 dark:border-white/10">
          {bills.map((b) => {
            const t = all
              .filter((o) => (o.billLabel ?? 'A') === b)
              .reduce((s, o) => s + o.dueMinor, 0);
            return (
              <button
                key={b}
                type="button"
                aria-pressed={selected === b}
                onClick={() => setBill(b)}
                className={cn(
                  'flex shrink-0 flex-col items-start rounded-md border px-3 py-1.5 text-left',
                  selected === b
                    ? 'border-slate-900 bg-slate-900 text-white dark:border-white dark:bg-white dark:text-slate-900'
                    : 'border-slate-200 hover:bg-slate-50 dark:border-white/10 dark:hover:bg-white/5',
                )}
              >
                <span className="text-xs opacity-75">Bill {b}</span>
                <span className="text-sm font-semibold tabular-nums">{money(t)}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <p className={cn('text-xs', muted)}>
          {list.length} order{list.length > 1 ? 's' : ''}:{' '}
          {list.map((o) => `#${o.orderNumber}`).join(', ')}
        </p>
        <ul className="mt-3 space-y-1.5 text-sm">
          {items.map((i) => (
            <li key={i.id} className="flex gap-2">
              <span className={cn('w-7 shrink-0 tabular-nums', muted)}>{i.quantity}×</span>
              <span className="min-w-0 flex-1 truncate">
                {i.name}
                {i.variantName ? <span className={muted}> · {i.variantName}</span> : null}
              </span>
              <span className="tabular-nums">{money(i.lineTotalMinor)}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-4 space-y-1 border-t border-slate-200 pt-3 text-sm dark:border-white/10">
          <Row k="Subtotal" v={money(subtotal)} />
          {discount ? <Row k="Discount" v={`− ${money(discount)}`} /> : null}
          <Row k={`Tax (${taxRate}%)`} v={money(tax)} />
          <div className="flex justify-between pt-1 text-base font-semibold">
            <dt>Total</dt>
            <dd className="tabular-nums">{money(total)}</dd>
          </div>
          {paid ? <Row k="Already paid" v={`− ${money(paid)}`} /> : null}
          {paid ? (
            <div className="flex justify-between font-semibold">
              <dt>Due</dt>
              <dd className="tabular-nums">{money(due)}</dd>
            </div>
          ) : null}
        </dl>
      </div>

      <div className="space-y-3 border-t border-slate-200 p-4 dark:border-white/10">
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Payment method">
          {METHODS.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={method === m.id}
              onClick={() => setMethod(m.id)}
              className={cn(
                'flex h-10 items-center justify-center gap-1.5 rounded-md border text-sm font-medium',
                method === m.id
                  ? 'border-emerald-600 bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300'
                  : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/5',
              )}
            >
              <m.icon className="size-4" aria-hidden /> {m.label}
            </button>
          ))}
        </div>
        {method === 'cash' ? (
          <label className="block text-sm">
            <span className={muted}>Cash received (optional)</span>
            <input
              inputMode="decimal"
              value={tendered}
              onChange={(e) => setTendered(e.target.value.replace(/[^\d.]/g, ''))}
              placeholder={(due / 100).toFixed(2)}
              className="mt-1 h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-base tabular-nums outline-none focus:border-emerald-600 focus:ring-4 focus:ring-emerald-600/15 sm:text-sm dark:border-white/10 dark:bg-white/5"
            />
            {change !== null && change >= 0 ? (
              <span className="mt-1 block text-sm font-medium">Change: {money(change)}</span>
            ) : null}
          </label>
        ) : (
          <label className="block text-sm">
            <span className={muted}>Reference (optional)</span>
            <input
              value={reference}
              maxLength={80}
              onChange={(e) => setReference(e.target.value)}
              placeholder={method === 'upi' ? 'UPI transaction ID' : 'Card slip number'}
              className="mt-1 h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-base outline-none focus:border-emerald-600 focus:ring-4 focus:ring-emerald-600/15 sm:text-sm dark:border-white/10 dark:bg-white/5"
            />
          </label>
        )}
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() =>
              printReceipt({
                header: header.data ?? null,
                fallbackName: profile.activeTenant?.name ?? 'Restaurant',
                orders: list,
                tableText: bills.length > 1 ? `${label} · Bill ${selected}` : label,
                cashier: profile.user.fullName,
                payment: null,
              })
            }
            className="inline-flex h-11 items-center gap-1.5 rounded-md border border-slate-200 px-4 text-sm font-medium hover:bg-slate-50 dark:border-white/10 dark:hover:bg-white/5"
          >
            <Printer className="size-4" aria-hidden /> Print bill
          </button>
          <button
            type="submit"
            disabled={paying || due <= 0}
            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-md bg-emerald-600 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
          >
            {paying ? <Loader2 className="size-4 animate-spin" /> : null}
            Collect {money(due)}
          </button>
        </div>
      </div>
    </form>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <dt className={muted}>{k}</dt>
      <dd className="tabular-nums">{v}</dd>
    </div>
  );
}
