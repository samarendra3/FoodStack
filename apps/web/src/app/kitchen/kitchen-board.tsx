'use client';

import { cn } from '@foodstack/ui/lib/utils';
import {
  AlertTriangle,
  Bike,
  Check,
  Loader2,
  Search,
  ShoppingBag,
  UtensilsCrossed,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { useNotify } from '@/lib/notify';
import {
  type KitchenFeed,
  type KitchenTicket,
  NEXT_STATUS,
  type TicketOrderType,
  type TicketStatus,
} from './kitchen-feed';

/*
 * Kitchen ticket board. Same visual language as the admin: white cards with 1px borders, neutral
 * text, status shown as a small dot + label, one accent colour for the primary action. Colour is
 * kept for meaning only: amber/red timers for waiting tickets, red for rush.
 */

type Filter = 'all' | TicketStatus;

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Active' },
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

const STATUS_META: Record<TicketStatus, { label: string; dot: string }> = {
  new: { label: 'New', dot: 'bg-sky-500' },
  accepted: { label: 'Accepted', dot: 'bg-violet-500' },
  preparing: { label: 'Preparing', dot: 'bg-amber-500' },
  ready: { label: 'Ready', dot: 'bg-emerald-500' },
  completed: { label: 'Completed', dot: 'bg-slate-300 dark:bg-slate-600' },
};

const muted = 'text-slate-500 dark:text-slate-400';

/** Ticket filters + grid. Rendered only when the feed has tickets. */
export function TicketBoard({ feed }: { feed: KitchenFeed }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [type, setType] = useState<'all' | TicketOrderType>('all');
  const [query, setQuery] = useState('');
  const now = useNow();

  const q = query.trim().toLowerCase();
  const inScope = feed.tickets.filter(
    (t) =>
      (type === 'all' || t.orderType === type) &&
      (!q || t.orderNumber.toLowerCase().includes(q) || t.tableLabel?.toLowerCase().includes(q)),
  );
  const matches = (t: KitchenTicket, f: Filter) =>
    f === 'all'
      ? t.status !== 'completed'
      : f === 'new'
        ? t.status === 'new' || t.status === 'accepted'
        : t.status === f;
  // Rush first, then oldest first: the ticket waiting longest is always top-left.
  const visible = inScope
    .filter((t) => matches(t, filter))
    .sort((a, b) =>
      a.priority !== b.priority
        ? a.priority === 'rush'
          ? -1
          : 1
        : Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div
          role="tablist"
          aria-label="Status"
          className="inline-flex max-w-full overflow-x-auto rounded-md border border-slate-200 bg-white p-0.5 [scrollbar-width:none] dark:border-white/10 dark:bg-slate-900"
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
                  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded px-3 text-sm whitespace-nowrap transition-colors',
                  on
                    ? 'bg-slate-100 font-medium text-slate-900 dark:bg-white/10 dark:text-white'
                    : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white',
                )}
              >
                {f.label}
                <span className="text-xs text-slate-400 tabular-nums">{n}</span>
              </button>
            );
          })}
        </div>
        <div className="flex gap-2 sm:ml-auto">
          <label className="relative flex-1 sm:w-56 sm:flex-none">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <span className="sr-only">Search order or table</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Order # or table"
              className="h-9 w-full rounded-md border border-slate-200 bg-white pr-3 pl-9 text-sm outline-none focus-visible:border-emerald-600 focus-visible:ring-4 focus-visible:ring-emerald-600/15 dark:border-white/10 dark:bg-slate-900"
            />
          </label>
          <label>
            <span className="sr-only">Order type</span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as typeof type)}
              className="h-9 rounded-md border border-slate-200 bg-white px-2.5 text-sm text-slate-700 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200"
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
        <p
          className={cn(
            'rounded-lg border border-dashed border-slate-200 bg-white py-16 text-center text-sm dark:border-white/10 dark:bg-slate-900',
            muted,
          )}
        >
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
  const notify = useNotify();
  const minutes = Math.max(0, Math.floor((now - Date.parse(t.createdAt)) / 60000));
  const done = t.status === 'completed';
  const late = !done && minutes >= 20;
  const warn = !done && minutes >= 12;
  const next = NEXT_STATUS[t.status];
  const status = STATUS_META[t.status];
  const Type = TYPE_META[t.orderType].icon;
  const finishing = next && (next.to === 'ready' || next.to === 'completed');

  const advance = async () => {
    if (!onAdvance || !next) return;
    setBusy(true);
    setError(null);
    try {
      await onAdvance(t.id, next.to);
    } catch (e) {
      setError('Could not update. Try again.');
      notify.error(e, `Ticket ${t.orderNumber} not updated`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.article
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className={cn(
        'flex flex-col rounded-lg border bg-white dark:bg-slate-900',
        late
          ? 'border-red-300 dark:border-red-500/50'
          : t.priority === 'rush' && !done
            ? 'border-red-200 dark:border-red-500/30'
            : 'border-slate-200 dark:border-white/10',
        done && 'opacity-70',
      )}
      aria-label={`Order ${t.orderNumber}, ${status.label}`}
    >
      <header className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3 dark:border-white/5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-slate-900 tabular-nums dark:text-white">
              #{t.orderNumber}
            </h3>
            {t.tableLabel ? (
              <span className="rounded border border-slate-200 px-1.5 text-xs leading-5 font-medium text-slate-700 dark:border-white/10 dark:text-slate-200">
                {t.tableLabel}
                {t.billLabel ? ` · Bill ${t.billLabel}` : ''}
              </span>
            ) : null}
            {t.priority === 'rush' && !done ? (
              <span className="rounded bg-red-50 px-1.5 text-xs leading-5 font-semibold text-red-700 dark:bg-red-500/15 dark:text-red-300">
                Rush
              </span>
            ) : null}
          </div>
          <p className={cn('mt-0.5 flex items-center gap-1.5 text-xs', muted)}>
            <Type className="size-3.5" aria-hidden />
            {TYPE_META[t.orderType].label}
            <span aria-hidden>·</span>
            {new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {t.customerName ? (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{t.customerName}</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p
            className={cn(
              'text-sm font-semibold tabular-nums',
              late
                ? 'text-red-600 dark:text-red-400'
                : warn
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-slate-700 dark:text-slate-200',
            )}
            title="Time since order"
          >
            {minutes} min
          </p>
          <p className={cn('mt-0.5 flex items-center justify-end gap-1.5 text-xs', muted)}>
            <span className={cn('size-1.5 rounded-full', status.dot)} aria-hidden />
            {status.label}
          </p>
        </div>
      </header>

      <ul className="flex-1 space-y-2 px-4 py-3">
        {t.items.map((i) => (
          <li key={i.id} className="text-sm">
            <div className="flex gap-2">
              <span className="w-7 shrink-0 font-semibold text-slate-900 tabular-nums dark:text-white">
                {i.qty}×
              </span>
              <span
                className={cn(
                  'min-w-0 text-slate-800 dark:text-slate-100',
                  done && 'text-slate-400 line-through dark:text-slate-500',
                )}
              >
                {i.name}
              </span>
            </div>
            {i.note ? (
              <p className="mt-0.5 ml-9 text-xs text-amber-700 dark:text-amber-300">{i.note}</p>
            ) : null}
          </li>
        ))}
      </ul>

      {t.note ? (
        <p className="mx-4 mb-3 rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/5 dark:text-amber-200">
          <span className="font-medium">Note:</span> {t.note}
        </p>
      ) : null}

      <footer className="border-t border-slate-100 p-3 dark:border-white/5">
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
            onClick={advance}
            className={cn(
              'flex h-10 w-full items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              finishing
                ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                : 'border border-slate-200 bg-white text-slate-800 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-white/5',
            )}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {next.label}
          </button>
        ) : (
          <p className={cn('flex h-10 items-center justify-center gap-1.5 text-sm', muted)}>
            <Check className="size-4" aria-hidden /> Served
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
