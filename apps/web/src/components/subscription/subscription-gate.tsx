'use client';

import { Button, buttonVariants } from '@foodstack/ui/components/button';
import { cn } from '@foodstack/ui/lib/utils';
import { CalendarX2, Clock, Hourglass, Loader2, LogOut, ShieldAlert, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { BrandMark } from '@/components/auth/auth-layout';
import { useProfile } from '@/components/auth/auth-provider';
import { useSignOut } from '@/components/shell/header-widgets';
import { SubscriptionTab } from '@/app/restaurant/profile/subscription-tab';
import { type Entitlement, EXPIRED_MESSAGE, useEntitlement } from '@/lib/billing';

/** Pages that stay usable without an active subscription (profile, subscription, billing). */
const ALWAYS_OPEN = ['/restaurant/profile'];

const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'long' });

/**
 * Shows the subscription screen instead of operational pages when the restaurant's trial or plan
 * has lapsed. A UX layer only: the API refuses those requests (402) regardless.
 */
export function SubscriptionGate({ children }: { children: ReactNode }) {
  const profile = useProfile();
  const pathname = usePathname();
  const tenant = profile.audience === 'tenant';
  const open = ALWAYS_OPEN.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const ent = useEntitlement(tenant);

  if (!tenant || open) return <>{children}</>;
  if (ent.isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-muted-foreground">
        <Loader2 className="size-6 animate-spin text-primary" aria-label="Checking subscription" />
      </div>
    );
  }
  // If the check itself fails, let the page load: the API still enforces access.
  if (ent.data && !ent.data.hasAccess) return <SubscriptionLockedScreen e={ent.data} />;
  return <>{children}</>;
}

function copy(e: Entitlement) {
  const trialEnded = e.reminder === 'expired';
  switch (e.status) {
    case 'suspended':
      return {
        icon: ShieldAlert,
        title: 'Subscription suspended',
        body: `Access to this restaurant has been paused by FoodStack${e.reason ? `: ${e.reason}` : ''}. Your data is safe. Please contact support to resolve this.`,
      };
    case 'pending_payment':
      return {
        icon: Hourglass,
        title: 'Payment in progress',
        body: 'We are waiting for your payment to be confirmed. Access returns automatically as soon as it is verified. You can complete or retry the payment below.',
      };
    default:
      return {
        icon: CalendarX2,
        title: trialEnded ? 'Your free trial has ended' : 'Your subscription has expired',
        body: trialEnded
          ? EXPIRED_MESSAGE
          : 'Your FoodStack subscription has expired. Renew or choose a plan to continue using FoodStack.',
      };
  }
}

