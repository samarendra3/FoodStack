'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import {
  Armchair,
  ArrowRight,
  BarChart3,
  CalendarDays,
  ChevronDown,
  ClipboardList,
  Coins,
  Flame,
  LayoutGrid,
  type LucideIcon,
  NotebookText,
  Plus,
  ShoppingCart,
  UserPlus,
  UsersRound,
  Zap,
} from 'lucide-react';
import { motion } from 'motion/react';
import Link from 'next/link';
import { type ReactNode, useState } from 'react';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { canAccessPath, hasPermissionAnywhere } from '@/lib/auth/access';
import { authErrorMessage } from '@/lib/auth/errors';
import { useEntitlement } from '@/lib/billing';
import { useRestaurantOverview } from '../overview';

const ease = [0.22, 1, 0.36, 1] as const;
const card =
  'rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.05)] dark:border-white/10 dark:bg-[#101C18]';
const fullDate = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});
const pillDate = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

const rise = (i: number) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.45, delay: 0.04 + i * 0.05, ease },
});

interface TeamSummary {
  members: { status: 'active' | 'invited' | 'suspended' }[];
}

export default function RestaurantDashboardPage() {
  const { client } = useAuth();
  const profile = useProfile();
  const overview = useRestaurantOverview();
  const canSeeTeam = hasPermissionAnywhere(profile, 'member:read');
  const team = useQuery({
    queryKey: ['restaurant', 'team', profile.activeTenant?.id],
    queryFn: () => client.request<TeamSummary>('/team'),
    enabled: canSeeTeam,
  });
  const members = team.data?.members;
  const activeMembers = members?.filter((m) => m.status === 'active').length;
  const invited = members?.filter((m) => m.status === 'invited').length ?? 0;

  return (
    <div className="mx-auto max-w-[96rem] space-y-5">
      <Welcome />
      <TrialCard />

      {overview.isError ? (
        <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {authErrorMessage(overview.error)}
        </p>
      ) : null}

      {/* Figures row (design order). Order, table and sales figures appear when those modules
          record data; until then they say so instead of showing invented numbers. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          i={0}
          icon={Coins}
          tone="emerald"
          label="Total Revenue"
          empty="Starts with your first bill"
        />
        <StatCard
          i={1}
          icon={ShoppingCart}
          tone="violet"
          label="Total Orders"
          empty="Starts with your first order"
        />
        <StatCard
          i={2}
          icon={Armchair}
          tone="orange"
          label="Active Tables"
          empty="Available with floor plans"
        />
        <StatCard
          i={3}
          icon={UsersRound}
          tone="blue"
          label="Team Members"
          value={canSeeTeam ? activeMembers : undefined}
          note={
            canSeeTeam
              ? invited
                ? `${invited} invitation${invited === 1 ? '' : 's'} pending`
                : 'Everyone has joined'
              : undefined
          }
          empty={canSeeTeam ? undefined : 'Needs team access'}
          href={canSeeTeam ? '/restaurant/team' : undefined}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 2xl:grid-cols-[minmax(0,2.1fr)_minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="min-w-0 lg:col-span-2 2xl:col-span-1">
          <RevenueOverview />
        </div>
        <div className="min-w-0">
          <OrderStatus />
        </div>
        <div className="min-w-0">
          <QuickActions />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,0.95fr)]">
        <div className="min-w-0">
          <TopSelling />
        </div>
        <div className="min-w-0">
          <RecentOrders />
        </div>
        <div className="min-w-0 lg:col-span-2 2xl:col-span-1">
          <TableOccupancy />
        </div>
      </div>
    </div>
  );
}

function Welcome() {
  const profile = useProfile();
  const today = new Date();
  const restaurant = profile.activeTenant?.name ?? 'your restaurant';
  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease }}
      className="relative isolate overflow-hidden rounded-3xl bg-gradient-to-r from-white via-white to-emerald-50 px-5 py-6 sm:px-7 dark:from-[#0F1D18] dark:via-[#0F1D18] dark:to-emerald-950/40"
    >
      {/* Soft green hills behind the illustration, as in the design. */}
      <svg
        aria-hidden
        viewBox="0 0 700 220"
        preserveAspectRatio="none"
        className="absolute inset-y-0 right-0 -z-10 hidden h-full w-[55%] md:block"
      >
        <path
          d="M0 220 C 140 120, 260 40, 420 60 S 640 150, 700 120 L700 220 Z"
          className="fill-emerald-100/60 dark:fill-emerald-900/25"
        />
        <path
          d="M120 220 C 260 150, 380 110, 520 130 S 660 190, 700 180 L700 220 Z"
          className="fill-emerald-200/40 dark:fill-emerald-800/20"
        />
      </svg>
      <DishIllustration />

      <div className="relative max-w-2xl">
        <p className="text-sm text-slate-500 dark:text-slate-400">{fullDate.format(today)}</p>
        <h1 className="mt-1 text-[1.65rem] leading-tight font-bold tracking-tight sm:text-[2rem]">
          Welcome back,{' '}
          <span className="text-emerald-600 dark:text-emerald-400">{profile.user.fullName}!</span>{' '}
          <motion.span
            className="inline-block origin-[70%_70%]"
            animate={{ rotate: [0, 16, -8, 14, 0] }}
            transition={{ duration: 1.6, delay: 0.6 }}
            aria-hidden
          >
            👋
          </motion.span>
        </h1>
        <p className="mt-1.5 text-slate-600 dark:text-slate-300">
          Here&apos;s what&apos;s happening at{' '}
          <strong className="font-semibold text-slate-900 dark:text-white">{restaurant}</strong>{' '}
          today.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link
            href="/restaurant/branches"
            className="inline-flex items-center gap-2.5 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:border-emerald-300 dark:border-white/10 dark:bg-white/5"
          >
            <span className="size-2.5 rounded-full bg-emerald-500" aria-hidden />
            {restaurant}
            <ChevronDown className="size-4 text-slate-400" aria-hidden />
          </Link>
          <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium shadow-sm dark:border-white/10 dark:bg-white/5">
            <CalendarDays className="size-4 text-slate-500" aria-hidden />
            {pillDate.format(today)}
          </span>
        </div>
      </div>
    </motion.section>
  );
}

