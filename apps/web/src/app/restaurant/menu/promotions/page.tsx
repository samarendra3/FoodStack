'use client';

import { buttonVariants } from '@foodstack/ui/components/button';
import { cn } from '@foodstack/ui/lib/utils';
import {
  BadgePercent,
  CalendarClock,
  CirclePause,
  Plus,
  Search,
  Ticket,
  TimerOff,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { authErrorMessage } from '@/lib/auth/errors';
import { formatMoney, useMenu } from '@/lib/menu';
import { describeOffer, type PromotionState, STATE_STYLE, usePromotions } from '@/lib/promotions';
import { MenuTabs } from '../menu-tabs';
import { scheduleText } from './schedule-text';

export default function PromotionsPage() {
  const list = usePromotions();
  const menu = useMenu();
  const [state, setState] = useState<PromotionState | 'all'>('all');
  const [query, setQuery] = useState('');
  const money = (m: number) => formatMoney(m, menu.data?.restaurant.currencyCode ?? 'INR');
  const all = list.data?.promotions ?? [];
  const q = query.trim().toLowerCase();
  const shown = all.filter(
    (p) =>
      (state === 'all' || p.state === state) &&
      (!q || p.name.toLowerCase().includes(q) || p.couponCode?.toLowerCase().includes(q)),
  );
  const count = (s: PromotionState) => all.filter((p) => p.state === s).length;

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Menu</h1>
          <p className="text-sm text-muted-foreground">
            Discounts, happy hours and coupon codes. Prices are always calculated on the server.
          </p>
        </div>
        {list.data?.canManage ? (
          <Link href="/restaurant/menu/promotions/new" className={buttonVariants()}>
            <Plus aria-hidden /> New promotion
          </Link>
        ) : null}
      </div>
      <MenuTabs />

      {list.isError ? (
        <p
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700"
        >
          {authErrorMessage(list.error)}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Stat
          icon={BadgePercent}
          tone="bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15"
          label="Active"
          value={count('active')}
          onClick={() => setState('active')}
        />
        <Stat
          icon={CalendarClock}
          tone="bg-sky-100 text-sky-600 dark:bg-sky-500/15"
          label="Scheduled"
          value={count('scheduled')}
          onClick={() => setState('scheduled')}
        />
        <Stat
          icon={CirclePause}
          tone="bg-amber-100 text-amber-600 dark:bg-amber-500/15"
          label="Paused"
          value={count('paused')}
          onClick={() => setState('paused')}
        />
        <Stat
          icon={TimerOff}
          tone="bg-slate-100 text-slate-600 dark:bg-white/10"
          label="Expired"
          value={count('expired')}
          onClick={() => setState('expired')}
        />
      </div>

      {list.isPending ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      ) : all.length === 0 ? (
        <div className="flex flex-col items-center rounded-2xl border bg-card px-6 py-16 text-center">
          <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <BadgePercent className="size-6" />
          </span>
          <h2 className="mt-4 text-lg font-semibold">No promotions yet</h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Create a percentage or flat discount, a buy-one-get-one, a happy hour or a coupon code.
          </p>
          {list.data?.canManage ? (
            <Link href="/restaurant/menu/promotions/new" className={cn(buttonVariants(), 'mt-5')}>
              <Plus aria-hidden /> Create first promotion
            </Link>
          ) : null}
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border bg-card">
          <div className="flex flex-col gap-3 border-b p-3 sm:flex-row sm:items-center">
            <label className="relative flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <span className="sr-only">Search promotions</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name or code"
                className="h-9 w-full rounded-lg border bg-background pr-3 pl-9 text-sm outline-none focus-visible:border-primary"
              />
            </label>
            <div className="flex gap-1 overflow-x-auto" role="tablist">
              {(['all', 'active', 'scheduled', 'paused', 'expired'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="tab"
                  aria-selected={state === s}
                  onClick={() => setState(s)}
                  className={cn(
                    'h-9 shrink-0 rounded-lg px-3 text-sm font-medium capitalize',
                    state === s
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted',
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          {shown.length === 0 ? (
            <p className="py-14 text-center text-sm text-muted-foreground">No promotions match.</p>
          ) : (
            <ul className="divide-y">
              {shown.map((p) => (
                <li key={p.id}>
                  <Link
                    href={`/restaurant/menu/promotions/${p.id}`}
                    className="flex flex-col gap-2 px-4 py-3.5 hover:bg-muted/40 sm:flex-row sm:items-center sm:gap-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">{p.name}</p>
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-xs font-semibold',
                            STATE_STYLE[p.state].cls,
                          )}
                        >
                          {STATE_STYLE[p.state].label}
                        </span>
                        {p.couponCode ? (
                          <span className="flex items-center gap-1 rounded-md border border-dashed px-1.5 py-0.5 font-mono text-xs">
                            <Ticket className="size-3" />
                            {p.couponCode}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 text-sm text-primary">{describeOffer(p, money)}</p>
                    </div>
                    <p className="text-xs text-muted-foreground sm:w-64 sm:text-right">
                      {scheduleText(p)}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Stat(p: {
  icon: typeof Plus;
  tone: string;
  label: string;
  value: number;
  onClick: () => void;
}) {
  const Icon = p.icon;
  return (
    <button
      type="button"
      onClick={p.onClick}
      className="flex items-center gap-3 rounded-2xl border bg-card p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-sm"
    >
      <span className={cn('flex size-11 items-center justify-center rounded-xl', p.tone)}>
        <Icon className="size-5" />
      </span>
      <div>
        <p className="text-2xl font-bold tabular-nums">{p.value}</p>
        <p className="text-sm text-muted-foreground">{p.label}</p>
      </div>
    </button>
  );
}