export function SubscriptionLockedScreen({ e }: { e: Entitlement }) {
  const profile = useProfile();
  const router = useRouter();
  const { leaving, leave } = useSignOut();
  const c = copy(e);
  const Icon = c.icon;
  const endedOn = e.trialEndsAt && e.reminder === 'expired' ? e.trialEndsAt : e.periodEnd;

  return (
    <div className="min-h-dvh bg-muted/30">
      <header className="flex items-center justify-between border-b bg-card px-4 py-3 sm:px-8">
        <div className="flex items-center gap-3">
          <BrandMark />
          <span className="hidden text-sm text-muted-foreground sm:inline">
            {profile.activeTenant?.name}
          </span>
        </div>
        <Button variant="ghost" size="sm" disabled={leaving} onClick={() => void leave()}>
          <LogOut /> Sign out
        </Button>
      </header>

      <main className="mx-auto max-w-[80rem] space-y-8 px-4 py-8 sm:px-8">
        <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
          <div className="flex flex-col gap-6 p-6 sm:flex-row sm:items-start sm:p-8">
            <div
              className={cn(
                'flex size-14 shrink-0 items-center justify-center rounded-2xl',
                e.status === 'pending_payment'
                  ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'
                  : 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
              )}
            >
              <Icon className="size-7" aria-hidden />
            </div>
            <div className="flex-1 space-y-3">
              <h1 className="text-2xl font-semibold tracking-tight">{c.title}</h1>
              <p className="max-w-2xl text-muted-foreground">{c.body}</p>
              <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
                {endedOn ? (
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      {e.reminder === 'expired' ? 'Trial ended on' : 'Ended on'}
                    </dt>
                    <dd className="font-medium">{day.format(new Date(endedOn))}</dd>
                  </div>
                ) : null}
                <div>
                  <dt className="text-xs text-muted-foreground">Your data</dt>
                  <dd className="font-medium">Kept safe: menu, orders, bills and customers</dd>
                </div>
              </dl>
              <div className="flex flex-wrap gap-2 pt-2">
                {e.canManage && e.status !== 'suspended' ? (
                  <Button
                    onClick={() =>
                      document
                        .getElementById('plans-anchor')
                        ?.scrollIntoView({ behavior: 'smooth' })
                    }
                  >
                    View Plans &amp; Subscribe
                  </Button>
                ) : null}
                <a
                  href="mailto:support@foodstack.app"
                  className={buttonVariants({ variant: 'outline' })}
                >
                  Contact support
                </a>
                {e.canManage ? (
                  <Link
                    href="/restaurant/profile#billing"
                    className={buttonVariants({ variant: 'ghost' })}
                  >
                    Billing history
                  </Link>
                ) : null}
              </div>
            </div>
          </div>
        </section>

        {e.canManage ? (
          e.status === 'suspended' ? null : (
            <SubscriptionTab onOpenBilling={() => router.push('/restaurant/profile#billing')} />
          )
        ) : (
          <p className="rounded-2xl border border-dashed bg-card px-6 py-10 text-center text-sm text-muted-foreground">
            Ask the restaurant owner or an admin to choose a plan. You&apos;ll be able to continue
            as soon as the subscription is active.
          </p>
        )}
      </main>
    </div>
  );
}

const DISMISS_KEY = 'fs-trial-reminder-dismissed';

/**
 * Trial reminders at 7, 3 and 1 days left. Dismissing hides that milestone only, so the next
 * one still shows.
 */
export function TrialReminderBanner() {
  const profile = useProfile();
  const ent = useEntitlement(profile.audience === 'tenant');
  const r = ent.data?.reminder;
  const id = `${profile.activeTenant?.id}:${r}`;
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return localStorage.getItem(DISMISS_KEY);
    } catch {
      return null; // storage unavailable (or server render): the banner stays visible
    }
  });

  if (!ent.data || (r !== 7 && r !== 3 && r !== 1) || dismissed === id) return null;
  const days = ent.data.remainingDays;
  const urgent = r === 1;
  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-3 border-b px-4 py-2.5 text-sm sm:px-6',
        urgent
          ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200'
          : r === 3
            ? 'border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-200'
            : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
      )}
    >
      <Clock className="size-4 shrink-0" aria-hidden />
      <p className="flex-1">
        <strong>
          {days <= 1 ? 'Your free trial ends today.' : `${days} days left in your free trial.`}
        </strong>{' '}
        {ent.data.trialEndsAt ? `It ends on ${day.format(new Date(ent.data.trialEndsAt))}. ` : ''}
        Subscribe to keep POS, orders and kitchen running without interruption.
      </p>
      {ent.data.canManage ? (
        <Link
          href="/restaurant/profile#subscription"
          className="rounded-lg bg-white/70 px-3 py-1 font-medium hover:bg-white dark:bg-white/10"
        >
          View plans
        </Link>
      ) : null}
      <button
        type="button"
        aria-label="Dismiss reminder"
        className="rounded p-1 opacity-70 hover:opacity-100"
        onClick={() => {
          setDismissed(id);
          try {
            localStorage.setItem(DISMISS_KEY, id);
          } catch {
            // Storage unavailable: dismissed for this visit only.
          }
        }}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