/** Decorative dish photo on the right of the welcome banner. */
function DishIllustration() {
  return (
    <motion.img
      src="/images/restaurant-dashboard-dish.png"
      alt=""
      aria-hidden
      className="pointer-events-none absolute top-1/2 right-4 -z-10 hidden h-[60%] max-w-[40%] w-auto -translate-y-1/2 object-contain drop-shadow-sm md:block lg:right-10"
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.9, ease }}
    />
  );
}

const TONES = {
  emerald: { tile: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15' },
  violet: { tile: 'bg-violet-50 text-violet-600 dark:bg-violet-500/15' },
  orange: { tile: 'bg-orange-50 text-orange-500 dark:bg-orange-500/15' },
  blue: { tile: 'bg-blue-50 text-blue-600 dark:bg-blue-500/15' },
};

function StatCard({
  i,
  icon: Icon,
  tone,
  label,
  value,
  note,
  empty,
  href,
}: {
  i: number;
  icon: LucideIcon;
  tone: keyof typeof TONES;
  label: string;
  value?: number;
  note?: string;
  /** Shown instead of a number when the figure does not exist yet. */
  empty?: string;
  href?: string;
}) {
  const t = TONES[tone];
  const loading = value === undefined && !empty;
  const body = (
    <motion.div
      {...rise(i)}
      className={cn(card, 'relative flex h-full items-center gap-4 overflow-hidden p-5')}
    >
      <span className={cn('flex size-14 shrink-0 items-center justify-center rounded-2xl', t.tile)}>
        <Icon className="size-7" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-600 dark:text-slate-300">{label}</p>
        {value !== undefined ? (
          <>
            <p className="mt-1 text-[1.75rem] leading-none font-bold tracking-tight tabular-nums">
              {value}
            </p>
            {note ? <p className="mt-1.5 truncate text-xs text-slate-500">{note}</p> : null}
          </>
        ) : loading ? (
          <div className="mt-2 h-7 w-14 animate-pulse rounded bg-slate-100 dark:bg-white/10" />
        ) : (
          <>
            <p className="mt-1 text-[1.75rem] leading-none font-bold text-slate-300 dark:text-slate-600">
              —
            </p>
            <p className="mt-1.5 truncate text-xs text-slate-500">{empty}</p>
          </>
        )}
      </div>
    </motion.div>
  );
  return href ? (
    <Link
      href={href}
      className="block rounded-2xl transition-transform hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
    >
      {body}
    </Link>
  ) : (
    body
  );
}

function CardHead({
  icon: Icon,
  title,
  subtitle,
  aside,
}: {
  icon?: LucideIcon;
  title: string;
  subtitle?: string;
  aside?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        {Icon ? <Icon className="mt-0.5 size-6 text-emerald-600" aria-hidden /> : null}
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          {subtitle ? <p className="text-sm text-slate-500">{subtitle}</p> : null}
        </div>
      </div>
      {aside}
    </div>
  );
}

function SoonLink({ label }: { label: string }) {
  return (
    <span
      title="Coming soon"
      className="inline-flex cursor-not-allowed items-center gap-1 text-sm font-semibold text-slate-400"
    >
      {label} <ArrowRight className="size-4" aria-hidden />
    </span>
  );
}

function EmptyNote({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15">
        <Icon className="size-5" aria-hidden />
      </span>
      <p className="mt-3 text-sm font-semibold">{title}</p>
      <p className="mt-1 max-w-xs text-xs text-slate-500">{text}</p>
    </div>
  );
}

const RANGES = {
  Today: [
    '9 AM',
    '10 AM',
    '11 AM',
    '12 PM',
    '1 PM',
    '2 PM',
    '3 PM',
    '4 PM',
    '5 PM',
    '6 PM',
    '7 PM',
    '8 PM',
    '9 PM',
  ],
  'This Week': ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  'This Month': ['Week 1', 'Week 2', 'Week 3', 'Week 4'],
  'This Year': ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
} as const;
type Range = keyof typeof RANGES;

function RevenueOverview() {
  const [range, setRange] = useState<Range>('Today');
  const labels = RANGES[range];
  return (
    <motion.section {...rise(4)} className={cn(card, 'h-full p-5')}>
      <CardHead
        icon={BarChart3}
        title="Revenue Overview"
        subtitle="Track your sales, orders and growth."
        aside={
          <div className="flex w-full overflow-x-auto rounded-xl border border-slate-200 p-1 text-sm [scrollbar-width:none] sm:w-auto dark:border-white/10">
            {(Object.keys(RANGES) as Range[]).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                aria-pressed={range === r}
                className={cn(
                  'relative isolate rounded-lg px-2.5 py-1 font-medium whitespace-nowrap transition-colors sm:px-3',
                  range === r
                    ? 'text-white'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-300',
                )}
              >
                {range === r ? (
                  <motion.span
                    layoutId="revenue-range"
                    className="absolute inset-0 -z-10 rounded-lg bg-emerald-600"
                    transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  />
                ) : null}
                {r}
              </button>
            ))}
          </div>
        }
      />
      <div className="relative mt-5 h-60">
        {/* Empty chart frame: grid and time axis, no values until sales exist. */}
        <div className="absolute inset-x-0 top-0 bottom-7 flex flex-col justify-between">
          {Array.from({ length: 6 }, (_, k) => (
            <span
              key={k}
              className="border-t border-dashed border-slate-200 dark:border-white/10"
            />
          ))}
        </div>
        <div className="absolute inset-x-0 bottom-0 flex justify-between text-[11px] text-slate-400">
          {labels.map((l, k) => (
            <span key={l} className={cn(labels.length > 8 && k % 2 === 1 && 'hidden sm:inline')}>
              {l}
            </span>
          ))}
        </div>
        <div className="absolute inset-x-0 top-0 bottom-7 flex items-center justify-center">
          <div className="rounded-2xl bg-white/90 dark:bg-[#101C18]/90">
            <EmptyNote
              icon={BarChart3}
              title={`No sales recorded ${range === 'Today' ? 'today' : range.toLowerCase()}`}
              text="Revenue appears here as soon as orders are billed at the POS."
            />
          </div>
        </div>
      </div>
    </motion.section>
  );
}

