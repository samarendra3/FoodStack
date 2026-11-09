'use client';

import { Clock, Coins, Hash, Store } from 'lucide-react';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useRestaurantOverview } from '../../overview';

export default function BranchOverviewPage() {
  const { branchId } = useParams<{ branchId: string }>();
  const overview = useRestaurantOverview();
  const branch = overview.data?.branches.find((b) => b.id === branchId);
  const restaurant = overview.data?.restaurants.find((r) => r.id === branch?.restaurantId);

  if (!branch) {
    return (
      <div className="h-48 animate-pulse rounded-xl border border-slate-200 bg-white dark:border-white/10 dark:bg-slate-900" />
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Stat icon={<Hash />} label="Branch code" value={branch.code} />
      <Stat icon={<Store />} label="Restaurant" value={restaurant?.name ?? '—'} />
      <Stat icon={<Coins />} label="Currency" value={restaurant?.currencyCode ?? '—'} />
      <Stat icon={<Clock />} label="Time zone" value={restaurant?.timezone ?? '—'} />
      <p className="text-sm text-slate-500 sm:col-span-2 xl:col-span-4 dark:text-slate-400">
        Use the branch menu to see this branch&apos;s orders, payments and inventory.
      </p>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-slate-900">
      <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 [&_svg]:size-4">
        {icon}
        {label}
      </div>
      <p className="mt-2 truncate font-semibold text-slate-900 dark:text-white">{value}</p>
    </div>
  );
}
