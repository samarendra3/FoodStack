'use client';

import { Logo } from '@foodstack/ui/components/logo';
import { cn } from '@foodstack/ui/lib/utils';
import { ArrowRight, ChevronDown, ConciergeBell, LayoutGrid, MapPin } from 'lucide-react';
import { motion } from 'motion/react';
import Link from 'next/link';
import { useState, useSyncExternalStore } from 'react';
import { AccountMenu } from '@/components/account-menu';
import { useProfile } from '@/components/auth/auth-provider';
import { canAccessPath } from '@/lib/auth/access';

/*
 * Waiter app setup screen. The tables, floors and dining-sessions modules have no API yet, so this
 * shows the setup state only; the table workspace replaces <SetupCard> once those ship.
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

export function WaiterSetup() {
  const profile = useProfile();
  const online = useOnline();
  const [branchId, setBranchId] = useState(profile.branches[0]?.id ?? '');
  const canManage = canAccessPath(profile, '/restaurant/dashboard');

  return (
    <div className="flex min-h-dvh flex-col bg-[#F5F8FC] dark:bg-slate-950">
      <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-4 bg-[#0F172A] px-4 text-white sm:px-6">
        <Logo inverted />
        <span className="hidden h-7 w-px bg-white/15 sm:block" aria-hidden />
        <span className="flex items-center gap-2 font-semibold">
          <ConciergeBell className="size-5 text-emerald-300" />
          Waiter
        </span>
        {profile.activeTenant ? (
          <>
            <span className="hidden h-7 w-px bg-white/15 md:block" aria-hidden />
            <span className="hidden truncate text-sm font-medium text-slate-200 md:block">
              {profile.activeTenant.name}
            </span>
          </>
        ) : null}

        <div className="ml-auto flex items-center gap-3 sm:gap-4">
          <span
            role="status"
            className={cn(
              'flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-semibold',
              online ? 'bg-emerald-500/15 text-emerald-200' : 'bg-red-500/15 text-red-200',
            )}
          >
            <span
              className={cn('size-2.5 rounded-full', online ? 'bg-emerald-400' : 'bg-red-400')}
            />
            {online ? 'Online' : 'Offline'}
          </span>

          {profile.branches.length > 0 ? (
            <label className="relative hidden items-center lg:flex">
              <MapPin
                className="pointer-events-none absolute left-0 size-4 text-slate-300"
                aria-hidden
              />
              <span className="sr-only">Branch</span>
              <select
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                disabled={profile.branches.length < 2}
                className="h-9 appearance-none bg-transparent pr-6 pl-6 text-sm font-semibold text-white outline-none disabled:opacity-100"
              >
                {profile.branches.map((b) => (
                  <option key={b.id} value={b.id} className="text-slate-900">
                    {b.name}
                  </option>
                ))}
              </select>
              {profile.branches.length > 1 ? (
                <ChevronDown
                  className="pointer-events-none absolute right-0 size-4 text-slate-300"
                  aria-hidden
                />
              ) : null}
            </label>
          ) : null}

          <span className="hidden h-7 w-px bg-white/15 lg:block" aria-hidden />
          <AccountMenu inverted />
        </div>
      </header>

      <main className="relative isolate flex flex-1 items-start justify-center overflow-hidden px-4 pt-6 pb-12 sm:pt-8">
        <Backdrop />
        <div className="relative flex w-full max-w-3xl flex-col items-center">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="w-full max-w-2xl"
          >
            <WaiterIllustration className="-mb-px block h-auto w-full" />
          </motion.div>

          <motion.section
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="relative -mt-14 w-full rounded-[1.75rem] bg-white px-6 pt-16 pb-9 text-center shadow-[0_20px_50px_-24px_rgba(15,23,42,0.18)] sm:-mt-16 sm:px-12 dark:bg-slate-900"
          >
            <span className="absolute -top-14 left-1/2 flex size-28 -translate-x-1/2 items-center justify-center rounded-full bg-white dark:bg-slate-900">
              <span className="flex size-[5.5rem] items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300">
                <ConciergeBell className="size-10" strokeWidth={1.75} />
              </span>
            </span>

            <h1 className="text-[1.75rem] leading-tight font-bold tracking-tight text-slate-900 sm:text-4xl dark:text-white">
              Your dining floor is{' '}
              <span className="text-emerald-600 dark:text-emerald-400">almost ready!</span>
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-base text-slate-500 sm:text-lg dark:text-slate-400">
              Your account and branch access are ready. Table management and order taking will be
              available when the dining module is activated.
            </p>

            <div className="mx-auto mt-6 flex max-w-sm items-center gap-3" aria-hidden>
              <span className="h-px flex-1 bg-gradient-to-r from-transparent to-slate-200 dark:to-white/10" />
              <span className="size-2 rounded-full bg-emerald-500" />
              <span className="h-px flex-1 bg-gradient-to-l from-transparent to-slate-200 dark:to-white/10" />
            </div>

            <p
              role="status"
              className="mt-5 inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600 dark:bg-white/10 dark:text-slate-300"
            >
              <span className="size-2 rounded-full bg-amber-500" />
              Dining service: not yet activated
            </p>

            {canManage ? (
              <div className="mt-6">
                <Link
                  href="/restaurant/dashboard"
                  className="inline-flex h-14 items-center gap-3 rounded-full bg-gradient-to-b from-emerald-600 to-emerald-700 px-8 text-base font-semibold text-white shadow-lg shadow-emerald-700/20 transition-all hover:-translate-y-0.5 hover:shadow-xl hover:shadow-emerald-700/25 active:translate-y-0"
                >
                  <LayoutGrid className="size-5" />
                  Go to Restaurant Dashboard
                  <ArrowRight className="size-5" />
                </Link>
              </div>
            ) : null}
          </motion.section>
        </div>
      </main>
    </div>
  );
}

/** Soft mint shapes, leaves, cutlery and dot grids behind the card. */
function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="absolute -top-32 -left-32 size-96 rounded-full bg-emerald-100/50 dark:bg-emerald-500/5" />
      <div className="absolute top-40 left-[13%] size-10 rounded-full bg-emerald-100/80 dark:bg-emerald-500/10" />
      <div className="absolute -right-40 bottom-[-10rem] size-[30rem] rounded-full bg-emerald-100/50 dark:bg-emerald-500/5" />
      <Dots className="absolute top-20 right-[6%] hidden md:block" />
      <Dots className="absolute top-[44%] left-[2%] hidden md:block" />
      <svg
        viewBox="0 0 120 220"
        className="absolute top-[32%] right-[8%] hidden h-48 text-emerald-200/70 lg:block dark:text-emerald-500/10"
      >
        <path
          d="M30 10 v60 M18 10 v40 a12 12 0 0 0 24 0 v-40 M30 70 l-8 140"
          stroke="currentColor"
          strokeWidth="9"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M96 12 c-22 20-26 70-8 90 l-14 106"
          stroke="currentColor"
          strokeWidth="10"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
      <Leaves className="absolute bottom-0 left-0 hidden h-72 sm:block" />
      <Leaves className="absolute right-0 bottom-10 hidden h-64 -scale-x-100 sm:block" />
    </div>
  );
}

