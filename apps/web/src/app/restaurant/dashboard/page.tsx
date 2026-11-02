'use client';

import { cn } from '@foodstack/ui/lib/utils';
import {
  ArrowRight,
  BarChart3,
  Building2,
  ChefHat,
  ClipboardList,
  ConciergeBell,
  Banknote,
  type LucideIcon,
  MapPin,
  MonitorSmartphone,
  PieChart,
  Receipt,
  UserPlus,
  UsersRound,
} from 'lucide-react';
import { motion } from 'motion/react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useProfile } from '@/components/auth/auth-provider';
import { canAccessPath, hasPermissionAnywhere } from '@/lib/auth/access';
import { authErrorMessage } from '@/lib/auth/errors';
import { roleLabel } from '@/lib/auth/roles';
import { trialDaysLeft, useRestaurantOverview } from '../overview';

const ease = [0.22, 1, 0.36, 1] as const;
const card = 'rounded-xl border border-[#E2E8F0] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]';
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

export default function RestaurantDashboardPage() {
  const profile = useProfile();
  const overview = useRestaurantOverview();
  const data = overview.data;
  const firstName = profile.user.fullName.split(' ')[0];
  const daysLeft = data ? trialDaysLeft(data.tenant) : null;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      {/* Welcome */}
      <motion.section
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease }}
        className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"
      >
        <div>
          <p className="text-sm text-[#64748B]">{greeting()},</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{firstName}</h1>
          <p className="mt-1 text-sm text-[#64748B]">
            {profile.activeTenant?.name}
            {profile.roles.length ? ` · ${profile.roles.map(roleLabel).join(', ')}` : ''}
          </p>
        </div>
        {data?.tenant ? (
          <PlanBadge
            status={data.tenant.status}
            daysLeft={daysLeft}
            trialEndsAt={data.tenant.trialEndsAt}
          />
        ) : null}
      </motion.section>

      {overview.isError ? (
        <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {authErrorMessage(overview.error)}
        </p>
      ) : null}

      {/* Key figures */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          index={0}
          icon={Building2}
          label="Branches"
          value={data ? String(data.branches.length) : null}
          hint={
            data
              ? `${data.restaurants.length} restaurant${data.restaurants.length === 1 ? '' : 's'}`
              : undefined
          }
          href="/restaurant/branches"
        />
        <Metric
          index={1}
          icon={UsersRound}
          label="Active team members"
          value={data ? (data.activeMembers === null ? null : String(data.activeMembers)) : null}
          unavailable={data?.activeMembers === null ? 'Needs team access' : undefined}
          hint="Signed-up and not suspended"
          href={hasPermissionAnywhere(profile, 'member:read') ? '/restaurant/team' : undefined}
          loading={!data}
        />
        <Metric
          index={2}
          icon={ClipboardList}
          label="Today's orders"
          unavailable="Available with the POS"
          value={null}
        />
        <Metric
          index={3}
          icon={Banknote}
          label="Today's revenue"
          unavailable="Available with billing"
          value={null}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        {/* Left column */}
        <div className="order-2 space-y-6 xl:order-1 xl:col-span-2">
          <Panel
            title="Sales overview"
            description="Revenue and order trends by day."
            icon={BarChart3}
          >
            <Empty
              icon={BarChart3}
              title="No sales data yet"
              text="Sales charts appear here once orders are taken and billed through the POS."
            />
          </Panel>
          <Panel
            title="Recent orders"
            description="The latest orders across your branches."
            icon={Receipt}
          >
            <Empty
              icon={Receipt}
              title="No orders yet"
              text="Orders taken at the POS or by waiters will be listed here."
            />
          </Panel>
        </div>

        {/* Right column */}
        <div className="order-1 space-y-6 xl:order-2">
          <QuickActions />
          <Panel title="Branch overview" description="Locations you can work in." icon={MapPin}>
            {!data ? (
              <div className="space-y-2 p-4" aria-hidden>
                {Array.from({ length: 2 }, (_, i) => (
                  <div key={i} className="h-12 animate-pulse rounded-lg bg-slate-100" />
                ))}
              </div>
            ) : data.branches.length === 0 ? (
              <Empty
                icon={MapPin}
                title="No branches"
                text="You have not been given a branch yet."
              />
            ) : (
              <ul className="divide-y divide-[#E2E8F0]">
                {data.branches.slice(0, 5).map((b) => (
                  <li key={b.id} className="flex items-center gap-3 px-4 py-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-[#64748B]">
                      <Building2 className="size-4" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{b.name}</p>
                      <p className="truncate text-xs text-[#64748B]">
                        {data.restaurants.find((r) => r.id === b.restaurantId)?.name} · {b.code}
                      </p>
                    </div>
                    <span className="size-2 rounded-full bg-[#059669]" title="Active" />
                  </li>
                ))}
                {data.branches.length > 5 ? (
                  <li className="px-4 py-2.5">
                    <Link
                      href="/restaurant/branches"
                      className="text-sm font-medium text-[#059669] hover:text-[#047857]"
                    >
                      View all {data.branches.length} branches
                    </Link>
                  </li>
                ) : null}
              </ul>
            )}
          </Panel>
          <Panel
            title="Order status"
            description="Open, preparing, served and paid."
            icon={PieChart}
          >
            <Empty
              icon={PieChart}
              title="Nothing to show yet"
              text="Live order status appears once the POS and kitchen display are in use."
            />
          </Panel>
        </div>
      </div>
      {data?.tenant?.trialEndsAt && daysLeft !== null ? (
        <p className="text-xs text-[#64748B]">
          Your free trial ends on {dateFormat.format(new Date(data.tenant.trialEndsAt))}.
        </p>
      ) : null}
    </div>
  );
}