function Donut({ center, caption }: { center: string; caption: string }) {
  return (
    <div className="relative size-40 shrink-0">
      <svg viewBox="0 0 140 140" className="size-full -rotate-90">
        <circle
          cx="70"
          cy="70"
          r="52"
          fill="none"
          stroke="currentColor"
          strokeWidth="18"
          className="text-slate-100 dark:text-white/10"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold text-slate-300 tabular-nums dark:text-slate-600">
          {center}
        </span>
        <span className="text-sm text-slate-500">{caption}</span>
      </div>
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="w-full space-y-3 text-sm">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-2.5">
          <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: it.color }} />
          <span className="flex-1 text-slate-600 dark:text-slate-300">{it.label}</span>
          <span className="font-semibold text-slate-300 tabular-nums dark:text-slate-600">—</span>
        </li>
      ))}
    </ul>
  );
}

function OrderStatus() {
  return (
    <motion.section {...rise(5)} className={cn(card, 'h-full p-5')}>
      <CardHead title="Order Status" />
      <div className="mt-5 flex flex-col items-center gap-5 sm:flex-row lg:flex-col xl:flex-row 2xl:flex-col">
        <Donut center="—" caption="Orders" />
        <Legend
          items={[
            { label: 'Completed', color: '#10B981' },
            { label: 'Preparing', color: '#F59E0B' },
            { label: 'Pending', color: '#3B82F6' },
            { label: 'Cancelled', color: '#94A3B8' },
          ]}
        />
      </div>
      <p className="mt-4 text-center text-xs text-slate-500">Live once the POS takes orders.</p>
    </motion.section>
  );
}

