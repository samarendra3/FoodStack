'use client';

import { buttonVariants } from '@foodstack/ui/components/button';
import { cn } from '@foodstack/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { BadgePercent, CalendarClock, CirclePause, Plus, Ticket, TimerOff } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { type Column, DataTable } from '@/components/data-table/data-table';
import { formatMoney, useMenuCategories } from '@/lib/menu';
import { usePagedList } from '@/lib/paged';
import {
  describeOffer,
  type Promotion,
  type PromotionState,
  STATE_STYLE,
  TYPE_LABEL,
} from '@/lib/promotions';
import { MenuTabs } from '../menu-tabs';
import { scheduleText } from './schedule-text';

interface Summary {
  counts: Record<PromotionState, number>;
  canManage: boolean;
}

export default function PromotionsPage() {
  const { client } = useAuth();
  const profile = useProfile();
  const router = useRouter();
  const cats = useMenuCategories();
  const summary = useQuery({
    queryKey: ['promotions', profile.activeTenant?.id, 'summary'],
    queryFn: () => client.request<Summary>('/promotions/summary'),
  });
  const list = usePagedList<Promotion>('promotions', '/promotions', {
    sortBy: 'createdAt',
    filters: { state: '', type: '', coupon: '' },
  });
  const money = (m: number) => formatMoney(m, cats.data?.restaurant.currencyCode ?? 'INR');
  const canManage = summary.data?.canManage ?? false;

  const columns: Column<Promotion>[] = [
    {
      key: 'name',
      header: 'Promotion',
      sortKey: 'name',
      cell: (p) => (
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{p.name}</span>
            {p.couponCode ? (
              <span className="flex items-center gap-1 rounded-md border border-dashed px-1.5 py-0.5 font-mono text-xs">
                <Ticket className="size-3" />
                {p.couponCode}
              </span>
            ) : null}
          </div>
          <p className="text-sm text-primary">{describeOffer(p, money)}</p>
        </div>
      ),
    },
    { key: 'type', header: 'Type', hideOnMobile: true, cell: (p) => TYPE_LABEL[p.type] },
    {
      key: 'schedule',
      header: 'When',
      sortKey: 'startsAt',
      hideOnMobile: true,
      cell: (p) => <span className="text-xs text-muted-foreground">{scheduleText(p)}</span>,
    },
    {
      key: 'state',
      header: 'Status',
      cell: (p) => (
        <span
          className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', STATE_STYLE[p.state].cls)}
        >
          {STATE_STYLE[p.state].label}
        </span>
      ),
    },
  ];

  const stat = (state: PromotionState, label: string, icon: typeof Plus, tone: string) => {
    const Icon = icon;
    return (
      <button
        type="button"
        onClick={() => list.update({ filters: { state } })}
        className="flex items-center gap-3 rounded-2xl border bg-card p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-sm"
      >
        <span className={cn('flex size-11 items-center justify-center rounded-xl', tone)}>
          <Icon className="size-5" />
        </span>
        <div>
          <p className="text-2xl font-bold tabular-nums">{summary.data?.counts[state] ?? '—'}</p>
          <p className="text-sm text-muted-foreground">{label}</p>
        </div>
      </button>
    );
  };

  const newButton = (
    <Link href="/restaurant/menu/promotions/new" className={buttonVariants()}>
      <Plus aria-hidden /> New promotion
    </Link>
  );

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Menu</h1>
          <p className="text-sm text-muted-foreground">
            Discounts, happy hours and coupon codes. Prices are always calculated on the server.
          </p>
        </div>
        {canManage ? newButton : null}
      </div>
      <MenuTabs />

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {stat(
          'active',
          'Active',
          BadgePercent,
          'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15',
        )}
        {stat(
          'scheduled',
          'Scheduled',
          CalendarClock,
          'bg-sky-100 text-sky-600 dark:bg-sky-500/15',
        )}
        {stat('paused', 'Paused', CirclePause, 'bg-amber-100 text-amber-600 dark:bg-amber-500/15')}
        {stat('expired', 'Expired', TimerOff, 'bg-slate-100 text-slate-600 dark:bg-white/10')}
      </div>

      <DataTable
        list={list}
        columns={columns}
        getRowId={(p) => p.id}
        onRowClick={(p) => router.push(`/restaurant/menu/promotions/${p.id}`)}
        searchPlaceholder="Search name or coupon code"
        filters={[
          {
            key: 'state',
            label: 'Status',
            options: (Object.keys(STATE_STYLE) as PromotionState[]).map((s) => ({
              value: s,
              label: STATE_STYLE[s].label,
            })),
          },
          {
            key: 'type',
            label: 'Type',
            options: Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label })),
          },
          {
            key: 'coupon',
            label: 'Coupon',
            options: [
              { value: 'yes', label: 'With coupon code' },
              { value: 'no', label: 'Automatic' },
            ],
          },
        ]}
        empty={{
          title: 'No promotions yet',
          description:
            'Create a percentage or flat discount, a buy-one-get-one, a happy hour or a coupon code.',
          action: canManage ? newButton : undefined,
        }}
      />
    </div>
  );
}
