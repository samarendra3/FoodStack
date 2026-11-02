'use client';

import { buttonVariants } from '@foodstack/ui/components/button';
import { cn } from '@foodstack/ui/lib/utils';
import { ArrowRight, Building2, Check, Rocket, Sparkles } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import { useState } from 'react';
import { Reveal, Stagger, StaggerItem } from './motion';

type Billing = 'monthly' | 'yearly';

interface Plan {
  name: string;
  tagline: string;
  icon: typeof Rocket;
  /** Price per branch per month, in rupees; null means "custom". */
  monthly: number | null;
  yearly: number | null;
  cta: { label: string; href: string };
  featuresTitle: string;
  features: string[];
  popular?: boolean;
}

// TODO: placeholder plans and prices. Replace with the real price list before launch.
const plans: Plan[] = [
  {
    name: 'Starter',
    tagline: 'For a single outlet getting off paper and spreadsheets.',
    icon: Rocket,
    monthly: 999,
    yearly: 799,
    cta: { label: 'Get started', href: '/login' },
    featuresTitle: 'Includes',
    features: [
      '1 branch',
      'POS billing with GST invoices',
      'QR table ordering',
      'Menu and table management',
      'Daily sales reports',
      'Email support',
    ],
  },
  {
    name: 'Growth',
    tagline: 'For busy restaurants and growing chains.',
    icon: Sparkles,
    monthly: 2499,
    yearly: 1999,
    cta: { label: 'Get started', href: '/login' },
    featuresTitle: 'Everything in Starter, plus',
    features: [
      'Up to 5 branches',
      'Kitchen display and waiter app',
      'Offline POS that syncs later',
      'Inventory, recipes and stock transfers',
      'Advanced reports across branches',
      'Priority support',
    ],
    popular: true,
  },
  {
    name: 'Enterprise',
    tagline: 'For large chains with custom needs.',
    icon: Building2,
    monthly: null,
    yearly: null,
    cta: { label: 'Contact sales', href: '#' },
    featuresTitle: 'Everything in Growth, plus',
    features: [
      'Unlimited branches',
      'Custom roles and full audit log',
      'API access and integrations',
      'Dedicated account manager',
      'Guided onboarding and data migration',
      'Uptime SLA',
    ],
  },
];

const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;

function BillingToggle({ value, onChange }: { value: Billing; onChange: (b: Billing) => void }) {
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
                className="absolute inset-0 rounded-lg bg-primary shadow-md shadow-primary/25"
              />
            ) : null}
            <span className="relative">{option === 'monthly' ? 'Monthly' : 'Yearly'}</span>
            {option === 'yearly' ? (
              <span
                className={cn(
                  'relative rounded-md px-1.5 py-0.5 text-[11px] font-bold',
                  active ? 'bg-white/20 text-white' : 'bg-accent text-accent-foreground',
                )}
              >
                Save 20%
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function Price({ plan, billing }: { plan: Plan; billing: Billing }) {
  const amount = billing === 'monthly' ? plan.monthly : plan.yearly;
  const muted = plan.popular ? 'text-slate-400' : 'text-muted-foreground';

  if (amount === null) {
    return (
      <div className="flex h-[4.5rem] flex-col justify-end">
        <p className="font-display text-4xl font-extrabold tracking-tight">Custom</p>
        <p className={cn('mt-1 text-sm', muted)}>Tailored to your branches</p>
      </div>
    );
  }

  return (
    <div className="flex h-[4.5rem] flex-col justify-end">
      <div className="flex items-end gap-1.5">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={amount}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.2 }}
            className="font-display tabular text-5xl leading-none font-extrabold tracking-tight"
          >
            {inr(amount)}
          </motion.span>
        </AnimatePresence>
        <span className={cn('pb-1 text-sm', muted)}>/ branch / month</span>
      </div>
      <p className={cn('mt-2 text-sm', muted)}>
        {billing === 'yearly' ? `Billed yearly, ${inr(amount * 12)} per branch` : 'Billed monthly'}
      </p>
    </div>
  );
}

export function PricingSection() {
  const [billing, setBilling] = useState<Billing>('yearly');

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
            Simple pricing that grows with every branch
          </h2>
          <p className="mt-5 text-lg text-pretty text-muted-foreground">
            Pay per branch, switch plans any time, and keep every order, bill and report in one
            place.
          </p>
          <div className="mt-9">
            <BillingToggle value={billing} onChange={setBilling} />
          </div>
        </Reveal>

        <Stagger
          gap={0.12}
          className="mt-14 grid items-stretch gap-6 lg:mt-16 lg:grid-cols-3 lg:items-center"
        >
          {plans.map((plan) => {
            const Icon = plan.icon;
            const dark = plan.popular;
            return (
              <StaggerItem
                key={plan.name}
                whileHover={{ y: -6 }}
                className={cn(
                  'relative mx-auto flex w-full max-w-md flex-col rounded-2xl p-7 transition-shadow sm:p-8 lg:max-w-none',
                  dark
                    ? 'bg-slate-950 text-white shadow-2xl shadow-emerald-900/30 ring-2 ring-emerald-500 lg:py-11'
                    : 'bg-card shadow-lg shadow-slate-900/5 ring-1 ring-border hover:shadow-xl',
                )}
              >
                {dark ? (
                  <>
                    {/* soft glow behind the featured card's top edge */}
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400 to-transparent"
                    />
                    <span className="absolute -top-3.5 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-lg bg-primary px-3 py-1 text-xs font-bold text-primary-foreground shadow-lg shadow-primary/30">
                      <Sparkles className="size-3.5" />
                      Most popular
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
                <p
                  className={cn('mt-3 text-sm', dark ? 'text-slate-400' : 'text-muted-foreground')}
                >
                  {plan.tagline}
                </p>

                <div className="mt-7">
                  <Price plan={plan} billing={billing} />
                </div>

                <Link
                  href={plan.cta.href}
                  className={cn(
                    buttonVariants({ size: 'lg' }),
                    'mt-8 h-12 w-full rounded-lg font-semibold',
                    dark
                      ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/30 hover:bg-emerald-400'
                      : plan.monthly === null
                        ? 'bg-secondary text-secondary-foreground hover:bg-secondary/90'
                        : 'bg-card text-foreground ring-1 ring-border hover:bg-muted',
                  )}
                >
                  {plan.cta.label} <ArrowRight />
                </Link>

                <div className={cn('my-8 h-px', dark ? 'bg-white/10' : 'bg-border')} aria-hidden />

                <p className="text-sm font-semibold">{plan.featuresTitle}</p>
                <ul className="mt-4 space-y-3.5 text-sm">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-3">
                      <span
                        className={cn(
                          'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full',
                          dark ? 'bg-emerald-500 text-white' : 'bg-accent text-primary',
                        )}
                      >
                        <Check className="size-3" strokeWidth={3} />
                      </span>
                      <span className={dark ? 'text-slate-200' : 'text-foreground/85'}>
                        {feature}
                      </span>
                    </li>
                  ))}
                </ul>
              </StaggerItem>
            );
          })}
        </Stagger>

        <Reveal className="mt-12 text-center text-sm text-muted-foreground">
          Prices are per branch and exclude GST. Running more than 25 branches?{' '}
          <a href="#" className="font-semibold text-primary hover:underline">
            Talk to us about volume pricing
          </a>
          .
        </Reveal>
      </div>
    </section>
  );
}
