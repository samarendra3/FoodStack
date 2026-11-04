'use client';

import { buttonVariants } from '@foodstack/ui/components/button';
import { cn } from '@foodstack/ui/lib/utils';
import { ArrowRight, Check, RefreshCw, Sparkles } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import { useState } from 'react';
import {
  BADGE_LABEL,
  formatMoney,
  PLAN_ICONS,
  type PublicPlan,
  planHighlights,
  usePublicPlans,
} from '@/lib/plans';
import { Reveal, Stagger, StaggerItem } from './motion';

type Billing = 'monthly' | 'yearly';

function BillingToggle({
  value,
  onChange,
  savings,
}: {
  value: Billing;
  onChange: (b: Billing) => void;
  savings: number;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Billing period"
      className="relative inline-flex items-center rounded-xl bg-card p-1 shadow-sm ring-1 ring-border"
    >
      {(['monthly', 'yearly'] as const).map((option) => {
        const active = value === option;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option)}
            className={cn(
              'relative flex h-10 items-center gap-2 rounded-lg px-5 text-sm font-semibold transition-colors',
              active ? 'text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {active ? (
              <motion.span
                layoutId="billing-pill"
                transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                className="absolute inset-0 rounded-lg bg-primary shadow-sm shadow-primary/15"
              />
            ) : null}
            <span className="relative">{option === 'monthly' ? 'Monthly' : 'Yearly'}</span>
            {option === 'yearly' && savings > 0 ? (
              <span
                className={cn(
                  'relative rounded-md px-1.5 py-0.5 text-[11px] font-bold',
                  active ? 'bg-white/20 text-white' : 'bg-accent text-accent-foreground',
                )}
              >
                Save up to {savings}%
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function Price({ plan, billing, dark }: { plan: PublicPlan; billing: Billing; dark: boolean }) {
  const muted = dark ? 'text-slate-400' : 'text-muted-foreground';
  const yearly = plan.priceYearlyMinor;
  const monthly = plan.priceMonthlyMinor;

  if (plan.customPricing || monthly === null || yearly === null) {
    return (
      <div className="flex h-[4.5rem] flex-col justify-end">
        <p className="font-display text-4xl font-extrabold tracking-tight">Custom</p>
        <p className={cn('mt-1 text-sm', muted)}>Priced for your business</p>
      </div>
    );
  }

  // Yearly is shown as its monthly equivalent, with the yearly total underneath.
  const perMonth = billing === 'monthly' ? monthly : Math.round(yearly / 12);
  return (
    <div className="flex h-[4.5rem] flex-col justify-end">
      <div className="flex items-end gap-1.5">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={`${billing}-${perMonth}`}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.2 }}
            className="font-display tabular text-5xl leading-none font-extrabold tracking-tight"
          >
            {formatMoney(perMonth, plan.currencyCode)}
          </motion.span>
        </AnimatePresence>
        <span className={cn('pb-1 text-sm', muted)}>/ month</span>
      </div>
      <p className={cn('mt-2 text-sm', muted)}>
        {billing === 'yearly'
          ? `Billed yearly, ${formatMoney(yearly, plan.currencyCode)}${
              plan.yearlySavingsPercent ? ` · save ${plan.yearlySavingsPercent}%` : ''
            }`
          : 'Billed monthly'}
      </p>
    </div>
  );
}

function PlanCard({ plan, billing }: { plan: PublicPlan; billing: Billing }) {
  const Icon = PLAN_ICONS[plan.icon] ?? Sparkles;
  const dark = plan.badge !== null;
  const custom = plan.customPricing;
  return (
    <StaggerItem
      whileHover={{ y: -6 }}
      className={cn(
        'relative mx-auto flex w-full max-w-md flex-col rounded-2xl p-7 transition-shadow sm:p-8 lg:max-w-none',
        dark
          ? 'bg-slate-950 text-white shadow-2xl shadow-emerald-900/30 ring-2 ring-emerald-500 lg:py-11'
          : 'bg-card shadow-lg shadow-slate-900/5 ring-1 ring-border hover:shadow-xl',
      )}
    >
      {plan.badge ? (
        <>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400 to-transparent"
          />
          <span className="absolute -top-3.5 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-lg bg-primary px-3 py-1 text-xs font-bold text-primary-foreground shadow-lg shadow-primary/30">
            <Sparkles className="size-3.5" />
            {BADGE_LABEL[plan.badge]}
          </span>
        </>
      ) : null}

      <div className="flex items-center gap-3">
        <span
          className={cn(
            'flex size-11 items-center justify-center rounded-xl',
            dark ? 'bg-emerald-500/15 text-emerald-400' : 'bg-accent text-primary',
          )}
        >
          <Icon className="size-5" />
        </span>
        <h3 className="font-display text-xl font-bold">{plan.name}</h3>
      </div>
      {plan.description ? (
        <p className={cn('mt-3 text-sm', dark ? 'text-slate-400' : 'text-muted-foreground')}>
          {plan.description}
        </p>
      ) : null}

      <div className="mt-7">
        <Price plan={plan} billing={billing} dark={dark} />
      </div>

      <Link
        href={`/get-started?plan=${encodeURIComponent(plan.slug)}`}
        className={cn(
          buttonVariants({ size: 'lg' }),
          'mt-8 h-12 w-full rounded-lg font-semibold',
          dark
            ? 'bg-emerald-500 text-white shadow-md shadow-emerald-500/20 hover:bg-emerald-400'
            : custom
              ? 'bg-secondary text-secondary-foreground hover:bg-secondary/90'
              : 'bg-card text-foreground ring-1 ring-border hover:bg-muted',
        )}
      >
        {custom ? 'Contact sales' : `Start ${plan.trialDays}-day free trial`} <ArrowRight />
      </Link>

      <div className={cn('my-8 h-px', dark ? 'bg-white/10' : 'bg-border')} aria-hidden />

      <p className="text-sm font-semibold">Includes</p>
      <ul className="mt-4 space-y-3.5 text-sm">
        {planHighlights(plan).map((feature) => (
          <li key={feature} className="flex items-start gap-3">
            <span
              className={cn(
                'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full',
                dark ? 'bg-emerald-500 text-white' : 'bg-accent text-primary',
              )}
            >
              <Check className="size-3" strokeWidth={3} />
            </span>
            <span className={dark ? 'text-slate-200' : 'text-foreground/85'}>{feature}</span>
          </li>
        ))}
      </ul>
    </StaggerItem>
  );
}

/** Pricing from the live plan catalogue (GET /plans): Super Admin edits show without a deploy. */
export function PricingSection() {
  const [billing, setBilling] = useState<Billing>('yearly');
  const plans = usePublicPlans();
  const list = plans.data ?? [];
  const savings = Math.max(0, ...list.map((p) => p.yearlySavingsPercent));
  const cols =
    list.length >= 4 ? 'lg:grid-cols-4' : list.length === 2 ? 'lg:grid-cols-2' : 'lg:grid-cols-3';

  return (
    <section
      id="pricing"
      className="relative isolate scroll-mt-28 overflow-hidden bg-gradient-to-b from-background via-emerald-50/50 to-background py-24 dark:via-emerald-950/10"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <Reveal className="mx-auto max-w-2xl text-center">
          <p className="flex items-center justify-center gap-2 text-sm font-semibold text-primary">
            <span className="h-0.5 w-4 rounded-full bg-primary" />
            Pricing
            <span className="h-0.5 w-4 rounded-full bg-primary" />
          </p>
          <h2 className="font-display mt-3 text-3xl font-bold tracking-tight text-balance sm:text-5xl">
            Simple pricing that grows with your restaurant
          </h2>
          <p className="mt-5 text-lg text-pretty text-muted-foreground">
            Start with a free trial, switch plans any time, and keep every order, bill and report in
            one place.
          </p>
          <div className="mt-9">
            <BillingToggle value={billing} onChange={setBilling} savings={savings} />
          </div>
        </Reveal>

        {plans.isPending ? (
          <div className="mt-14 grid gap-6 lg:mt-16 lg:grid-cols-3" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-[34rem] animate-pulse rounded-2xl bg-card ring-1 ring-border"
              />
            ))}
          </div>
        ) : plans.isError ? (
          <div className="mx-auto mt-14 max-w-md rounded-2xl bg-card p-8 text-center ring-1 ring-border">
            <p className="font-semibold">We couldn&apos;t load our plans right now.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Check your connection and try again, or start your free trial anyway.
            </p>
            <div className="mt-5 flex justify-center gap-2">
              <button
                type="button"
                onClick={() => void plans.refetch()}
                className={cn(buttonVariants({ variant: 'outline' }))}
              >
                <RefreshCw /> Retry
              </button>
              <Link href="/get-started" className={buttonVariants()}>
                Get started
              </Link>
            </div>
          </div>
        ) : list.length === 0 ? (
          <div className="mx-auto mt-14 max-w-md rounded-2xl bg-card p-8 text-center ring-1 ring-border">
            <p className="font-semibold">New plans are coming soon.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Start your free trial today and choose a plan when you&apos;re ready.
            </p>
            <Link href="/get-started" className={cn(buttonVariants(), 'mt-5')}>
              Start free trial <ArrowRight />
            </Link>
          </div>
        ) : (
          <Stagger
            gap={0.12}
            className={cn('mt-14 grid items-stretch gap-6 lg:mt-16 lg:items-center', cols)}
          >
            {list.map((plan) => (
              <PlanCard key={plan.id} plan={plan} billing={billing} />
            ))}
          </Stagger>
        )}

        <Reveal className="mt-12 text-center text-sm text-muted-foreground">
          Prices exclude GST. Need something bigger?{' '}
          <Link href="/get-started" className="font-semibold text-primary hover:underline">
            Talk to us about volume pricing
          </Link>
          .
        </Reveal>
      </div>
    </section>
  );
}