function QuickActions() {
  const profile = useProfile();
  const actions: { label: string; icon: LucideIcon; href?: string }[] = [
    { label: 'New Order', icon: Plus, href: canAccessPath(profile, '/pos') ? '/pos' : undefined },
    { label: 'Add Table', icon: Armchair },
    { label: 'Add Item', icon: NotebookText },
    {
      label: 'Add Staff',
      icon: UserPlus,
      href: hasPermissionAnywhere(profile, 'member:invite') ? '/restaurant/team' : undefined,
    },
  ];
  return (
    <motion.section {...rise(6)} className={cn(card, 'h-full p-5')}>
      <CardHead icon={Zap} title="Quick Actions" />
      <div className="mt-4 grid grid-cols-2 gap-3">
        {actions.map((a) => {
          const inner = (
            <>
              <a.icon className="size-7" strokeWidth={1.75} aria-hidden />
              <span className="text-sm font-medium">{a.label}</span>
              {!a.href ? (
                <span className="absolute top-2 right-2 rounded-full bg-slate-200/70 px-1.5 py-0.5 text-[9px] font-semibold text-slate-500 uppercase dark:bg-white/10">
                  Soon
                </span>
              ) : null}
            </>
          );
          const base =
            'relative flex min-h-24 flex-col items-center justify-center gap-2 rounded-2xl p-3 text-center transition-all';
          return a.href ? (
            <Link
              key={a.label}
              href={a.href}
              className={cn(
                base,
                'bg-emerald-50 text-emerald-700 hover:-translate-y-0.5 hover:bg-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-300',
              )}
            >
              {inner}
            </Link>
          ) : (
            <span
              key={a.label}
              aria-disabled="true"
              className={cn(base, 'cursor-not-allowed bg-slate-50 text-slate-400 dark:bg-white/5')}
            >
              {inner}
            </span>
          );
        })}
      </div>
    </motion.section>
  );
}

