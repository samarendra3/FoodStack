'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { ArrowDownRight, ArrowUpRight, Download, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  CHANNEL_LABEL,
  type Compared,
  type Filters,
  PRESETS,
  type Preset,
  type Summary,
  type Trend,
} from '@/lib/analytics';
import { authErrorMessage } from '@/lib/auth/errors';

/*
 * Shared building blocks for the restaurant report and module pages, so every page has the
 * same header, filter bar, cards and states.
 */

export const control =
  'h-9 rounded-md border border-slate-200 bg-white px-2.5 text-sm text-slate-700 shadow-xs focus-visible:ring-2 focus-visible:ring-emerald-500/40 focus-visible:outline-none dark:border-white/10 dark:bg-white/5 dark:text-slate-200 [&>option]:text-slate-900';

export const buttonPrimary =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-3.5 text-sm font-medium text-white shadow-xs hover:bg-emerald-700 disabled:pointer-events-none disabled:opacity-50';

export const buttonSecondary =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-xs hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-slate-200 dark:hover:bg-white/10';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({
  title,
  subtitle,
  icon: Icon,
  aside,
  children,
  className,
}: {
  title?: string;
  subtitle?: string;
  icon?: LucideIcon;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'rounded-xl border border-slate-200 bg-white p-4 shadow-xs sm:p-5 dark:border-white/10 dark:bg-slate-900',
        className,
      )}
    >
      {title ? (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            {Icon ? <Icon className="mt-0.5 size-[18px] text-slate-400" aria-hidden /> : null}
            <div>
              <h2 className="text-base font-semibold tracking-tight">{title}</h2>
              {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
            </div>
          </div>
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Delta({
  pct,
  invert = false,
}: {
  pct: number | null | undefined;
  invert?: boolean;
}) {
  if (pct === null || pct === undefined)
    return <span className="text-xs text-muted-foreground">—</span>;
  const up = pct > 0;
  const good = pct === 0 ? null : invert ? !up : up;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-xs font-medium tabular-nums',
        good === null
          ? 'text-muted-foreground'
          : good
            ? 'text-emerald-700 dark:text-emerald-400'
            : 'text-red-600 dark:text-red-400',
      )}
    >
      {pct !== 0 ? <Icon className="size-3.5" aria-hidden /> : null}
      {up ? '+' : ''}
      {pct}%
    </span>
  );
}

/** KPI tile: label, value and (optionally) change against the previous period. */
export function Stat({
  label,
  value,
  cmp,
  format,
  hint,
  invert,
  loading,
  icon: Icon,
}: {
  label: string;
  value: string | number | null | undefined;
  cmp?: Compared;
  format?: (v: number) => string;
  hint?: string;
  invert?: boolean;
  loading?: boolean;
  icon?: LucideIcon;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs dark:border-white/10 dark:bg-slate-900">
      <div className="flex items-start justify-between gap-2">
        <p className="truncate text-sm font-medium text-muted-foreground">{label}</p>
        {Icon ? <Icon className="size-4 shrink-0 text-slate-400" aria-hidden /> : null}
      </div>
      {loading && (value === undefined || value === null) ? (
        <div className="mt-2 h-7 w-24 animate-pulse rounded bg-slate-100 dark:bg-white/10" />
      ) : (
        <p className="mt-1 text-xl font-semibold tracking-tight tabular-nums sm:text-2xl">
          {value === undefined || value === null ? '—' : value}
        </p>
      )}
      <p className="mt-1 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
        {cmp ? (
          <>
            <Delta pct={cmp.changePct} invert={invert} />
            <span className="truncate">
              vs {format ? format(cmp.previous) : cmp.previous} previous
            </span>
          </>
        ) : (
          (hint ?? ' ')
        )}
      </p>
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}

export function ErrorNote({ error }: { error: unknown }) {
  return (
    <p
      role="alert"
      className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300"
    >
      {authErrorMessage(error)}
    </p>
  );
}

export function EmptyNote({
  icon: Icon,
  title,
  text,
  action,
}: {
  icon: LucideIcon;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15">
        <Icon className="size-5" aria-hidden />
      </span>
      <p className="mt-3 text-sm font-semibold">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{text}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn('animate-pulse rounded-lg bg-slate-100 dark:bg-white/10', className)} />
  );
}

export function CsvButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={buttonSecondary}>
      <Download className="size-4" /> Export CSV
    </button>
  );
}

/** Date range, branch and order-type filters shared by the analytics report pages. */
export function ReportFilters({
  filters,
  onChange,
  meta,
  showChannel = true,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  meta?: Pick<Summary, 'branches' | 'range' | 'timezone' | 'generatedAt'>;
  showChannel?: boolean;
}) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  return (
    <div className="space-y-2">
      <form
        className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center"
        aria-label="Report filters"
        onSubmit={(e) => e.preventDefault()}
      >
        <select
          aria-label="Date range"
          className={control}
          value={filters.preset}
          onChange={(e) => set({ preset: e.target.value as Preset })}
        >
          {PRESETS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        {filters.preset === 'custom' ? (
          <>
            <input
              type="date"
              aria-label="From"
              className={control}
              value={filters.from ?? ''}
              max={filters.to}
              onChange={(e) => set({ from: e.target.value || undefined })}
            />
            <input
              type="date"
              aria-label="To"
              className={control}
              value={filters.to ?? ''}
              min={filters.from}
              onChange={(e) => set({ to: e.target.value || undefined })}
            />
          </>
        ) : null}
        {meta && meta.branches.length > 1 ? (
          <select
            aria-label="Branch"
            className={control}
            value={filters.branchId ?? ''}
            onChange={(e) => set({ branchId: e.target.value || undefined })}
          >
            <option value="">All branches</option>
            {meta.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        ) : null}
        {showChannel ? (
          <select
            aria-label="Order type"
            className={control}
            value={filters.channel ?? ''}
            onChange={(e) => set({ channel: e.target.value || undefined })}
          >
            <option value="">All order types</option>
            {Object.entries(CHANNEL_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        ) : null}
      </form>
      {meta ? (
        <p className="text-xs text-muted-foreground">
          {meta.range.from === meta.range.to
            ? meta.range.from
            : `${meta.range.from} – ${meta.range.to}`}{' '}
          · {meta.timezone} · compared with the previous period · updated{' '}
          {new Date(meta.generatedAt).toLocaleTimeString()}
        </p>
      ) : null}
    </div>
  );
}

/** Axis/tooltip labels for a trend bucket, matching the dashboard. */
export function bucketLabel(t: Trend, bucket: string, long: boolean) {
  const d = new Date(`${bucket}:00Z`);
  const opts: Intl.DateTimeFormatOptions =
    t.granularity === 'hour'
      ? { hour: 'numeric', ...(long ? { day: 'numeric', month: 'short' } : {}) }
      : t.granularity === 'day'
        ? { day: 'numeric', month: 'short', ...(long ? { weekday: 'short' } : {}) }
        : { month: 'short', ...(long ? { year: 'numeric' } : {}) };
  return new Intl.DateTimeFormat('en-IN', { ...opts, timeZone: 'UTC' }).format(d);
}

export const compact = (minor: number) =>
  new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(
    minor / 100,
  );

export const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${v}%`;
