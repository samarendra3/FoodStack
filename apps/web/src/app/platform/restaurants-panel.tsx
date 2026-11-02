'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Check, Copy, Layers, Plus, Store } from 'lucide-react';
import { motion } from 'motion/react';
import Link from 'next/link';
import { useState } from 'react';
import { useAuth } from '@/components/auth/auth-provider';
import { authErrorMessage } from '@/lib/auth/errors';
import { usePlatformSearch } from './platform-shell';

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  trialEndsAt: string | null;
  createdAt: string;
  activeMembers: number;
}

const STATUS_STYLE: Record<string, string> = {
  active:
    'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300',
  trial: 'bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300',
  suspended:
    'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300',
  deactivated: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300',
};

const PREVIEW_ROWS = 5;
export const ease = [0.22, 1, 0.36, 1] as const;
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export const card =
  'rounded-[16px] border border-slate-200/70 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)] dark:border-white/10 dark:bg-[#101c18]';

const STATUS_FILTERS = ['all', 'active', 'trial', 'suspended', 'deactivated'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

/**
 * Restaurant accounts list. `preview` (dashboard) shows the newest few with a link to the full
 * page; the full page adds status filters. Both follow the header search.
 */
export function RestaurantsPanel({ preview = false }: { preview?: boolean }) {
  const { client } = useAuth();
  const search = usePlatformSearch().trim().toLowerCase();
  const [status, setStatus] = useState<StatusFilter>('all');
  const tenants = useQuery({
    queryKey: ['platform', 'tenants'],
    queryFn: () => client.request<TenantRow[]>('/platform/tenants'),
  });
  const all = tenants.data ?? [];
  const filtered = all.filter(
    (t) =>
      (preview || status === 'all' || t.status === status) &&
      (!search || t.name.toLowerCase().includes(search) || t.slug.includes(search)),
  );
  const rows = preview && !search ? filtered.slice(0, PREVIEW_ROWS) : filtered;
  const countOf = (s: StatusFilter) =>
    s === 'all' ? all.length : all.filter((t) => t.status === s).length;

  return (
    <motion.section
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, delay: 0.45, ease }}
      className={cn(card, 'isolate overflow-hidden')}
    >
      <div className="flex flex-wrap items-center justify-between gap-4 p-5 sm:p-6">
        <div className="flex items-center gap-4">
          <span className="flex size-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
            <Layers className="size-6" />
          </span>
          <div>
            <h2 className="text-lg font-semibold">Restaurant accounts</h2>
            <p className="text-sm text-muted-foreground">
              Every registered restaurant, newest first.
            </p>
          </div>
        </div>
        {preview && all.length > 0 ? (
          <Link
            href="/platform/restaurants"
            className="group inline-flex items-center gap-2 rounded-full border border-emerald-500/60 px-5 py-2 text-sm font-semibold text-emerald-700 transition-colors hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
          >
            View all restaurants
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
          </Link>
        ) : null}
      </div>

      {!preview && all.length > 0 ? (
        <div className="flex gap-2 overflow-x-auto px-5 pb-4 sm:px-6">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              aria-pressed={status === s}
              className={cn(
                'relative shrink-0 rounded-full px-4 py-1.5 text-sm font-medium capitalize transition-colors',
                status === s
                  ? 'text-white'
                  : 'text-muted-foreground hover:bg-slate-100 hover:text-foreground dark:hover:bg-white/5',
              )}
            >
              {status === s ? (
                <motion.span
                  layoutId="status-filter"
                  className="absolute inset-0 -z-10 rounded-full bg-emerald-600"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                />
              ) : null}
              <span className="relative">
                {s} <span className="opacity-70">{countOf(s)}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="px-5 pb-5 sm:px-6 sm:pb-6">
        {tenants.isPending ? (
          <div className="space-y-3" aria-hidden>
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="h-12 animate-pulse rounded-[10px] bg-muted" />
            ))}
          </div>
        ) : tenants.isError ? (
          <p className="text-sm text-red-600">{authErrorMessage(tenants.error)}</p>
        ) : tenants.data.length === 0 ? (
          <EmptyRestaurants />
        ) : rows.length === 0 ? (
          <p className="rounded-[12px] border border-dashed border-slate-200 p-8 text-center text-sm text-muted-foreground dark:border-white/10">
            {search ? <>No restaurants match “{search}”.</> : <>No {status} restaurants.</>}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-[12px] border border-slate-200/70 dark:border-white/10">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="bg-slate-50 text-left text-xs tracking-wide text-muted-foreground uppercase dark:bg-white/5">
                <tr>
                  <th className="px-5 py-3 font-medium">Restaurant</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 text-right font-medium">Team</th>
                  <th className="px-5 py-3 font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-white/5">
                {rows.map((t, i) => (
                  <motion.tr
                    key={t.id}
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.35, delay: Math.min(i, 10) * 0.04, ease }}
                    className="transition-colors hover:bg-emerald-50/50 dark:hover:bg-white/[0.03]"
                  >
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <span className="flex size-9 items-center justify-center rounded-[10px] bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
                          <Store className="size-4" />
                        </span>
                        <div>
                          <p className="font-medium">{t.name}</p>
                          <p className="text-xs text-muted-foreground">{t.slug}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={cn(
                          'inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ring-1 ring-inset',
                          STATUS_STYLE[t.status] ?? 'bg-muted text-muted-foreground ring-border',
                        )}
                      >
                        {t.status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums">{t.activeMembers}</td>
                    <td className="px-5 py-3 text-muted-foreground">
                      {dateFormat.format(new Date(t.createdAt))}
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </motion.section>
  );
}

const CREATE_COMMAND =
  'pnpm --filter @foodstack/api cli tenant:create --name "My Restaurant" --slug my-restaurant --owner-email owner@example.com --owner-name "Owner Name"';

function EmptyRestaurants() {
  const [showHow, setShowHow] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col items-center rounded-[14px] border border-slate-100 bg-gradient-to-b from-emerald-50/40 to-transparent px-4 py-8 text-center dark:border-white/5 dark:from-emerald-500/5">
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1, y: [0, -6, 0] }}
        transition={{
          opacity: { duration: 0.5 },
          scale: { duration: 0.5, ease },
          y: { duration: 5, repeat: Infinity, ease: 'easeInOut', delay: 0.6 },
        }}
      >
        <StoreIllustration />
      </motion.div>
      <p className="mt-2 text-lg font-semibold">No restaurants yet</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Restaurants appear here as soon as they are registered.
      </p>
      <button
        type="button"
        onClick={() => setShowHow((s) => !s)}
        aria-expanded={showHow}
        className="group mt-5 inline-flex items-center gap-2 rounded-[10px] bg-emerald-600 transition-transform active:scale-95 hover:-translate-y-0.5 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-600/25 transition-colors hover:bg-emerald-700"
      >
        Create Restaurant
        <Plus className="size-4 transition-transform duration-300 group-hover:rotate-90" />
      </button>
      {showHow ? (
        <div className="mt-4 w-full max-w-2xl rounded-[12px] border border-slate-200 bg-white p-4 text-left dark:border-white/10 dark:bg-black/20">
          <p className="text-sm text-muted-foreground">
            Restaurants are created from the server for now. Run this in the project folder; it
            prints a link for the owner to set their password.
          </p>
          <div className="mt-3 flex items-start gap-2 rounded-[10px] bg-slate-900 p-3 text-xs text-emerald-200">
            <code className="flex-1 break-all">{CREATE_COMMAND}</code>
            <button
              type="button"
              aria-label="Copy command"
              onClick={async () => {
                await navigator.clipboard.writeText(CREATE_COMMAND);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="shrink-0 rounded-md p-1 text-slate-300 hover:bg-white/10"
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StoreIllustration() {
  return (
    <svg aria-hidden viewBox="0 0 320 140" className="h-28 w-auto sm:h-32">
      <ellipse
        cx="160"
        cy="126"
        rx="130"
        ry="8"
        className="fill-emerald-100 dark:fill-emerald-500/10"
      />
      <circle cx="160" cy="70" r="58" className="fill-emerald-50 dark:fill-emerald-500/10" />
      {/* clouds */}
      <path
        d="M78 40 a10 10 0 0 1 18 -4 a8 8 0 0 1 12 8 h-34 a6 6 0 0 1 4 -4z"
        className="fill-emerald-100 dark:fill-emerald-500/15"
      />
      <path
        d="M212 34 a10 10 0 0 1 18 -4 a8 8 0 0 1 12 8 h-34 a6 6 0 0 1 4 -4z"
        className="fill-emerald-100 dark:fill-emerald-500/15"
      />
      {/* trees */}
      <g className="fill-emerald-200 dark:fill-emerald-500/25">
        <circle cx="70" cy="98" r="14" />
        <circle cx="98" cy="104" r="10" />
        <circle cx="244" cy="96" r="15" />
        <circle cx="222" cy="106" r="9" />
      </g>
      <g className="stroke-emerald-300 dark:stroke-emerald-500/40" strokeWidth="2">
        <path d="M70 108v18M98 112v14M244 108v18M222 112v14" />
      </g>
      {/* store */}
      <rect
        x="118"
        y="62"
        width="84"
        height="62"
        rx="3"
        className="fill-white stroke-emerald-500 dark:fill-[#13241e]"
        strokeWidth="3"
      />
      <path d="M112 62 l8 -22 h80 l8 22 z" className="fill-emerald-500" />
      <path
        d="M112 62 q8 10 16 0 q8 10 16 0 q8 10 16 0 q8 10 16 0 q8 10 16 0 q8 10 16 0"
        className="fill-emerald-400 stroke-emerald-600"
        strokeWidth="2"
      />
      <rect
        x="130"
        y="82"
        width="20"
        height="18"
        rx="2"
        className="fill-emerald-100 stroke-emerald-500 dark:fill-emerald-500/20"
        strokeWidth="2"
      />
      <rect
        x="170"
        y="82"
        width="20"
        height="18"
        rx="2"
        className="fill-emerald-100 stroke-emerald-500 dark:fill-emerald-500/20"
        strokeWidth="2"
      />
      <path
        d="M150 124 v-18 h20 v18"
        className="fill-emerald-200 stroke-emerald-500 dark:fill-emerald-500/20"
        strokeWidth="2"
      />
      {/* plus badge */}
      <circle
        cx="206"
        cy="112"
        r="15"
        className="fill-emerald-600 stroke-white dark:stroke-[#101c18]"
        strokeWidth="3"
      />
      <path d="M206 105v14M199 112h14" stroke="white" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