function TopSelling() {
  return (
    <motion.section {...rise(7)} className={cn(card, 'h-full p-5')}>
      <CardHead
        icon={Flame}
        title="Top Selling Items"
        aside={
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-500 dark:border-white/10">
            This Month <ChevronDown className="size-4" aria-hidden />
          </span>
        }
      />
      <EmptyNote
        icon={Flame}
        title="No best sellers yet"
        text="Your most-ordered dishes rank here once orders come in from your menu."
      />
    </motion.section>
  );
}

function RecentOrders() {
  return (
    <motion.section {...rise(8)} className={cn(card, 'h-full p-5')}>
      <CardHead icon={ClipboardList} title="Recent Orders" aside={<SoonLink label="View All" />} />
      <div className="mt-4 overflow-x-auto rounded-xl border border-slate-100 dark:border-white/10">
        <table className="w-full min-w-[30rem] text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-600 dark:bg-white/5 dark:text-slate-300">
            <tr>
              <th className="px-4 py-2.5">Order ID</th>
              <th className="px-4 py-2.5">Table</th>
              <th className="px-4 py-2.5">Customer</th>
              <th className="px-4 py-2.5 text-right">Amount</th>
              <th className="px-4 py-2.5">Status</th>
            </tr>
          </thead>
        </table>
      </div>
      <EmptyNote
        icon={ClipboardList}
        title="No orders yet"
        text="Orders taken at the POS or by waiters will be listed here."
      />
    </motion.section>
  );
}

function TableOccupancy() {
  return (
    <motion.section {...rise(9)} className={cn(card, 'h-full p-5')}>
      <CardHead
        icon={LayoutGrid}
        title="Table Occupancy"
        aside={<SoonLink label="View Floor Plan" />}
      />
      <div className="mt-5 flex flex-col items-center gap-6 sm:flex-row">
        <Donut center="—" caption="Tables" />
        <Legend
          items={[
            { label: 'Occupied', color: '#10B981' },
            { label: 'Available', color: '#6EE7B7' },
            { label: 'Reserved', color: '#94A3B8' },
          ]}
        />
      </div>
      <p className="mt-4 text-center text-xs text-slate-500">
        Set up floors and tables to see live occupancy.
      </p>
    </motion.section>
  );
}

/** Remaining free-trial days, with the end date and a link to the plans. */
function TrialCard() {
  const ent = useEntitlement();
  const e = ent.data;
  if (!e?.isTrial || !e.trialEndsAt) return null;
  // Share of the trial used, from the server's remaining-day count (no clock reads in render).
  const total = e.trialStartedAt
    ? Math.max(
        1,
        Math.round(
          (new Date(e.trialEndsAt).getTime() - new Date(e.trialStartedAt).getTime()) / 86_400_000,
        ),
      )
    : 15;
  const used = Math.min(1, Math.max(0, 1 - e.remainingDays / total));
  const soon = e.remainingDays <= 3;
  return (
    <section className={cn(card, 'flex flex-col gap-4 p-5 sm:flex-row sm:items-center')}>
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            'text-4xl font-bold tabular-nums',
            soon ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400',
          )}
        >
          {e.remainingDays}
        </span>
        <span className="text-sm text-muted-foreground">
          day{e.remainingDays === 1 ? '' : 's'} left in your free trial
        </span>
      </div>
      <div className="flex-1 space-y-1.5">
        <div
          className="h-2 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label="Free trial used"
          aria-valuenow={Math.round(used * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={cn('h-full rounded-full', soon ? 'bg-red-500' : 'bg-emerald-500')}
            style={{ width: `${Math.round(used * 100)}%` }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Trial ends {pillDate.format(new Date(e.trialEndsAt))} · 1 branch included
        </p>
      </div>
      {e.canManage ? (
        <Link
          href="/restaurant/profile#subscription"
          className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
        >
          View plans <ArrowRight className="size-4" />
        </Link>
      ) : null}
    </section>
  );
}
