'use client';

import { Logo } from '@foodstack/ui/components/logo';
import { cn } from '@foodstack/ui/lib/utils';
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  ConciergeBell,
  MapPin,
} from 'lucide-react';
import { motion } from 'motion/react';
import Link from 'next/link';
import { useState, useSyncExternalStore } from 'react';
import { AccountMenu } from '@/components/account-menu';
import { useProfile } from '@/components/auth/auth-provider';
import { ThemeToggle } from '@/components/theme-toggle';
import { canAccessPath } from '@/lib/auth/access';

/*
 * Waiter app setup screen. The tables, floors and dining-sessions modules have no API yet, so this
 * shows the setup state only; the table workspace replaces the setup card once those ship.
 */

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

/** Real device connectivity, not a decorative badge. */
function useOnline() {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

const iconButton =
  'rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white';

export function WaiterSetup() {
  const profile = useProfile();
  const online = useOnline();
  const [branchId, setBranchId] = useState(profile.branches[0]?.id ?? '');
  const canManage = canAccessPath(profile, '/restaurant/dashboard');

  const steps = [
    { label: 'Account and branch access', done: true },
    { label: 'Floors and tables', done: false },
    { label: 'Dining service activated', done: false },
  ];

  return (
    <div className="flex min-h-dvh flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 sm:px-6 dark:border-white/10 dark:bg-slate-900">
        <Logo />
        <span className="hidden h-6 w-px bg-slate-200 sm:block dark:bg-white/10" aria-hidden />
        <span className="flex items-center gap-2 text-sm font-semibold">
          <ConciergeBell className="size-4 text-emerald-600 dark:text-emerald-400" />
          Waiter
        </span>
        {profile.activeTenant ? (
          <span className="hidden truncate text-sm text-slate-500 md:block dark:text-slate-400">
            · {profile.activeTenant.name}
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          <span
            role="status"
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset',
              online
                ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20'
                : 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/20',
            )}
          >
            <span
              className={cn('size-1.5 rounded-full', online ? 'bg-emerald-500' : 'bg-red-500')}
            />
            {online ? 'Online' : 'Offline'}
          </span>

          {profile.branches.length > 0 ? (
            <label className="relative hidden items-center lg:flex">
              <MapPin
                className="pointer-events-none absolute left-2.5 size-4 text-slate-400"
                aria-hidden
              />
              <span className="sr-only">Branch</span>
              <select
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                disabled={profile.branches.length < 2}
                className="h-9 appearance-none rounded-md border border-slate-200 bg-white pr-8 pl-8 text-sm font-medium text-slate-700 shadow-xs outline-none focus:ring-2 focus:ring-emerald-500/30 disabled:opacity-100 dark:border-white/10 dark:bg-white/5 dark:text-slate-200"
              >
                {profile.branches.map((b) => (
                  <option key={b.id} value={b.id} className="text-slate-900">
                    {b.name}
                  </option>
                ))}
              </select>
              {profile.branches.length > 1 ? (
                <ChevronDown
                  className="pointer-events-none absolute right-2.5 size-4 text-slate-400"
                  aria-hidden
                />
              ) : null}
            </label>
          ) : null}

          <ThemeToggle className={iconButton} />
          <span
            className="mx-1 hidden h-6 w-px bg-slate-200 sm:block dark:bg-white/10"
            aria-hidden
          />
          <AccountMenu />
        </div>
      </header>

      <main className="flex flex-1 items-start justify-center px-4 py-10 sm:py-16">
        <motion.section
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xs sm:p-8 dark:border-white/10 dark:bg-slate-900"
        >
          <span className="flex size-10 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">
            <ConciergeBell className="size-5" />
          </span>

          <h1 className="mt-5 text-xl font-semibold tracking-tight">
            Your dining floor is almost ready
          </h1>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            Table management and order taking will be available here once the dining module is
            activated for your restaurant.
          </p>

          <ul className="mt-6 divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-white/5 dark:border-white/10">
            {steps.map(({ label, done }) => (
              <li key={label} className="flex items-center gap-3 px-4 py-3 text-sm">
                {done ? (
                  <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <CircleDashed className="size-4 shrink-0 text-slate-400 dark:text-slate-500" />
                )}
                <span
                  className={
                    done
                      ? 'text-slate-900 dark:text-slate-100'
                      : 'text-slate-500 dark:text-slate-400'
                  }
                >
                  {label}
                </span>
                <span
                  className={cn(
                    'ml-auto text-xs font-medium',
                    done
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-slate-400 dark:text-slate-500',
                  )}
                >
                  {done ? 'Done' : 'Pending'}
                </span>
              </li>
            ))}
          </ul>

          {canManage ? (
            <Link
              href="/restaurant/dashboard"
              className="mt-6 inline-flex h-9 items-center gap-2 rounded-md bg-emerald-600 px-4 text-sm font-medium text-white shadow-xs transition-colors hover:bg-emerald-700 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
            >
              Go to restaurant dashboard
              <ArrowRight className="size-4" />
            </Link>
          ) : (
            <p className="mt-6 text-sm text-slate-500 dark:text-slate-400">
              Ask your restaurant manager to finish setting up floors and tables.
            </p>
          )}
        </motion.section>
      </main>
    </div>
  );
}
