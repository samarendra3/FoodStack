'use client';

import { cn } from '@foodstack/ui/lib/utils';
import {
  AlertTriangle,
  Bike,
  CheckCircle2,
  Clock,
  Flame,
  Loader2,
  MessageSquareText,
  Search,
  ShoppingBag,
  User,
  UtensilsCrossed,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import {
  type KitchenFeed,
  type KitchenTicket,
  NEXT_STATUS,
  type TicketOrderType,
  type TicketStatus,
} from './kitchen-feed';

const FILTERS: { id: 'all' | TicketStatus; label: string }[] = [
  { id: 'all', label: 'All Orders' },
  { id: 'new', label: 'New' },
  { id: 'preparing', label: 'Preparing' },
  { id: 'ready', label: 'Ready' },
  { id: 'completed', label: 'Completed' },
];

const TYPE_META: Record<TicketOrderType, { label: string; icon: typeof Bike }> = {
  'dine-in': { label: 'Dine-in', icon: UtensilsCrossed },
  takeaway: { label: 'Takeaway', icon: ShoppingBag },
  delivery: { label: 'Delivery', icon: Bike },
};

const STATUS_META: Record<TicketStatus, { label: string; bar: string; chip: string }> = {
  new: {
    label: 'New order',
    bar: 'bg-sky-500',
    chip: 'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  },
  accepted: {
    label: 'Accepted',
    bar: 'bg-violet-500',
    chip: 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  },
  preparing: {
    label: 'Preparing',
    bar: 'bg-amber-500',
    chip: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  },
  ready: {
    label: 'Ready',
    bar: 'bg-emerald-500',
    chip: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  },
  completed: {
    label: 'Completed',
    bar: 'bg-slate-300',
    chip: 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300',
  },
};

/** Ticket filters + grid. Rendered only when the feed has tickets. */
export function TicketBoard({ feed }: { feed: KitchenFeed }) {
  const [filter, setFilter] = useState<'all' | TicketStatus>('all');
  const [type, setType] = useState<'all' | TicketOrderType>('all');
  const [query, setQuery] = useState('');
  const now = useNow();

  const q = query.trim().toLowerCase();
  const inScope = feed.tickets.filter(
    (t) =>
      (type === 'all' || t.orderType === type) && (!q || t.orderNumber.toLowerCase().includes(q)),
  );
  const matches = (t: KitchenTicket, f: typeof filter) =>
    f === 'all'
      ? t.status !== 'completed'
      : f === 'new'
        ? t.status === 'new' || t.status === 'accepted'
        : t.status === f;
  const visible = inScope
    .filter((t) => matches(t, filter))
    .sort((a, b) => (a.priority === b.priority ? 0 : a.priority === 'rush' ? -1 : 1));

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-3 lg:flex-row lg:items-center dark:border-white/10 dark:bg-slate-900">
        <div
          className="-mx-1 flex gap-1.5 overflow-x-auto px-1 [scrollbar-width:none]"
          role="tablist"
        >
          {FILTERS.map((f) => {
            const n = inScope.filter((t) => matches(t, f.id)).length;
            const on = filter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setFilter(f.id)}
                className={cn(
                  'flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors',
                  on
                    ? 'bg-emerald-600 text-white shadow-sm'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/10',
                )}
              >
                {f.label}
                <span
                  className={cn(
                    'rounded-md px-1.5 text-xs tabular-nums',
                    on ? 'bg-white/20' : 'bg-slate-100 dark:bg-white/10',
                  )}
                >
                  {n}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex gap-2 lg:ml-auto">
          <label className="relative flex-1 lg:w-56 lg:flex-none">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <span className="sr-only">Search order number</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Order #"
              className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pr-3 pl-9 text-sm outline-none focus-visible:border-emerald-500 focus-visible:ring-4 focus-visible:ring-emerald-500/10 dark:border-white/10 dark:bg-white/5"
            />
          </label>
          <label>
            <span className="sr-only">Order type</span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as typeof type)}
              className="h-9 rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-sm dark:border-white/10 dark:bg-white/5"
            >
              <option value="all">All types</option>
              <option value="dine-in">Dine-in</option>
              <option value="takeaway">Takeaway</option>
              <option value="delivery">Delivery</option>
            </select>
          </label>
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-200 bg-white py-16 text-center text-sm text-slate-500 dark:border-white/10 dark:bg-slate-900">
          No orders match these filters.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          <AnimatePresence initial={false}>
            {visible.map((t) => (
              <TicketCard key={t.id} ticket={t} now={now} onAdvance={feed.advance} />
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

function TicketCard({
  ticket: t,
  now,
  onAdvance,
}: {
  ticket: KitchenTicket;
  now: number;
  onAdvance?: KitchenFeed['advance'];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const minutes = Math.max(0, Math.floor((now - Date.parse(t.createdAt)) / 60000));
  const late = t.status !== 'completed' && minutes >= 20;
  const warn = t.status !== 'completed' && minutes >= 12;
  const next = NEXT_STATUS[t.status];
  const status = STATUS_META[t.status];
  const Type = TYPE_META[t.orderType].icon;

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.25 }}
      className={cn(
        'relative flex flex-col overflow-hidden rounded-2xl border bg-white shadow-xs dark:bg-slate-900',
        late ? 'border-red-300 dark:border-red-500/40' : 'border-slate-200 dark:border-white/10',
      )}
      aria-label={`Order ${t.orderNumber}, ${status.label}`}
    >
      <span className={cn('h-1 w-full', status.bar)} aria-hidden />
      <header className="flex items-start justify-between gap-2 px-4 pt-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-bold text-slate-900 dark:text-white">#{t.orderNumber}</h3>
            {t.priority === 'rush' ? (
              <span className="flex items-center gap-1 rounded-md bg-red-600 px-1.5 py-0.5 text-[11px] font-bold text-white">
                <Flame className="size-3" /> RUSH
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
            <span className="flex items-center gap-1">
              <Type className="size-3.5" />
              {TYPE_META[t.orderType].label}
              {t.tableLabel ? ` · Table ${t.tableLabel}` : ''}
            </span>
            <span>
              {new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </p>
        </div>
        <div className="text-right">
          <span
            className={cn(
              'flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-bold tabular-nums',
              late
                ? 'bg-red-50 text-red-700 dark:bg-red-500/15'
                : warn
                  ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/15'
                  : 'bg-slate-100 text-slate-700 dark:bg-white/10 dark:text-slate-200',
            )}
            title="Time since order"
          >
            <Clock className="size-3.5" />
            {minutes}m
          </span>
          <span
            className={cn(
              'mt-1 inline-block rounded-md px-1.5 py-0.5 text-[11px] font-semibold',
              status.chip,
            )}
          >
            {status.label}
          </span>
        </div>
      </header>

      {t.customerName ? (
        <p className="mx-4 mt-2 flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
          <User className="size-3.5" />
          {t.customerName}
        </p>
      ) : null}

      <ul className="mx-4 mt-3 flex-1 space-y-2 border-t border-dashed border-slate-200 pt-3 dark:border-white/10">
        {t.items.map((i) => (
          <li key={i.id} className="text-sm">
            <div className="flex gap-2.5">
              <span className="flex h-6 min-w-6 items-center justify-center rounded-md bg-slate-900 px-1 text-xs font-bold text-white dark:bg-white dark:text-slate-900">
                {i.qty}
              </span>
              <span
                className={cn(
                  'pt-0.5 font-medium text-slate-900 dark:text-white',
                  t.status === 'completed' && 'text-slate-400 line-through',
                )}
              >
                {i.name}
              </span>
            </div>
            {i.note ? (
              <p className="mt-0.5 ml-8.5 text-xs text-amber-700 dark:text-amber-300">↳ {i.note}</p>
            ) : null}
          </li>
        ))}
      </ul>

      {t.note ? (
        <p className="mx-4 mt-3 flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          <MessageSquareText className="mt-px size-3.5 shrink-0" />
          {t.note}
        </p>
      ) : null}

      <footer className="p-4">
        {error ? (
          <p className="mb-2 flex items-center gap-1.5 text-xs text-red-600" role="alert">
            <AlertTriangle className="size-3.5" />
            {error}
          </p>
        ) : null}
        {next ? (
          <button
            type="button"
            disabled={busy || !onAdvance}
            onClick={async () => {
              if (!onAdvance) return;
              setBusy(true);
              setError(null);
              try {
                await onAdvance(t.id, next.to);
              } catch {
                setError('Could not update — try again.');
              } finally {
                setBusy(false);
              }
            }}
            className={cn(
              'flex h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold text-white shadow-sm transition-all active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60',
              next.to === 'ready' || next.to === 'completed'
                ? 'bg-emerald-600 hover:bg-emerald-700'
                : 'bg-slate-900 hover:bg-slate-800 dark:bg-white dark:text-slate-900',
            )}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {next.label}
          </button>
        ) : (
          <p className="flex items-center justify-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="size-4" /> Served
          </p>
        )}
      </footer>
    </motion.article>
  );
}

/** Re-renders every 30s so ticket timers stay current. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}
