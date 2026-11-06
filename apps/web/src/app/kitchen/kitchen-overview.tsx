'use client';

import { AlertBanner } from '@foodstack/ui/components/alert-banner';
import { cn } from '@foodstack/ui/lib/utils';
import { Activity, ArrowRight, CheckCircle2, Clock, UtensilsCrossed } from 'lucide-react';
import { motion } from 'motion/react';
import Link from 'next/link';
import type { Connection, KitchenTicket } from './kitchen-feed';
import { CONNECTION, ConnectionPill } from './status';

export function SummaryCards({
  tickets,
  connection,
  isLoading,
}: {
  tickets: KitchenTicket[];
  connection: Connection;
  isLoading: boolean;
}) {
  const today = new Date().toDateString();
  const cards = [
    {
      label: 'Pending Orders',
      value: tickets.filter((t) => t.status === 'new' || t.status === 'accepted').length,
      icon: UtensilsCrossed,
      tile: 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
    },
    {
      label: 'In Progress',
      value: tickets.filter((t) => t.status === 'preparing').length,
      icon: Clock,
      tile: 'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300',
    },
    {
      label: 'Completed Today',
      value: tickets.filter(
        (t) => t.status === 'completed' && new Date(t.updatedAt).toDateString() === today,
      ).length,
      icon: CheckCircle2,
      tile: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
    },
  ];
  const c = CONNECTION[connection];
  const live = connection === 'online';

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map(({ label, value, icon: Icon, tile }, i) => (
        <motion.div
          key={label}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.05 }}
          className="flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-xs dark:border-white/10 dark:bg-slate-900"
        >
          <span
            className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', tile)}
          >
            <Icon className="size-5" />
          </span>
          <div>
            {isLoading ? (
              <span className="block h-8 w-10 animate-pulse rounded bg-slate-200 dark:bg-white/10" />
            ) : (
              <p
                className="text-3xl font-bold tabular-nums text-slate-900 dark:text-white"
                aria-live="polite"
              >
                {value}
              </p>
            )}
            <p className="text-sm text-slate-500">{label}</p>
          </div>
        </motion.div>
      ))}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className={cn(
          'relative flex items-center overflow-hidden rounded-xl border p-5',
          live
            ? 'border-emerald-200 bg-gradient-to-r from-emerald-50 to-emerald-100/60 dark:border-emerald-500/20 dark:from-emerald-500/10 dark:to-emerald-500/5'
            : 'border-slate-200 bg-white dark:border-white/10 dark:bg-slate-900',
        )}
      >
        <div className="relative z-10">
          <p className="flex items-center gap-2 font-semibold text-slate-900 dark:text-white">
            <span className={cn('size-2.5 rounded-full', c.dot)} />
            {live ? 'Kitchen Online' : `Kitchen ${c.label.toLowerCase()}`}
          </p>
          <p className="mt-1 text-sm text-slate-500">{c.detail}</p>
        </div>
        <Activity
          className={cn(
            'absolute right-4 size-14',
            live ? 'text-emerald-400/70' : 'text-slate-200 dark:text-white/10',
          )}
          strokeWidth={1.5}
          aria-hidden
        />
      </motion.div>
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
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.1 }}
      className="relative flex flex-col items-center overflow-hidden rounded-xl border border-slate-200 bg-white px-6 py-12 text-center sm:py-16 dark:border-white/10 dark:bg-slate-900"
    >
      <svg
        aria-hidden
        viewBox="0 0 1200 200"
        preserveAspectRatio="none"
        className="absolute inset-x-0 bottom-0 h-32 w-full"
      >
        <path
          d="M0 200 C 300 120, 600 190, 900 120 S 1200 100, 1200 100 L1200 200 Z"
          className="fill-emerald-50 dark:fill-emerald-500/5"
        />
      </svg>
      <ChefIllustration className="relative h-52 w-auto sm:h-60" />
      <h2 className="relative mt-6 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl dark:text-white">
        Your kitchen is <span className="text-emerald-600 dark:text-emerald-400">ready!</span>
      </h2>
      <p className="relative mt-3 max-w-md text-slate-500">
        New orders will appear here automatically when customers place orders.
      </p>
      <div className="relative mt-4">
        <ConnectionPill connection={connection} />
      </div>
      {canManage ? (
        <Link
          href="/restaurant/dashboard"
          className="relative mt-7 inline-flex h-12 items-center gap-2 rounded-xl bg-emerald-600 px-6 font-semibold text-white shadow-sm transition-all hover:bg-emerald-700 active:scale-[0.99]"
        >
          Go to Restaurant Dashboard
          <ArrowRight className="size-4" />
        </Link>
      ) : null}
    </motion.section>
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
          className="animate-pulse space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-slate-900"
        >
          <div className="h-5 w-24 rounded bg-slate-200 dark:bg-white/10" />
          <div className="h-3 w-32 rounded bg-slate-200 dark:bg-white/10" />
          <div className="space-y-2 pt-3">
            <div className="h-4 w-full rounded bg-slate-100 dark:bg-white/5" />
            <div className="h-4 w-4/5 rounded bg-slate-100 dark:bg-white/5" />
            <div className="h-4 w-3/5 rounded bg-slate-100 dark:bg-white/5" />
          </div>
          <div className="h-11 rounded-xl bg-slate-200 dark:bg-white/10" />
        </div>
      ))}
    </div>
  );
}

