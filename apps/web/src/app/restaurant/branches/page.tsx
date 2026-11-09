'use client';

import { Building2, Clock, Coins, MapPin, Store } from 'lucide-react';
import { motion } from 'motion/react';
import Link from 'next/link';
import { authErrorMessage } from '@/lib/auth/errors';
import { useRestaurantOverview } from '../overview';
import { AddBranch } from './add-branch';

export default function BranchesPage() {
  const overview = useRestaurantOverview();
  const data = overview.data;

  return (
    <div className="mx-auto max-w-[96rem] space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-white">
            Branches
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            The locations you can work in. Open a branch to manage it.
          </p>
        </div>
        {data ? <AddBranch used={data.branches.length} /> : null}
      </div>

      {overview.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" aria-hidden>
          {Array.from({ length: 3 }, (_, i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-xl border border-slate-200 bg-white dark:border-white/10 dark:bg-slate-900"
            />
          ))}
        </div>
      ) : overview.isError ? (
        <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {authErrorMessage(overview.error)}
        </p>
      ) : data!.branches.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl border border-dashed border-slate-300 bg-white px-6 dark:border-white/15 dark:bg-slate-900 py-14 text-center">
          <span className="flex size-10 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">
            <Building2 className="size-5" />
          </span>
          <p className="mt-3 font-medium text-slate-900 dark:text-white">
            No branches assigned to you
          </p>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Ask an owner or admin to give you access.
          </p>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {data!.branches.map((b, i) => {
            const restaurant = data!.restaurants.find((r) => r.id === b.restaurantId);
            return (
              <motion.li
                key={b.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: Math.min(i, 8) * 0.05 }}
              >
                <Link
                  href={`/restaurant/branches/${b.id}`}
                  className="block h-full rounded-xl border border-slate-200 bg-white p-5 shadow-xs transition-colors hover:border-emerald-300 focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:outline-none dark:border-white/10 dark:bg-slate-900 dark:hover:border-emerald-500/40"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">
                        <MapPin className="size-[18px]" aria-hidden />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-slate-900 dark:text-white">
                          {b.name}
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">Code {b.code}</p>
                      </div>
                    </div>
                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200 ring-inset dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20">
                      <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
                      Active
                    </span>
                  </div>
                  {restaurant ? (
                    <dl className="mt-4 space-y-2 border-t border-slate-100 pt-4 dark:border-white/10 text-sm">
                      <Row icon={<Store />} label="Restaurant" value={restaurant.name} />
                      <Row icon={<Coins />} label="Currency" value={restaurant.currencyCode} />
                      <Row icon={<Clock />} label="Time zone" value={restaurant.timezone} />
                    </dl>
                  ) : null}
                </Link>
              </motion.li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-slate-500 dark:text-slate-400 [&_svg]:size-4" aria-hidden>
        {icon}
      </span>
      <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="ml-auto truncate font-medium text-slate-900 dark:text-slate-100">{value}</dd>
    </div>
  );
}
