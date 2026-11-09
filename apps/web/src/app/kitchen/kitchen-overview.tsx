'use client';

import { AlertBanner } from '@foodstack/ui/components/alert-banner';
import { cn } from '@foodstack/ui/lib/utils';
import { ArrowRight, ChefHat } from 'lucide-react';
import Link from 'next/link';
import type { Connection, KitchenTicket } from './kitchen-feed';
import { ConnectionPill } from './status';

const muted = 'text-slate-500 dark:text-slate-400';

/** Page title + one stats strip (the connection state lives in the header). */
export function SummaryCards({
  tickets,
  isLoading,
}: {
  tickets: KitchenTicket[];
  connection: Connection;
  isLoading: boolean;
}) {
  const today = new Date().toDateString();
  const stats = [
    {
      label: 'New',
      dot: 'bg-sky-500',
      value: tickets.filter((t) => t.status === 'new' || t.status === 'accepted').length,
    },
    {
      label: 'Preparing',
      dot: 'bg-amber-500',
      value: tickets.filter((t) => t.status === 'preparing').length,
    },
    {
      label: 'Ready to serve',
      dot: 'bg-emerald-500',
      value: tickets.filter((t) => t.status === 'ready').length,
    },
    {
      label: 'Completed today',
      dot: 'bg-slate-300 dark:bg-slate-600',
      value: tickets.filter(
        (t) => t.status === 'completed' && new Date(t.updatedAt).toDateString() === today,
      ).length,
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl dark:text-white">
          Kitchen orders
        </h1>
        <p className={cn('mt-0.5 text-sm', muted)}>
          Oldest orders first. Tickets update live as orders come in.
        </p>
      </div>
      <dl className="grid grid-cols-2 divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white sm:grid-cols-4 sm:divide-x dark:divide-white/10 dark:border-white/10 dark:bg-slate-900">
        {stats.map((s, i) => (
          <div
            key={s.label}
            className={cn(
              'px-4 py-3 sm:px-5 sm:py-4',
              i % 2 === 1 && 'border-l border-slate-200 sm:border-l-0 dark:border-white/10',
              i < 2 && 'border-b border-slate-200 sm:border-b-0 dark:border-white/10',
            )}
          >
            <dt className={cn('flex items-center gap-1.5 text-xs sm:text-sm', muted)}>
              <span className={cn('size-1.5 rounded-full', s.dot)} aria-hidden />
              {s.label}
            </dt>
            <dd className="mt-1 text-2xl font-semibold text-slate-900 tabular-nums dark:text-white">
              {isLoading ? (
                <span className="block h-7 w-8 animate-pulse rounded bg-slate-200 dark:bg-white/10" />
              ) : (
                <span aria-live="polite">{s.value}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function KitchenEmptyState({
  connection,
  canManage,
}: {
  connection: Connection;
  canManage: boolean;
}) {
  return (
    <section className="flex flex-col items-center rounded-lg border border-dashed border-slate-300 bg-white px-6 py-16 text-center dark:border-white/15 dark:bg-slate-900">
      <span className="flex size-11 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-white/5 dark:text-slate-400">
        <ChefHat className="size-5" aria-hidden />
      </span>
      <h2 className="mt-4 text-base font-semibold text-slate-900 dark:text-white">
        No orders right now
      </h2>
      <p className={cn('mt-1 max-w-sm text-sm', muted)}>
        New orders from the POS and waiters appear here automatically.
      </p>
      <div className="mt-4">
        <ConnectionPill connection={connection} />
      </div>
      {canManage ? (
        <Link
          href="/restaurant/dashboard"
          className="mt-6 inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-white/5"
        >
          Restaurant dashboard
          <ArrowRight className="size-4" aria-hidden />
        </Link>
      ) : null}
    </section>
  );
}

export function KitchenError({ message }: { message: string }) {
  return (
    <AlertBanner variant="danger" title="Orders could not be loaded">
      {message}
    </AlertBanner>
  );
}

export function TicketSkeletons() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {Array.from({ length: 4 }, (_, i) => (
        <div
          key={i}
          className="animate-pulse space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-slate-900"
        >
          <div className="h-5 w-24 rounded bg-slate-200 dark:bg-white/10" />
          <div className="h-3 w-32 rounded bg-slate-100 dark:bg-white/5" />
          <div className="space-y-2 pt-3">
            <div className="h-4 w-full rounded bg-slate-100 dark:bg-white/5" />
            <div className="h-4 w-4/5 rounded bg-slate-100 dark:bg-white/5" />
            <div className="h-4 w-3/5 rounded bg-slate-100 dark:bg-white/5" />
          </div>
          <div className="h-10 rounded-md bg-slate-100 dark:bg-white/5" />
        </div>
      ))}
    </div>
  );
}