/** Flat chef-at-the-pass illustration in the brand palette. */
function ChefIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 360 240" className={className} aria-hidden>
      <circle cx="190" cy="118" r="100" className="fill-emerald-50 dark:fill-emerald-500/10" />
      {/* shelf */}
      <rect x="250" y="70" width="60" height="4" rx="2" fill="#A7F3D0" />
      <rect x="258" y="48" width="10" height="22" rx="3" fill="#6EE7B7" />
      <rect x="272" y="42" width="10" height="28" rx="3" fill="#A7F3D0" />
      <rect x="286" y="56" width="14" height="14" rx="3" fill="#D1FAE5" />
      {/* counter */}
      <rect
        x="40"
        y="206"
        width="290"
        height="5"
        rx="2.5"
        className="fill-slate-900 dark:fill-slate-600"
      />
      {/* monitor */}
      <rect x="62" y="118" width="96" height="70" rx="10" fill="#059669" />
      <rect
        x="70"
        y="126"
        width="80"
        height="54"
        rx="5"
        className="fill-white dark:fill-slate-200"
      />
      <path
        d="M100 158 h20 v6 h-20z M98 150 a6 6 0 0 1 4-10 a8 8 0 0 1 16 0 a6 6 0 0 1 4 10z"
        fill="none"
        stroke="#059669"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <rect x="104" y="188" width="12" height="12" fill="#047857" />
      <rect x="88" y="200" width="44" height="6" rx="3" fill="#047857" />
      {/* chef body */}
      <path
        d="M150 206 C 150 160, 168 140, 196 140 C 224 140, 242 160, 242 206 Z"
        className="fill-white stroke-slate-200 dark:fill-slate-200 dark:stroke-slate-400"
        strokeWidth="2"
      />
      <path d="M182 142 L196 160 L210 142" fill="#059669" />
      <circle cx="196" cy="172" r="2.5" fill="#0F172A" />
      <circle cx="196" cy="186" r="2.5" fill="#0F172A" />
      <circle cx="210" cy="172" r="2.5" fill="#0F172A" />
      <circle cx="210" cy="186" r="2.5" fill="#0F172A" />
      {/* head */}
      <rect x="188" y="124" width="16" height="18" rx="4" fill="#F5B98A" />
      <circle cx="196" cy="108" r="22" fill="#F8C9A0" />
      <path d="M174 104 C 176 88, 216 88, 218 104 C 210 98, 182 98, 174 104 Z" fill="#1E293B" />
      <circle cx="188" cy="110" r="2.2" fill="#1E293B" />
      <circle cx="204" cy="110" r="2.2" fill="#1E293B" />
      <path
        d="M189 119 Q196 125 203 119"
        fill="none"
        stroke="#9A3412"
        strokeWidth="2"
        strokeLinecap="round"
      />
      {/* hat */}
      <rect
        x="178"
        y="80"
        width="36"
        height="12"
        rx="3"
        className="fill-white stroke-slate-200 dark:fill-slate-200 dark:stroke-slate-400"
        strokeWidth="2"
      />
      <path
        d="M176 82 C 166 70, 178 54, 190 60 C 194 48, 210 50, 210 60 C 222 54, 230 72, 216 82 Z"
        className="fill-white stroke-slate-200 dark:fill-slate-200 dark:stroke-slate-400"
        strokeWidth="2"
      />
      {/* OK hand */}
      <path
        d="M238 168 C 248 156, 250 140, 248 130"
        fill="none"
        className="stroke-white dark:stroke-slate-200"
        strokeWidth="14"
        strokeLinecap="round"
      />
      <circle cx="248" cy="124" r="9" fill="#F8C9A0" />
      <circle cx="246" cy="122" r="3.5" fill="none" stroke="#C2410C" strokeWidth="1.5" />
      <path
        d="M252 116 l3 -9 M256 119 l5 -7 M257 124 l6 -4"
        stroke="#F8C9A0"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      {/* cloche */}
      <path d="M262 204 C 262 176, 314 176, 314 204 Z" fill="#94A3B8" />
      <path
        d="M268 200 C 270 184, 290 180, 300 186"
        fill="none"
        stroke="#CBD5E1"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <circle cx="288" cy="174" r="4" fill="#64748B" />
      <rect x="256" y="203" width="64" height="4" rx="2" fill="#64748B" />
      <path
        d="M296 160 c -6 -8 6 -12 0 -22 M306 164 c -5 -7 5 -10 0 -18"
        fill="none"
        stroke="#CBD5E1"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      {/* sparkles */}
      <path
        d="M58 98 l8 4 M54 112 l9 0 M118 88 l4 8"
        stroke="#34D399"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
