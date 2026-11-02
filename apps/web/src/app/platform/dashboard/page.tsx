'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { AlarmClock, BarChart3, ShieldCheck, Store, UsersRound } from 'lucide-react';
import { motion } from 'motion/react';
import Image from 'next/image';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { authErrorMessage } from '@/lib/auth/errors';
import heroImage from '../../../../public/images/cta-bg-image.png';
import { card, ease, RestaurantsPanel } from '../restaurants-panel';
import { StatCard, StatCardSkeleton } from '../stat-card';

interface PlatformDashboard {
  tenants: { total: number; byStatus: Record<string, number>; newLast7Days: number };
  users: number;
  activeSessions: number;
  failedLoginsLast24h: number;
}

export default function PlatformDashboardPage() {
  const { client } = useAuth();
  const profile = useProfile();
  const dashboard = useQuery({
    queryKey: ['platform', 'dashboard'],
    queryFn: () => client.request<PlatformDashboard>('/platform/dashboard'),
  });
  const d = dashboard.data;

  return (
    <div className="mx-auto max-w-[90rem] space-y-6">
      <Hero name={profile.user.fullName} />

      {dashboard.isError ? (
        <div className={cn(card, 'p-5 text-sm text-red-600')}>
          {authErrorMessage(dashboard.error)}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {d ? (
            <>
              <StatCard
                index={0}
                tone="emerald"
                icon={<Store />}
                label="Restaurants"
                value={d.tenants.total}
                delta={d.tenants.newLast7Days}
                hint={`${d.tenants.newLast7Days} new in the last 7 days`}
                footer={{
                  kind: 'meter',
                  value: d.tenants.newLast7Days,
                  max: d.tenants.total,
                  label: 'Joined this week',
                }}
              />
              <StatCard
                index={1}
                tone="violet"
                icon={<AlarmClock />}
                label="Active or in trial"
                value={(d.tenants.byStatus.active ?? 0) + (d.tenants.byStatus.trial ?? 0)}
                hint={`${d.tenants.byStatus.trial ?? 0} in trial · ${d.tenants.byStatus.suspended ?? 0} suspended`}
                footer={{
                  kind: 'meter',
                  value: (d.tenants.byStatus.active ?? 0) + (d.tenants.byStatus.trial ?? 0),
                  max: d.tenants.total,
                  label: 'Of all restaurants',
                }}
              />
              <StatCard
                index={2}
                tone="orange"
                icon={<UsersRound />}
                label="Users"
                value={d.users}
                hint="Across the platform and restaurants"
                footer={{
                  kind: 'badge',
                  text: `${d.activeSessions} active session${d.activeSessions === 1 ? '' : 's'}`,
                  status: d.activeSessions > 0 ? 'good' : 'neutral',
                }}
              />
              <StatCard
                index={3}
                tone="blue"
                icon={<ShieldCheck />}
                label="Failed sign-ins"
                value={d.failedLoginsLast24h}
                hint="Last 24 hours"
                footer={
                  d.failedLoginsLast24h > 0
                    ? { kind: 'badge', text: 'Worth a look', status: 'warn' }
                    : { kind: 'badge', text: 'All clear', status: 'good' }
                }
              />
            </>
          ) : (
            Array.from({ length: 4 }, (_, i) => <StatCardSkeleton key={i} />)
          )}
        </div>
      )}

      <RestaurantsPanel preview />
    </div>
  );
}

function Hero({ name }: { name: string }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease }}
      className="relative overflow-hidden rounded-[20px] border border-emerald-100/70 bg-gradient-to-br from-white via-white to-emerald-50/70 dark:border-white/10 dark:from-[#0f1d18] dark:via-[#0f1d18] dark:to-emerald-950/40"
    >
      <motion.div
        initial={{ opacity: 0, scale: 1.08 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 1.2, ease }}
        className="absolute inset-y-0 right-0 hidden w-[52%] md:block"
      >
        <Image
          src={heroImage}
          alt=""
          priority
          placeholder="blur"
          sizes="(min-width: 768px) 50vw, 0px"
          className="origin-top-left scale-110 object-cover object-[85%_40%]"
          fill
        />
        <div className="absolute inset-0 bg-gradient-to-r from-white via-white/30 to-transparent dark:from-[#0f1d18] dark:via-[#0f1d18]/40" />
      </motion.div>
      <motion.span
        initial={{ opacity: 0, scale: 0.6, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: [0, -8, 0] }}
        transition={{
          opacity: { duration: 0.5, delay: 0.5 },
          scale: { type: 'spring', stiffness: 260, damping: 16, delay: 0.5 },
          y: { duration: 4, repeat: Infinity, ease: 'easeInOut', delay: 1 },
        }}
        className="absolute top-6 right-8 hidden size-16 items-center justify-center rounded-[16px] border border-white/60 bg-white/80 text-emerald-600 shadow-xl backdrop-blur md:flex dark:border-white/10 dark:bg-white/10 dark:text-emerald-400"
      >
        <BarChart3 className="size-8" strokeWidth={2.4} />
      </motion.span>
      <div className="relative max-w-xl px-6 md:max-w-[50%] py-8 sm:px-8 sm:py-10">
        <h1 className="text-3xl leading-tight font-bold tracking-tight sm:text-4xl xl:text-[2.75rem]">
          <motion.span
            className="block"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.1, ease }}
          >
            Welcome back,
          </motion.span>
          <motion.span
            className="block bg-gradient-to-r from-emerald-600 via-emerald-500 to-teal-500 bg-clip-text text-transparent dark:from-emerald-400 dark:via-emerald-300 dark:to-teal-300"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.22, ease }}
          >
            {name}!
          </motion.span>
        </h1>
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.34, ease }}
          className="mt-3 text-base text-muted-foreground sm:text-lg"
        >
          Here&apos;s what&apos;s happening with your FoodStack platform today.
        </motion.p>
        <motion.span
          initial={{ width: 0 }}
          animate={{ width: 56 }}
          transition={{ duration: 0.7, delay: 0.5, ease }}
          className="mt-5 block h-1 rounded-full bg-emerald-500"
        />
      </div>
    </motion.section>
  );
}