function Dots({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 110 50"
      className={cn('w-28 text-emerald-200 dark:text-emerald-500/20', className)}
    >
      {Array.from({ length: 18 }, (_, i) => (
        <circle
          key={i}
          cx={5 + (i % 6) * 20}
          cy={5 + Math.floor(i / 6) * 20}
          r="2.5"
          fill="currentColor"
        />
      ))}
    </svg>
  );
}

function Leaves({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 160 260"
      className={cn('text-emerald-300/50 dark:text-emerald-500/15', className)}
    >
      <path
        d="M10 260 C 20 180, 60 120, 120 80"
        stroke="currentColor"
        strokeWidth="3"
        fill="none"
      />
      <path d="M40 190 C 10 160, 20 110, 60 100 C 70 140, 60 170, 40 190 Z" fill="currentColor" />
      <path d="M70 150 C 70 110, 110 80, 150 90 C 140 130, 110 150, 70 150 Z" fill="currentColor" />
      <path d="M20 230 C 0 200, 0 170, 20 150 C 40 180, 40 210, 20 230 Z" fill="currentColor" />
    </svg>
  );
}

/** Smiling waiter in a vest and bow tie, holding a cloche, in a softly drawn dining room. */
function WaiterIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 640 300" className={className} aria-hidden>
      <defs>
        <clipPath id="waiter-arch">
          <path d="M60 300 V200 A260 200 0 0 1 580 200 V300 Z" />
        </clipPath>
      </defs>
      <g clipPath="url(#waiter-arch)">
        <rect width="640" height="300" className="fill-emerald-50 dark:fill-emerald-500/10" />
        {/* dining room */}
        <g className="fill-emerald-100 dark:fill-emerald-500/15">
          <rect x="70" y="250" width="140" height="8" rx="3" />
          <rect x="136" y="258" width="8" height="42" />
          <rect x="430" y="250" width="140" height="8" rx="3" />
          <rect x="496" y="258" width="8" height="42" />
          <path d="M80 246 h40 l6 -30 h-52z" />
          <path d="M520 246 h40 l6 -30 h-52z" />
        </g>
        <g className="fill-slate-200/80 dark:fill-white/10">
          <rect x="160" y="226" width="36" height="74" rx="8" />
          <rect x="560" y="226" width="36" height="74" rx="8" />
          <rect x="440" y="230" width="30" height="70" rx="8" />
        </g>
        {/* plant */}
        <rect x="100" y="210" width="26" height="36" rx="5" fill="#E2E8F0" />
        <path
          d="M113 212 C 100 190, 92 172, 98 158 C 110 170, 114 190, 113 212 Z M113 212 C 122 186, 136 172, 146 170 C 142 190, 128 204, 113 212 Z M113 212 C 108 196, 112 176, 120 166 C 126 184, 120 200, 113 212 Z"
          fill="#6EE7B7"
        />
        {/* pendant lamps */}
        <path d="M150 20 V100" stroke="#334155" strokeWidth="2" />
        <path d="M128 124 C 128 106, 172 106, 172 124 Z" fill="#334155" />
        <circle cx="150" cy="128" r="5" fill="#FDE68A" />
        <path d="M500 120 V178" stroke="#94A3B8" strokeWidth="2" />
        <path d="M486 192 C 486 180, 514 180, 514 192 Z" fill="#475569" />
        <circle cx="500" cy="195" r="3.5" fill="#FDE68A" />
      </g>

      {/* waiter */}
      <g>
        {/* torso: shirt, vest */}
        <path
          d="M232 300 C 236 230, 262 196, 320 196 C 378 196, 404 230, 408 300 Z"
          fill="#FFFFFF"
          stroke="#E2E8F0"
          strokeWidth="2"
        />
        <path
          d="M272 300 C 270 250, 284 214, 306 204 L320 236 L334 204 C 356 214, 370 250, 368 300 Z"
          fill="#1E293B"
        />
        <rect x="284" y="250" width="26" height="7" rx="2" fill="#FFFFFF" />
        {/* bow tie */}
        <path d="M320 212 l-16 -9 v18 z M320 212 l16 -9 v18 z" fill="#059669" />
        <circle cx="320" cy="212" r="4" fill="#047857" />
        {/* neck + head */}
        <rect x="308" y="170" width="24" height="30" rx="8" fill="#F2B48A" />
        <ellipse cx="320" cy="132" rx="38" ry="42" fill="#F8C9A0" />
        <ellipse cx="282" cy="138" rx="7" ry="10" fill="#F2B48A" />
        <ellipse cx="358" cy="138" rx="7" ry="10" fill="#F2B48A" />
        {/* hair */}
        <path
          d="M280 128 C 270 80, 310 70, 330 78 C 356 68, 378 96, 362 122 C 356 104, 336 96, 316 104 C 300 98, 288 112, 286 132 Z"
          fill="#1E293B"
        />
        {/* face */}
        <path
          d="M300 122 q8 -6 16 0 M326 122 q8 -6 16 0"
          stroke="#1E293B"
          strokeWidth="3"
          fill="none"
          strokeLinecap="round"
        />
        <circle cx="308" cy="134" r="3.5" fill="#1E293B" />
        <circle cx="334" cy="134" r="3.5" fill="#1E293B" />
        <path
          d="M304 152 Q321 170 338 152 Q321 160 304 152 Z"
          fill="#FFFFFF"
          stroke="#9A3412"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <circle cx="298" cy="150" r="5" fill="#FDA4AF" opacity="0.5" />
        <circle cx="344" cy="150" r="5" fill="#FDA4AF" opacity="0.5" />
        {/* left arm down */}
        <path
          d="M244 300 C 244 260, 248 236, 260 220"
          stroke="#FFFFFF"
          strokeWidth="30"
          strokeLinecap="round"
          fill="none"
        />
        {/* right arm holding tray */}
        <path
          d="M396 236 C 420 236, 440 214, 452 190"
          stroke="#FFFFFF"
          strokeWidth="26"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M396 236 C 420 236, 440 214, 452 190"
          stroke="#E2E8F0"
          strokeWidth="28"
          strokeLinecap="round"
          fill="none"
          opacity="0.35"
        />
        <ellipse cx="462" cy="178" rx="14" ry="9" fill="#F8C9A0" />
        {/* tray + cloche */}
        <ellipse cx="490" cy="168" rx="72" ry="7" fill="#1E293B" />
        <path d="M432 162 C 432 112, 548 112, 548 162 Z" fill="#CBD5E1" />
        <path
          d="M446 154 C 450 128, 480 120, 500 126"
          stroke="#F1F5F9"
          strokeWidth="6"
          strokeLinecap="round"
          fill="none"
        />
        <rect x="484" y="104" width="12" height="10" rx="4" fill="#94A3B8" />
        <path
          d="M528 92 l6 -14 M542 100 l12 -8 M546 116 l14 -2"
          stroke="#059669"
          strokeWidth="4"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
