'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ChevronDown, Download, FileClock, Search } from 'lucide-react';
import { motion } from 'motion/react';
import { Fragment, useState } from 'react';
import { useAuth } from '@/components/auth/auth-provider';
import { authErrorMessage } from '@/lib/auth/errors';
import { downloadCsv } from '@/lib/csv';
import { card, ease } from '../restaurants-panel';

interface LogRow {
  id: string;
  createdAt: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  audience: 'platform' | 'tenant' | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  tenantId: string | null;
  tenantName: string | null;
  actorEmail: string | null;
  actorName: string | null;
}
interface LogPage {
  actionGroups: string[];
  nextCursor: string | null;
  rows: LogRow[];
}

const control =
  'h-9 rounded-md border border-slate-200 bg-white px-2.5 text-sm text-slate-700 dark:border-white/10 dark:bg-white/5 dark:text-slate-200 [&>option]:text-slate-900';
const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

/** "inventory.purchase" → "Inventory · purchase" */
const pretty = (a: string) => {
  const [head, ...rest] = a.split('.');
  return `${head!.charAt(0).toUpperCase()}${head!.slice(1).replace(/_/g, ' ')}${rest.length ? ` · ${rest.join('.').replace(/_/g, ' ')}` : ''}`;
};
const tone = (a: string) =>
  /disabled|deleted|cancel|revok|suspend|failed|refund|void/.test(a)
    ? 'bg-red-500'
    : /created|enabled|opened|approved|received|login/.test(a)
      ? 'bg-emerald-500'
      : 'bg-sky-500';

export default function PlatformAuditLogsPage() {
  const { client } = useAuth();
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');
  const [audience, setAudience] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const qs = new URLSearchParams();
  if (search.trim()) qs.set('search', search.trim());
  if (action) qs.set('action', action);
  if (audience) qs.set('audience', audience);
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const logs = useInfiniteQuery({
    queryKey: ['platform', 'audit', qs.toString()],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(qs);
      if (pageParam) p.set('before', pageParam);
      return client.request<LogPage>(`/platform/audit-logs?${p}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
  const rows = logs.data?.pages.flatMap((p) => p.rows) ?? [];
  const groups = logs.data?.pages[0]?.actionGroups ?? [];

  const exportCsv = () =>
    downloadCsv(`audit-log-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['Time', 'Action', 'Actor', 'Audience', 'Restaurant', 'Entity', 'IP', 'Details'],
      ...rows.map((r) => [
        r.createdAt,
        r.action,
        r.actorEmail ?? 'system',
        r.audience ?? '',
        r.tenantName ?? '',
        r.entityType ? `${r.entityType}:${r.entityId ?? ''}` : '',
        r.ip ?? '',
        JSON.stringify(r.metadata),
      ]),
    ]);

  return (
    <div className="mx-auto max-w-[90rem] space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease }}
        className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-end sm:justify-between"
      >
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Audit Logs</h1>
          <p className="mt-1 text-muted-foreground">
            Every important action on FoodStack: who did it, where and when.
          </p>
        </div>
        <button
          type="button"
          onClick={exportCsv}
          disabled={rows.length === 0}
          className={cn(
            control,
            'inline-flex items-center gap-1.5 font-medium disabled:opacity-50',
          )}
        >
          <Download className="size-4" /> Export loaded rows
        </button>
      </motion.div>

      <div className={cn(card, 'overflow-hidden')}>
        <div className="grid grid-cols-2 gap-2 border-b border-slate-200 p-4 sm:flex sm:flex-wrap sm:items-center dark:border-white/10">
          <label className="relative col-span-2 sm:w-72">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
            <span className="sr-only">Search</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Action, email, restaurant or IP"
              className={cn(control, 'w-full pl-9')}
            />
          </label>
          <select
            aria-label="Area"
            className={control}
            value={action}
            onChange={(e) => setAction(e.target.value)}
          >
            <option value="">All areas</option>
            {groups.map((g) => (
              <option key={g} value={`${g}.`}>
                {pretty(g)}
              </option>
            ))}
          </select>
          <select
            aria-label="Who"
            className={control}
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
          >
            <option value="">Everyone</option>
            <option value="tenant">Restaurant users</option>
            <option value="platform">Platform admins</option>
          </select>
          <input
            type="date"
            aria-label="From"
            className={control}
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
          />
          <input
            type="date"
            aria-label="To"
            className={control}
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>

        {logs.isError ? (
          <p
            role="alert"
            className="m-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300"
          >
            {authErrorMessage(logs.error)}
          </p>
        ) : logs.isPending ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-slate-100 dark:bg-white/5" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center py-14 text-center">
            <FileClock className="size-8 text-slate-300" />
            <p className="mt-3 font-medium">No activity matches</p>
            <p className="text-sm text-muted-foreground">
              Try a wider date range or clear the filters.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-white/5">
            {rows.map((r) => (
              <Fragment key={r.id}>
                <li>
                  <button
                    type="button"
                    onClick={() => setOpen(open === r.id ? null : r.id)}
                    aria-expanded={open === r.id}
                    className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-white/5"
                  >
                    <span
                      className={cn('mt-1.5 size-2 shrink-0 rounded-full', tone(r.action))}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{pretty(r.action)}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {r.actorName ? `${r.actorName} (${r.actorEmail})` : 'System'}
                        {r.tenantName
                          ? ` · ${r.tenantName}`
                          : r.audience === 'platform'
                            ? ' · Platform'
                            : ''}
                        {r.ip ? ` · ${r.ip}` : ''}
                      </p>
                    </div>
                    <span className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                      {when.format(new Date(r.createdAt))}
                    </span>
                    <ChevronDown
                      className={cn(
                        'mt-0.5 size-4 shrink-0 text-slate-400 transition-transform',
                        open === r.id && 'rotate-180',
                      )}
                    />
                  </button>
                  {open === r.id ? (
                    <dl className="grid gap-x-6 gap-y-2 bg-slate-50 px-4 py-3 pl-9 text-xs sm:grid-cols-2 dark:bg-white/5">
                      <Detail label="Action code" value={r.action} />
                      <Detail
                        label="Record"
                        value={r.entityType ? `${r.entityType} ${r.entityId ?? ''}` : '—'}
                      />
                      <Detail label="Request ID" value={r.requestId ?? '—'} />
                      <Detail label="Device" value={r.userAgent ?? '—'} />
                      <div className="sm:col-span-2">
                        <dt className="text-muted-foreground">Details</dt>
                        <dd>
                          <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-white p-2 font-mono text-[11px] whitespace-pre-wrap dark:bg-black/30">
                            {Object.keys(r.metadata ?? {}).length
                              ? JSON.stringify(r.metadata, null, 2)
                              : 'No extra details'}
                          </pre>
                        </dd>
                      </div>
                    </dl>
                  ) : null}
                </li>
              </Fragment>
            ))}
          </ul>
        )}

        {logs.hasNextPage ? (
          <div className="border-t border-slate-200 p-4 text-center dark:border-white/10">
            <button
              type="button"
              onClick={() => void logs.fetchNextPage()}
              disabled={logs.isFetchingNextPage}
              className={cn(control, 'px-4 font-medium')}
            >
              {logs.isFetchingNextPage ? 'Loading…' : 'Load older activity'}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono">{value}</dd>
    </div>
  );
}