function PlanBadge({
  status,
  daysLeft,
  trialEndsAt,
}: {
  status: string;
  daysLeft: number | null;
  trialEndsAt: string | null;
}) {
  if (status === 'trial') {
    const urgent = daysLeft !== null && daysLeft <= 3;
    return (
      <div
        className={cn(
          'flex w-fit items-center gap-3 rounded-xl border px-4 py-2.5',
          urgent ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50',
        )}
      >
        <span className={cn('size-2 rounded-full', urgent ? 'bg-amber-500' : 'bg-[#059669]')} />
        <div className="text-sm">
          <p className={cn('font-semibold', urgent ? 'text-amber-800' : 'text-[#047857]')}>
            Free trial
          </p>
          <p className="text-xs text-[#64748B]">
            {daysLeft === null
              ? trialEndsAt
                ? `Ends ${dateFormat.format(new Date(trialEndsAt))}`
                : 'Trial active'
              : daysLeft === 0
                ? 'Ends today'
                : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`}
          </p>
        </div>
      </div>
    );
  }
  return (
    <span className="w-fit rounded-full border border-[#E2E8F0] bg-white px-3 py-1 text-sm font-medium capitalize">
      {status}
    </span>
  );
}

function Metric({
  index,
  icon: Icon,
  label,
  value,
  hint,
  unavailable,
  href,
  loading,
}: {
  index: number;
  icon: LucideIcon;
  label: string;
  value: string | null;
  hint?: string;
  /** Shown instead of a number when the figure does not exist yet (never a fake 0). */
  unavailable?: string;
  href?: string;
  loading?: boolean;
}) {
  const body = (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.05 + index * 0.06, ease }}
      className={cn(
        card,
        'flex h-full flex-col p-5 transition-shadow',
        href && 'hover:shadow-[0_4px_14px_-6px_rgba(15,23,42,0.14)]',
      )}
    >
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-[#64748B]">{label}</p>
        <span
          className={cn(
            'flex size-9 items-center justify-center rounded-lg',
            unavailable ? 'bg-slate-100 text-slate-400' : 'bg-emerald-50 text-[#059669]',
          )}
        >
          <Icon className="size-[18px]" aria-hidden />
        </span>
      </div>
      {value !== null ? (
        <p className="mt-3 text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
      ) : unavailable && !loading ? (
        <p className="mt-3 text-sm font-medium text-slate-400">{unavailable}</p>
      ) : (
        <div className="mt-3 h-9 w-16 animate-pulse rounded bg-slate-100" aria-hidden />
      )}
      {hint && value !== null ? <p className="mt-1 text-xs text-[#64748B]">{hint}</p> : null}
    </motion.div>
  );
  return href ? (
    <Link
      href={href}
      className="block rounded-xl focus-visible:ring-2 focus-visible:ring-[#059669]/50 focus-visible:outline-none"
    >
      {body}
    </Link>
  ) : (
    body
  );
}

function Panel({
  title,
  description,
  icon: Icon,
  children,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <section className={cn(card, 'overflow-hidden')}>
      <header className="flex items-center gap-3 border-b border-[#E2E8F0] px-4 py-3.5">
        <Icon className="size-[18px] text-[#64748B]" aria-hidden />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="truncate text-xs text-[#64748B]">{description}</p>
        </div>
      </header>
      {children}
    </section>
  );
}

function Empty({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-slate-100 text-slate-400">
        <Icon className="size-5" aria-hidden />
      </span>
      <p className="mt-3 text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-xs text-xs text-[#64748B]">{text}</p>
    </div>
  );
}

/** Shortcuts to things this person can actually do; nothing that leads to a missing page. */
function QuickActions() {
  const profile = useProfile();
  const actions: { label: string; href: string; icon: LucideIcon; show: boolean }[] = [
    {
      label: 'Invite a team member',
      href: '/restaurant/team',
      icon: UserPlus,
      show: hasPermissionAnywhere(profile, 'member:invite'),
    },
    {
      label: 'Open Point of Sale',
      href: '/pos',
      icon: MonitorSmartphone,
      show: canAccessPath(profile, '/pos'),
    },
    {
      label: 'Open Kitchen Display',
      href: '/kitchen',
      icon: ChefHat,
      show: canAccessPath(profile, '/kitchen'),
    },
    {
      label: 'Open Waiter app',
      href: '/waiter',
      icon: ConciergeBell,
      show: canAccessPath(profile, '/waiter'),
    },
    { label: 'View branches', href: '/restaurant/branches', icon: Building2, show: true },
  ];
  const visible = actions.filter((a) => a.show);
  return (
    <section className={cn(card, 'p-4')}>
      <h2 className="text-sm font-semibold">Quick actions</h2>
      <ul className="mt-3 space-y-1">
        {visible.map((a) => (
          <li key={a.href}>
            <Link
              href={a.href}
              className="group flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-slate-50"
            >
              <span className="flex size-8 items-center justify-center rounded-lg bg-emerald-50 text-[#059669]">
                <a.icon className="size-4" aria-hidden />
              </span>
              <span className="flex-1 font-medium">{a.label}</span>
              <ArrowRight
                className="size-4 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-[#059669]"
                aria-hidden
              />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
