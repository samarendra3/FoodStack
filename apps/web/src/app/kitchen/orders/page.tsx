'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CARD, KitchenFrame, STATUS_BADGE, STATUS_LABEL, minutesSince } from '../kitchen-frame';
import {
  type KitchenFeed,
  type KitchenTicket,
  NEXT_STATUS,
  type TicketStatus,
} from '../kitchen-feed';
import { KitchenError, TicketSkeletons } from '../kitchen-overview';

type Filter = 'all' | 'active' | TicketStatus;
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'new', label: 'New' },
  { id: 'preparing', label: 'Preparing' },
  { id: 'ready', label: 'Ready' },
  { id: 'completed', label: 'Completed' },
];

export default function KitchenOrdersPage() {
  return <KitchenFrame title="Orders">{({ feed }) => <Orders feed={feed} />}</KitchenFrame>;
}

function Orders({ feed }: { feed: KitchenFeed }) {
  const [filter, setFilter] = useState<Filter>('active');
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return feed.tickets
      .filter((t) =>
        filter === 'all'
          ? true
          : filter === 'active'
            ? t.status !== 'completed'
            : filter === 'preparing'
              ? t.status === 'preparing' || t.status === 'accepted'
              : t.status === filter,
      )
      .filter(
        (t) =>
          !q ||
          t.orderNumber.toLowerCase().includes(q) ||
          t.tableLabel?.toLowerCase().includes(q) ||
          t.customerName?.toLowerCase().includes(q) ||
          t.items.some((i) => i.name.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [feed.tickets, filter, query]);

  const count = (f: Filter) =>
    f === 'all'
      ? feed.tickets.length
      : f === 'active'
        ? feed.tickets.filter((t) => t.status !== 'completed').length
        : f === 'preparing'
          ? feed.tickets.filter((t) => t.status === 'preparing' || t.status === 'accepted').length
          : feed.tickets.filter((t) => t.status === f).length;

  return (
    <div className="mx-auto max-w-[110rem] space-y-4 p-4 sm:p-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        {/* Phones: one scrollable row of chips; wider screens: wrap. */}
        <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              aria-pressed={filter === f.id}
              className={cn(
                'shrink-0 rounded-full px-3 py-1.5 text-sm font-medium whitespace-nowrap ring-1 ring-inset',
                filter === f.id
                  ? 'bg-emerald-600 text-white ring-emerald-600'
                  : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:ring-white/10',
              )}
            >
              {f.label} <span className="opacity-70">{count(f.id)}</span>
            </button>
          ))}
        </div>
        <label className="relative w-full lg:w-72">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
          <span className="sr-only">Search orders</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Order, table, customer, item…"
            className="h-9 w-full rounded-md border border-slate-200 bg-white pr-3 pl-9 text-sm dark:border-white/10 dark:bg-slate-900 dark:text-white"
          />
        </label>
      </div>

      {feed.error ? <KitchenError message={feed.error} /> : null}
      {feed.isLoading ? (
        <TicketSkeletons />
      ) : rows.length === 0 ? (
        <div className={cn(CARD, 'p-10 text-center text-sm text-slate-500 dark:text-slate-400')}>
          No orders match. The list covers open orders and those served in the last 12 hours.
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((t) => (
            <OrderRow key={t.id} ticket={t} feed={feed} />
          ))}
        </ul>
      )}
    </div>
  );
}

function OrderRow({ ticket: t, feed }: { ticket: KitchenTicket; feed: KitchenFeed }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = NEXT_STATUS[t.status];
  const itemCount = t.items.reduce((n, i) => n + i.qty, 0);

  const advance = async () => {
    if (!next || !feed.advance) return;
    setBusy(true);
    setError(null);
    try {
      await feed.advance(t.id, next.to);
    } catch {
      setError('Could not update. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={CARD}>
      <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:p-4">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-left"
        >
          <span className="font-semibold text-slate-900 tabular-nums dark:text-white">
            #{t.orderNumber}
          </span>
          <span
            className={cn(
              'rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
              STATUS_BADGE[t.status],
            )}
          >
            {STATUS_LABEL[t.status]}
          </span>
          <span className="w-full text-sm text-slate-500 sm:w-auto sm:min-w-0 sm:flex-1 sm:truncate dark:text-slate-400">
            {t.orderType === 'dine-in'
              ? `Table ${t.tableLabel ?? '—'}${t.billLabel ? ` · ${t.billLabel}` : ''}`
              : t.orderType === 'takeaway'
                ? 'Takeaway'
                : 'Delivery'}
            {t.customerName ? ` · ${t.customerName}` : ''} · {itemCount} item
            {itemCount === 1 ? '' : 's'}
          </span>
        </button>
        <div className="flex items-center justify-between gap-3 sm:justify-end">
          <span className="text-xs whitespace-nowrap text-slate-500 tabular-nums dark:text-slate-400">
            {new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {t.status !== 'completed' ? ` · ${minutesSince(t.createdAt)} min` : ''}
          </span>
          {next && feed.advance ? (
            <button
              type="button"
              disabled={busy}
              onClick={advance}
              className="h-10 shrink-0 rounded-md bg-emerald-600 px-4 text-sm font-medium whitespace-nowrap text-white hover:bg-emerald-700 disabled:opacity-60 sm:h-8 sm:px-3"
            >
              {busy ? 'Saving…' : next.label}
            </button>
          ) : null}
        </div>
      </div>
      {error ? <p className="px-4 pb-3 text-sm text-red-600">{error}</p> : null}
      {open ? (
        <div className="border-t border-slate-200 px-4 py-3 text-sm dark:border-white/10">
          <ul className="space-y-1">
            {t.items.map((i) => (
              <li key={i.id} className="text-slate-700 dark:text-slate-200">
                <span className="font-medium tabular-nums">{i.qty}×</span> {i.name}
                {i.note ? (
                  <span className="text-amber-700 dark:text-amber-300"> — {i.note}</span>
                ) : null}
              </li>
            ))}
          </ul>
          {t.note ? (
            <p className="mt-2 text-amber-700 dark:text-amber-300">Note: {t.note}</p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
