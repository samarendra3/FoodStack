import { cn } from '@foodstack/ui/lib/utils';
import type { Connection } from './kitchen-feed';

export const CONNECTION: Record<
  Connection,
  { label: string; detail: string; dot: string; pill: string; pulse?: boolean }
> = {
  online: {
    label: 'Live',
    detail: 'Receiving orders in real time',
    dot: 'bg-emerald-500',
    pill: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-300',
    pulse: true,
  },
  connecting: {
    label: 'Connecting',
    detail: 'Connecting to the kitchen feed…',
    dot: 'bg-sky-500',
    pill: 'bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/15 dark:text-sky-300',
    pulse: true,
  },
  reconnecting: {
    label: 'Reconnecting',
    detail: 'Connection lost — retrying automatically',
    dot: 'bg-amber-500',
    pill: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-300',
    pulse: true,
  },
  offline: {
    label: 'Offline',
    detail: 'Not receiving orders — check the network',
    dot: 'bg-red-500',
    pill: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/15 dark:text-red-300',
  },
  unavailable: {
    label: 'Not connected',
    detail: 'Live orders start when the kitchen module goes live',
    dot: 'bg-slate-400',
    pill: 'bg-slate-100 text-slate-600 ring-slate-500/20 dark:bg-white/10 dark:text-slate-300',
  },
};

export function ConnectionPill({ connection }: { connection: Connection }) {
  const c = CONNECTION[connection];
  return (
    <span
      role="status"
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200',
      )}
    >
      <span className={cn('size-1.5 rounded-full', c.dot)} aria-hidden />
      {c.label}
    </span>
  );
}
