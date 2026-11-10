'use client';

import { cn } from '@foodstack/ui/lib/utils';
import {
  Armchair,
  ArrowLeft,
  ClipboardList,
  CreditCard,
  LayoutDashboard,
  type LucideIcon,
  MapPin,
  Warehouse,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useProfile } from '@/components/auth/auth-provider';
import { hasPermissionAnywhere } from '@/lib/auth/access';
import { useRestaurantOverview } from '../../overview';

interface BranchNavItem {
  segment: string;
  label: string;
  icon: LucideIcon;
  anyPermission: readonly string[];
}

/** Side menu of a single branch. Each list page is filtered to this branch via `?branchId=`. */
const BRANCH_NAV: readonly BranchNavItem[] = [
  {
    segment: '',
    label: 'Overview',
    icon: LayoutDashboard,
    anyPermission: ['branch:read', 'branch:manage'],
  },
  { segment: 'tables', label: 'Tables', icon: Armchair, anyPermission: ['branch:read'] },
  { segment: 'orders', label: 'Orders', icon: ClipboardList, anyPermission: ['order:read'] },
  { segment: 'payments', label: 'Payments', icon: CreditCard, anyPermission: ['order:read'] },
  {
    segment: 'inventory',
    label: 'Inventory',
    icon: Warehouse,
    anyPermission: ['inventory:read', 'inventory:manage'],
  },
];

function branchHref(branchId: string, segment: string) {
  const base = `/restaurant/branches/${branchId}`;
  return segment ? `${base}/${segment}?branchId=${encodeURIComponent(branchId)}` : base;
}

export default function BranchLayout({ children }: { children: ReactNode }) {
  const { branchId } = useParams<{ branchId: string }>();
  const pathname = usePathname();
  const profile = useProfile();
  const overview = useRestaurantOverview();
  const branch = overview.data?.branches.find((b) => b.id === branchId);
  const restaurant = overview.data?.restaurants.find((r) => r.id === branch?.restaurantId);

  const items = BRANCH_NAV.filter((i) =>
    i.anyPermission.some((p) => hasPermissionAnywhere(profile, p)),
  );
  const base = `/restaurant/branches/${branchId}`;
  const isActive = (segment: string) =>
    segment ? pathname.startsWith(`${base}/${segment}`) : pathname === base;

  if (overview.isSuccess && !branch) {
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center dark:border-white/15 dark:bg-slate-900">
        <p className="font-medium text-slate-900 dark:text-white">Branch not found</p>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          It may have been removed, or you don&apos;t have access to it.
        </p>
        <Link
          href="/restaurant/branches"
          className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 hover:underline dark:text-emerald-400"
        >
          <ArrowLeft className="size-4" aria-hidden /> All branches
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[96rem] space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/restaurant/branches"
          aria-label="Back to branches"
          className="flex size-9 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-100 dark:border-white/10 dark:hover:bg-white/5"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <span className="flex size-9 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">
          <MapPin className="size-[18px]" aria-hidden />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight text-slate-900 dark:text-white">
            {branch?.name ?? (
              <span className="inline-block h-6 w-40 animate-pulse rounded bg-slate-200 dark:bg-white/10" />
            )}
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Branch admin{branch ? ` · Code ${branch.code}` : ''}
            {restaurant ? ` · ${restaurant.name}` : ''}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
        <nav
          aria-label="Branch"
          className="shrink-0 rounded-xl border border-slate-200 bg-white p-2 lg:sticky lg:top-20 lg:w-56 dark:border-white/10 dark:bg-slate-900"
        >
          <p className="hidden px-2.5 pt-1 pb-2 text-[11px] font-medium text-slate-500 lg:block">
            Branch menu
          </p>
          <ul className="flex gap-1 overflow-x-auto [scrollbar-width:none] lg:flex-col lg:gap-px">
            {items.map((item) => {
              const active = isActive(item.segment);
              const Icon = item.icon;
              return (
                <li key={item.label} className="shrink-0">
                  <Link
                    href={branchHref(branchId, item.segment)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm whitespace-nowrap transition-colors',
                      active
                        ? 'bg-emerald-50 font-medium text-emerald-700 ring-1 ring-emerald-100 dark:bg-white/[0.08] dark:text-white dark:ring-white/[0.06]'
                        : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/[0.04] dark:hover:text-slate-100',
                    )}
                  >
                    <Icon
                      className={cn(
                        'size-4 shrink-0',
                        active ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400',
                      )}
                      aria-hidden
                    />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
