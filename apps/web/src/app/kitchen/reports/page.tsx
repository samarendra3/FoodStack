'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { useMemo } from 'react';
import { CARD, KitchenFrame } from '../kitchen-frame';
import type { KitchenTicket } from '../kitchen-feed';
import { KitchenError, TicketSkeletons } from '../kitchen-overview';

export default function KitchenReportsPage() {
  return (
    <KitchenFrame title="Reports">
      {({ feed }) => (
        <div className="mx-auto max-w-[110rem] space-y-5 p-4 sm:p-6">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Covers open orders and orders served in the last 12 hours for this branch.
          </p>
          {feed.error ? <KitchenError message={feed.error} /> : null}
          {feed.isLoading ? <TicketSkeletons /> : <Report tickets={feed.tickets} />}
        </div>
      )}
    </KitchenFrame>
  );
}

function Report({ tickets }: { tickets: KitchenTicket[] }) {
  const r = useMemo(() => {
    const done = tickets.filter((t) => t.status === 'completed');
    // updatedAt of a completed ticket is when it was marked complete.
    const mins = done.map(
      (t) => (new Date(t.updatedAt).getTime() - new Date(t.createdAt).getTime()) / 60_000,
    );
    const avg = mins.length ? mins.reduce((a, b) => a + b, 0) / mins.length : null;
    const slowest = mins.length ? Math.max(...mins) : null;

    const itemTotals = new Map<string, number>();
    for (const t of tickets)
      for (const i of t.items) itemTotals.set(i.name, (itemTotals.get(i.name) ?? 0) + i.qty);
    const topItems = [...itemTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

    const types = { 'dine-in': 0, takeaway: 0, delivery: 0 };
    for (const t of tickets) types[t.orderType]++;

    const hours = new Map<number, number>();
    for (const t of tickets) {
      const h = new Date(t.createdAt).getHours();
      hours.set(h, (hours.get(h) ?? 0) + 1);
    }
    const hourRows = [...hours.entries()].sort((a, b) => a[0] - b[0]);

    return {
      total: tickets.length,
      done: done.length,
      active: tickets.length - done.length,
      avg,
      slowest,
      dishes: [...itemTotals.values()].reduce((a, b) => a + b, 0),
      topItems,
      types,
      hourRows,
    };
  }, [tickets]);

  if (r.total === 0) {
    return (
      <div className={cn(CARD, 'p-10 text-center text-sm text-slate-500 dark:text-slate-400')}>
        No orders yet in this period.
      </div>
    );
  }

  const fmt = (m: number | null) => (m === null ? '—' : `${Math.round(m)} min`);
  const maxItem = r.topItems[0]?.[1] ?? 1;
  const maxHour = Math.max(1, ...r.hourRows.map(([, n]) => n));

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Orders" value={r.total} />
        <Stat label="Completed" value={r.done} />
        <Stat label="In progress" value={r.active} />
        <Stat label="Avg. completion" value={fmt(r.avg)} />
        <Stat label="Slowest" value={fmt(r.slowest)} className="col-span-2 sm:col-span-1" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className={cn(CARD, 'p-4')}>
          <h2 className="mb-3 text-sm font-semibold text-slate-900 dark:text-white">
            Top dishes <span className="font-normal text-slate-500">({r.dishes} prepared)</span>
          </h2>
          <ul className="space-y-2">
            {r.topItems.map(([name, qty]) => (
              <Bar key={name} label={name} value={qty} max={maxItem} />
            ))}
          </ul>
        </section>

        <section className={cn(CARD, 'p-4')}>
          <h2 className="mb-3 text-sm font-semibold text-slate-900 dark:text-white">
            Orders by hour
          </h2>
          <ul className="space-y-2">
            {r.hourRows.map(([h, n]) => (
              <Bar key={h} label={`${String(h).padStart(2, '0')}:00`} value={n} max={maxHour} />
            ))}
          </ul>
          <h2 className="mt-5 mb-3 text-sm font-semibold text-slate-900 dark:text-white">
            Order type
          </h2>
          <ul className="space-y-2">
            <Bar label="Dine-in" value={r.types['dine-in']} max={r.total} />
            <Bar label="Takeaway" value={r.types.takeaway} max={r.total} />
            <Bar label="Delivery" value={r.types.delivery} max={r.total} />
          </ul>
        </section>
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  className,
}: {
  label: string;
  value: string | number;
  className?: string;
}) {
  return (
    <div className={cn(CARD, 'p-3 sm:p-4', className)}>
      <p className="truncate text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-1 text-xl font-semibold sm:text-2xl text-slate-900 tabular-nums dark:text-white">
        {value}
      </p>
    </div>
  );
}

function Bar({ label, value, max }: { label: string; value: number; max: number }) {
  return (
    <li className="grid grid-cols-[minmax(0,6rem)_1fr_2rem] items-center gap-2 sm:grid-cols-[minmax(0,10rem)_1fr_2.5rem] sm:gap-3 text-sm">
      <span className="truncate text-slate-700 dark:text-slate-200">{label}</span>
      <span className="h-2 rounded-full bg-slate-100 dark:bg-white/10">
        <span
          className="block h-2 rounded-full bg-emerald-500"
          style={{ width: `${(value / max) * 100}%` }}
        />
      </span>
      <span className="text-right text-slate-500 tabular-nums dark:text-slate-400">{value}</span>
    </li>
  );
}
