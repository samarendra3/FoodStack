'use client';

import { Button, buttonVariants } from '@foodstack/ui/components/button';
import { Dialog } from '@foodstack/ui/components/dialog';
import { cn } from '@foodstack/ui/lib/utils';
import {
  AlertTriangle,
  CalendarClock,
  Check,
  CreditCard,
  Clock,
  Copy,
  Loader2,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { authErrorMessage } from '@/lib/auth/errors';
import {
  type Cycle,
  KIND_LABEL,
  money,
  PAYMENT_STATUS_META,
  type Plan,
  STATUS_META,
  type SubscriptionOverview,
  useBillingMutations,
  useInvoiceCheckout,
  usePlanCheckout,
  useSubscription,
} from '@/lib/billing';
import {
  FEATURE_LABELS,
  type FeatureKey,
  limitLabel,
  planHighlights,
  sellsCycle,
} from '@/lib/plans';
import { useNotify } from '@/lib/notify';
import { ErrorBox } from './profile-tab';

const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function SubscriptionTab({ onOpenBilling }: { onOpenBilling: () => void }) {
  const sub = useSubscription();
  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [confirm, setConfirm] = useState<{ plan: Plan; cycle: Cycle } | null>(null);

  if (sub.isError) return <ErrorBox message={authErrorMessage(sub.error)} />;
  const s = sub.data;
  if (!s) return <div className="h-96 animate-pulse rounded-2xl bg-muted" />;
  const shownCycle = cycle ?? s.billingCycle ?? 'monthly';

  return (
    <div className="space-y-6">
      <ExpiryAlert
        s={s}
        onRenew={() => s.plan && setConfirm({ plan: s.plan, cycle: s.billingCycle ?? 'monthly' })}
      />
      {s.pendingInvoice ? <PendingPayment s={s} /> : null}
      <Overview
        s={s}
        onRenew={() => s.plan && setConfirm({ plan: s.plan, cycle: s.billingCycle ?? 'monthly' })}
        onOpenBilling={onOpenBilling}
      />
      <Usage s={s} />

      <section id="plans-anchor" className="scroll-mt-4 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Plans</h2>
            <p className="text-sm text-muted-foreground">
              Compare plans and switch when you need more.
            </p>
          </div>
          <div
            className="flex rounded-xl border bg-card p-1 text-sm font-medium"
            role="radiogroup"
            aria-label="Billing cycle"
          >
            {(['monthly', 'yearly'] as const).map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={shownCycle === c}
                onClick={() => setCycle(c)}
                className={cn(
                  'rounded-lg px-4 py-1.5 capitalize',
                  shownCycle === c ? 'bg-primary text-primary-foreground' : 'text-muted-foreground',
                )}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
        {s.plans.length === 0 ? (
          <p className="rounded-2xl border border-dashed bg-card px-6 py-12 text-center text-sm text-muted-foreground">
            Plans are being set up by the FoodStack team. Contact support to subscribe.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {s.plans.map((p) => (
              <PlanCard
                key={p.id}
                plan={p}
                cycle={shownCycle}
                s={s}
                onChoose={() => setConfirm({ plan: p, cycle: shownCycle })}
              />
            ))}
          </div>
        )}
        {s.plans.length > 1 ? (
          <PlanComparison plans={s.plans} currentId={s.plan?.id ?? null} />
        ) : null}
      </section>

      {confirm ? (
        <ConfirmChange
          s={s}
          plan={confirm.plan}
          cycle={confirm.cycle}
          onClose={() => setConfirm(null)}
        />
      ) : null}
    </div>
  );
}

function ExpiryAlert({ s, onRenew }: { s: SubscriptionOverview; onRenew: () => void }) {
  if (s.alert === 'none' || !s.periodEnd || s.status === 'pending_payment') return null;
  const tone =
    s.alert === 'expired'
      ? 'border-red-200 bg-red-50 text-red-800 dark:bg-red-500/10 dark:text-red-200'
      : s.alert === 'urgent'
        ? 'border-orange-200 bg-orange-50 text-orange-800 dark:bg-orange-500/10 dark:text-orange-200'
        : 'border-amber-200 bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200';
  const what =
    s.status === 'trialing' || (!s.plan && s.trialEndsAt) ? 'free trial' : 'subscription';
  const title =
    s.alert === 'expired'
      ? `Your ${what} has expired`
      : s.alert === 'urgent'
        ? `Your ${what} ends in ${s.remainingDays} day${s.remainingDays === 1 ? '' : 's'}`
        : `Your ${what} is expiring soon`;
  return (
    <div
      role="alert"
      className={cn('flex flex-col gap-3 rounded-2xl border p-4 sm:flex-row sm:items-center', tone)}
    >
      <AlertTriangle className="size-5 shrink-0" />
      <div className="flex-1">
        <p className="font-semibold">{title}</p>
        <p className="text-sm opacity-90">
          {s.alert === 'expired' ? 'Ended' : 'Ends'} on {day.format(new Date(s.periodEnd))}
          {s.alert !== 'expired' ? ` · ${s.remainingDays} days remaining` : ''}. Your data is kept
          safe.
        </p>
      </div>
      {s.canManage ? (
        <div className="flex gap-2">
          {s.plan ? <Button onClick={onRenew}>Renew now</Button> : null}
          <Button
            variant="outline"
            onClick={() =>
              document.getElementById('plans-anchor')?.scrollIntoView({ behavior: 'smooth' })
            }
          >
            {s.plan ? 'Upgrade plan' : 'Choose a plan'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function PendingPayment({ s }: { s: SubscriptionOverview }) {
  const inv = s.pendingInvoice!;
  const m = useBillingMutations();
  const pay = useInvoiceCheckout();
  const [copied, setCopied] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  return (
    <section className="rounded-2xl border border-violet-200 bg-violet-50 p-5 dark:border-violet-500/30 dark:bg-violet-500/10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <Clock className="size-6 shrink-0 text-violet-600" />
        <div className="flex-1 space-y-2">
          <p className="flex flex-wrap items-center gap-2 font-semibold">
            {inv.failureReason ? 'Payment failed' : 'Awaiting payment'} · {KIND_LABEL[inv.kind]}
            {' — '}
            {inv.planName}
            {inv.billingCycle ? ` (${inv.billingCycle})` : ''}
            {inv.paymentStatus ? (
              <span
                className={cn(
                  'inline-flex rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
                  PAYMENT_STATUS_META[inv.paymentStatus].cls,
                )}
              >
                {PAYMENT_STATUS_META[inv.paymentStatus].label}
              </span>
            ) : null}
          </p>
          {inv.failureReason ? (
            <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-300">
              Last payment attempt failed
              {inv.failedAt ? ` on ${day.format(new Date(inv.failedAt))}` : ''}: {inv.failureReason}
              . You have not been charged; please try again.
            </p>
          ) : null}
          {payError ? (
            <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-300">
              {payError}
            </p>
          ) : null}
          <p className="text-sm">
            Invoice <span className="font-mono font-semibold">{inv.invoiceNumber}</span> for{' '}
            <span className="font-semibold">{money(inv.amountMinor, inv.currencyCode)}</span>.{' '}
            {s.onlinePayments
              ? 'Pay online to activate instantly, or pay offline and the FoodStack team will confirm it.'
              : inv.kind === 'addon'
                ? 'The extra capacity is added only after the FoodStack team confirms your payment.'
                : 'Your plan changes only after the FoodStack team confirms your payment.'}
          </p>
          {s.paymentInstructions ? (
            <pre className="rounded-lg bg-white/70 p-3 font-sans text-sm whitespace-pre-wrap dark:bg-black/20">
              {s.paymentInstructions}
            </pre>
          ) : (
            <p className="text-sm">
              Our team will contact you with payment details. You can also reach support and quote
              the invoice number.
            </p>
          )}
          <p className="text-xs opacity-80">Use the invoice number as the payment reference.</p>
        </div>
        <div className="flex flex-wrap gap-2 sm:flex-col">
          {s.canManage && s.onlinePayments ? (
            <Button
              disabled={pay.isPending}
              onClick={() => {
                setPayError(null);
                pay.mutate(inv.id, {
                  onSuccess: (r) =>
                    r === 'failed' &&
                    setPayError('The payment did not go through. You have not been charged.'),
                  onError: (e) => setPayError(authErrorMessage(e)),
                });
              }}
            >
              {pay.isPending ? <Loader2 className="animate-spin" /> : <CreditCard />}{' '}
              {inv.failureReason
                ? `Retry payment · ${money(inv.amountMinor, inv.currencyCode)}`
                : `Pay ${money(inv.amountMinor, inv.currencyCode)} now`}
            </Button>
          ) : null}
          <Button
            variant="outline"
            onClick={() => {
              void navigator.clipboard?.writeText(inv.invoiceNumber);
              setCopied(true);
            }}
          >
            {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy invoice no.'}
          </Button>
          {s.canManage ? (
            <Button
              variant="ghost"
              disabled={m.cancel.isPending}
              onClick={() => m.cancel.mutate(inv.id)}
            >
              <X /> Cancel request
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function Overview({
  s,
  onRenew,
  onOpenBilling,
}: {
  s: SubscriptionOverview;
  onRenew: () => void;
  onOpenBilling: () => void;
}) {
  const st = STATUS_META[s.status];
  const pct = Math.round((1 - s.elapsed) * 100);
  return (
    <section className="overflow-hidden rounded-2xl border bg-card">
      <div className="grid gap-6 bg-gradient-to-br from-emerald-600 to-emerald-800 p-6 text-white lg:grid-cols-[1fr_auto]">
        <div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-xs font-semibold">
            <span className={cn('size-1.5 rounded-full', st.dot)} /> {st.label}
          </span>
          <h2 className="mt-3 text-2xl font-bold">
            {s.plan
              ? `${s.plan.name} plan`
              : s.status === 'trialing'
                ? 'Free trial'
                : 'No active plan'}
          </h2>
          <p className="mt-1 text-sm text-emerald-50/90">
            {s.price !== null && s.billingCycle
              ? `${money(s.price, s.plan?.currencyCode)} / ${s.billingCycle === 'yearly' ? 'year' : 'month'}`
              : s.status === 'trialing'
                ? 'Explore every feature before choosing a plan.'
                : 'Choose a plan below to continue.'}
          </p>
        </div>
        <div className="text-left lg:text-right">
          <p className="text-5xl font-bold tabular-nums">{s.remainingDays}</p>
          <p className="text-sm text-emerald-50/90">days remaining</p>
        </div>
      </div>
      <div className="space-y-5 p-6">
        {s.periodStart && s.periodEnd ? (
          <div>
            <div className="mb-1.5 flex justify-between text-xs text-muted-foreground">
              <span>{day.format(new Date(s.periodStart))}</span>
              <span>
                {pct}% of {s.totalDays} days left
              </span>
              <span>{day.format(new Date(s.periodEnd))}</span>
            </div>
            <div
              className="h-2.5 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Time remaining in this period"
            >
              <div
                className={cn(
                  'h-full rounded-full',
                  s.alert === 'none'
                    ? 'bg-emerald-500'
                    : s.alert === 'soon'
                      ? 'bg-amber-500'
                      : 'bg-red-500',
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        ) : null}
        <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Fact k="Started" v={s.periodStart ? day.format(new Date(s.periodStart)) : '—'} />
          <Fact
            k={s.status === 'expired' ? 'Expired on' : 'Expires on'}
            v={s.periodEnd ? day.format(new Date(s.periodEnd)) : '—'}
          />
          <Fact
            k="Billing cycle"
            v={s.billingCycle ? (s.billingCycle === 'yearly' ? 'Yearly' : 'Monthly') : '—'}
          />
          <Fact k="Auto-renewal" v="Off · renew manually" />
        </dl>
        <div className="flex flex-wrap gap-2">
          {s.canManage && s.plan && !s.pendingInvoice ? (
            <Button onClick={onRenew}>
              <CalendarClock /> Renew subscription
            </Button>
          ) : null}
          <Button variant="outline" onClick={onOpenBilling}>
            View billing history
          </Button>
        </div>
      </div>
    </section>
  );
}

function Usage({ s }: { s: SubscriptionOverview }) {
  // The limits this restaurant agreed to (frozen at payment), as enforced by the server.
  const l = s.limits;
  const rows = [
    { label: 'Branches', used: s.usage.branches, limit: l?.branches ?? null },
    { label: 'Staff members', used: s.usage.staff, limit: l?.staff ?? null },
    { label: 'Orders this month', used: s.usage.ordersThisMonth, limit: l?.ordersPerMonth ?? null },
    { label: 'Menu items', used: s.usage.menuItems, limit: l?.menuItems ?? null },
  ];
  return (
    <section className="rounded-2xl border bg-card p-6">
      <h2 className="font-semibold">Plan usage</h2>
      <p className="text-sm text-muted-foreground">
        {s.plan
          ? `Against the limits of your ${s.plan.name} plan.`
          : s.status === 'trialing'
            ? 'Against the limits of your free trial.'
            : 'Choose a plan to see its limits.'}
      </p>
      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        {rows.map((r) => {
          const pct = r.limit ? Math.min(100, Math.round((r.used / r.limit) * 100)) : 0;
          const warn = r.limit !== null && pct >= 80;
          return (
            <div key={r.label}>
              <div className="flex justify-between text-sm">
                <span className="font-medium">{r.label}</span>
                <span
                  className={cn(
                    'tabular-nums',
                    warn ? 'font-semibold text-amber-700' : 'text-muted-foreground',
                  )}
                >
                  {r.used.toLocaleString()} /{' '}
                  {r.limit === null ? 'Unlimited' : r.limit.toLocaleString()}
                </span>
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    'h-full rounded-full',
                    pct >= 100 ? 'bg-red-500' : warn ? 'bg-amber-500' : 'bg-emerald-500',
                  )}
                  style={{ width: r.limit === null ? '0%' : `${pct}%` }}
                />
              </div>
              {warn ? (
                <p className="mt-1 text-xs text-amber-700">
                  {pct >= 100 ? 'Limit reached' : 'Approaching your limit'} — consider upgrading.
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function PlanCard({
  plan,
  cycle,
  s,
  onChoose,
}: {
  plan: Plan;
  cycle: Cycle;
  s: SubscriptionOverview;
  onChoose: () => void;
}) {
  const current = s.plan?.id === plan.id;
  const price = cycle === 'yearly' ? plan.priceYearlyMinor : plan.priceMonthlyMinor;
  const action = plan.customPricing
    ? 'Contact sales'
    : !s.plan
      ? 'Choose plan'
      : current
        ? s.billingCycle === cycle
          ? 'Renew'
          : `Switch to ${cycle}`
        : (plan.priceMonthlyMinor ?? 0) >= (s.plan.priceMonthlyMinor ?? 0)
          ? 'Upgrade'
          : 'Downgrade';
  return (
    <div
      className={cn(
        'flex flex-col rounded-2xl border bg-card p-6',
        current && 'border-primary ring-2 ring-primary/15',
      )}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">{plan.name}</h3>
        {current ? (
          <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">
            Current plan
          </span>
        ) : null}
      </div>
      {plan.description ? (
        <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>
      ) : null}
      <p className="mt-4">
        {plan.planType === 'free_trial' ? (
          <>
            <span className="text-3xl font-bold">Free</span>
            <span className="text-sm text-muted-foreground"> for {plan.trialDays} days</span>
          </>
        ) : price === null ? (
          <span className="text-3xl font-bold">Custom</span>
        ) : (
          <>
            <span className="text-3xl font-bold">{money(price, plan.currencyCode)}</span>
            <span className="text-sm text-muted-foreground">
              {' '}
              / {cycle === 'yearly' ? 'year' : 'month'}
            </span>
          </>
        )}
      </p>
      {cycle === 'yearly' && plan.yearlySavingsPercent > 0 ? (
        <p className="text-xs font-medium text-emerald-700">
          Save {plan.yearlySavingsPercent}% vs monthly
        </p>
      ) : null}
      <ul className="mt-5 flex-1 space-y-2 text-sm">
        {planHighlights(plan).map((f) => (
          <li
            key={f.label}
            className={cn('flex gap-2', !f.enabled && 'text-muted-foreground line-through')}
          >
            {f.enabled ? (
              <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            ) : (
              <X className="mt-0.5 size-4 shrink-0 text-slate-400" />
            )}
            {f.label}
            {f.enabled ? null : <span className="sr-only"> (not included)</span>}
          </li>
        ))}
      </ul>
      {plan.planType === 'free_trial' ? (
        <p className="mt-6 rounded-lg bg-muted/60 px-3 py-2 text-center text-xs text-muted-foreground">
          Every new restaurant starts here for {plan.trialDays} days.
        </p>
      ) : s.canManage && !plan.customPricing && !sellsCycle(plan, cycle) ? (
        <Button className="mt-6" variant="outline" disabled>
          {plan.billingCycles === 'yearly' ? 'Yearly billing only' : 'Monthly billing only'}
        </Button>
      ) : s.canManage && plan.customPricing ? (
        <a
          className={cn(buttonVariants({ variant: 'outline' }), 'mt-6')}
          href="mailto:sales@foodstack.app"
        >
          Contact sales
        </a>
      ) : s.canManage ? (
        <Button
          className="mt-6"
          variant={current ? 'outline' : 'default'}
          disabled={Boolean(s.pendingInvoice)}
          onClick={onChoose}
          title={
            s.pendingInvoice ? 'Finish or cancel the request awaiting payment first' : undefined
          }
        >
          {!current && !s.plan ? <Sparkles /> : null} {action}
        </Button>
      ) : null}
    </div>
  );
}

function ConfirmChange({
  s,
  plan,
  cycle,
  onClose,
}: {
  s: SubscriptionOverview;
  plan: Plan;
  cycle: Cycle;
  onClose: () => void;
}) {
  const m = useBillingMutations();
  const pay = usePlanCheckout();
  const notify = useNotify();
  const [error, setError] = useState<string | null>(null);
  const current = s.plan;
  const kind = !current
    ? 'new'
    : current.id === plan.id
      ? s.billingCycle === cycle
        ? 'renewal'
        : 'cycle_change'
      : (plan.priceMonthlyMinor ?? 0) >= (current.priceMonthlyMinor ?? 0)
        ? 'upgrade'
        : 'downgrade';
  // The server prices it: a renewal keeps the agreed price, everything else uses today's price.
  const price =
    kind === 'renewal' && s.price !== null
      ? s.price
      : ((cycle === 'yearly' ? plan.priceYearlyMinor : plan.priceMonthlyMinor) ?? 0);
  const activeEnd =
    s.periodEnd && s.remainingDays > 0 && current ? day.format(new Date(s.periodEnd)) : null;
  const explain: Record<string, string> = {
    new: `Your ${plan.name} plan starts when your payment is confirmed.`,
    renewal: activeEnd
      ? `Adds one ${cycle === 'yearly' ? 'year' : 'month'} after ${activeEnd}. No days are lost.`
      : 'Starts a new period when your payment is confirmed.',
    upgrade: `${plan.name} starts as soon as your payment is confirmed, with its higher limits. ${activeEnd ? `Unused days on ${current?.name} (until ${activeEnd}) are not carried over.` : ''}`,
    downgrade: activeEnd
      ? `${plan.name} applies from confirmation and your new period begins after ${activeEnd}, so no paid days are lost. Lower limits apply right away.`
      : `${plan.name} starts when your payment is confirmed.`,
    cycle_change: activeEnd
      ? `Your ${cycle} period begins after ${activeEnd}.`
      : `Your ${cycle} period starts when your payment is confirmed.`,
  };

  const busy = m.request.isPending || pay.isPending;
  const title =
    kind === 'new'
      ? `Subscribe to ${plan.name}`
      : kind === 'renewal'
        ? `Renew ${plan.name}`
        : kind === 'upgrade'
          ? `Upgrade to ${plan.name}`
          : kind === 'downgrade'
            ? `Switch to ${plan.name}`
            : `Switch to ${cycle} billing`;
  const cycleLabel = (c: Cycle | null) => (c === 'yearly' ? 'Yearly' : 'Monthly');

  return (
    <Dialog open onClose={onClose} dismissible={!busy} labelledBy="plan-change-title" size="md">
      <div className="flex gap-4 p-6 max-sm:flex-col">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300">
          <Sparkles className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 space-y-4">
          <div className="space-y-1">
            <h2 id="plan-change-title" className="text-base font-semibold tracking-tight">
              {title}
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">{explain[kind]}</p>
          </div>
          <dl className="divide-y rounded-lg border bg-muted/40 text-sm">
            {current ? (
              <div className="flex justify-between gap-4 px-3 py-2">
                <dt className="text-muted-foreground">Current plan</dt>
                <dd className="text-right">
                  {current.name} · {cycleLabel(s.billingCycle)}
                </dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-4 px-3 py-2">
              <dt className="text-muted-foreground">{current ? 'New plan' : 'Plan'}</dt>
              <dd className="text-right font-medium">
                {plan.name} · {cycleLabel(cycle)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 px-3 py-2.5">
              <dt className="font-medium">Amount due</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {money(price, plan.currencyCode)}
              </dd>
            </div>
          </dl>
          <p className="flex gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="size-4 shrink-0 text-emerald-600" aria-hidden />
            {s.onlinePayments
              ? 'Pay securely by card, UPI or net banking. Your plan activates as soon as the payment is verified.'
              : 'We’ll create an invoice marked Pending payment. Nothing changes until the FoodStack team verifies your payment.'}
          </p>
          {error ? (
            <p
              role="alert"
              className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300"
            >
              {error}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-col-reverse gap-2 border-t bg-muted/30 px-6 py-4 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant={s.onlinePayments ? 'outline' : 'default'}
          disabled={busy}
          onClick={() =>
            m.request.mutate(
              { planId: plan.id, billingCycle: cycle },
              {
                onSuccess: () => {
                  notify.success(
                    'Invoice created',
                    `${plan.name} starts once your payment is verified.`,
                  );
                  onClose();
                },
                onError: (e) => setError(authErrorMessage(e)),
              },
            )
          }
        >
          {m.request.isPending ? <Loader2 className="animate-spin" /> : null}
          {s.onlinePayments ? 'Pay offline (invoice)' : 'Create invoice'}
        </Button>
        {s.onlinePayments ? (
          <Button
            disabled={busy}
            onClick={() => {
              setError(null);
              pay.mutate(
                { planId: plan.id, billingCycle: cycle },
                {
                  onSuccess: (r) => {
                    if (r === 'paid') {
                      notify.success('Payment verified', `Your ${plan.name} plan is active.`);
                      onClose();
                    } else if (r === 'failed') {
                      setError('The payment did not go through. You have not been charged.');
                    }
                  },
                  onError: (e) =>
                    setError(
                      e instanceof Error && !('problem' in e) ? e.message : authErrorMessage(e),
                    ),
                },
              );
            }}
          >
            {pay.isPending ? <Loader2 className="animate-spin" /> : <CreditCard />} Pay{' '}
            {money(price, plan.currencyCode)}
          </Button>
        ) : null}
      </div>
    </Dialog>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{k}</dt>
      <dd className="mt-0.5 font-medium">{v}</dd>
    </div>
  );
}

/** Side-by-side limits and features for the offered plans (same data as the cards). */
function PlanComparison({ plans, currentId }: { plans: Plan[]; currentId: string | null }) {
  const rows: { label: string; value: (p: Plan) => string }[] = [
    { label: 'Branches', value: (p) => limitLabel(p.limits.branches, '', '').trim() },
    { label: 'Staff / users', value: (p) => limitLabel(p.limits.staff, '', '').trim() },
    { label: 'Orders / month', value: (p) => limitLabel(p.limits.ordersPerMonth, '', '').trim() },
    { label: 'Menu items', value: (p) => limitLabel(p.limits.menuItems, '', '').trim() },
    { label: 'Free trial', value: (p) => `${p.trialDays} days` },
    ...(Object.keys(FEATURE_LABELS) as FeatureKey[])
      .filter((k) => plans.some((p) => p.featureFlags[k]))
      .map((k) => ({
        label: FEATURE_LABELS[k],
        value: (p: Plan) => (p.featureFlags[k] ? '✓' : '—'),
      })),
  ];
  return (
    <details className="rounded-2xl border bg-card">
      <summary className="cursor-pointer px-5 py-3 text-sm font-semibold">Compare plans</summary>
      <div className="overflow-x-auto px-5 pb-5">
        <table className="w-full min-w-[32rem] text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="py-2 pr-4 font-medium text-muted-foreground">Feature</th>
              {plans.map((p) => (
                <th
                  key={p.id}
                  className={cn('py-2 pr-4 font-semibold', p.id === currentId && 'text-primary')}
                >
                  {p.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b last:border-0">
                <td className="py-2 pr-4 text-muted-foreground">{r.label}</td>
                {plans.map((p) => (
                  <td key={p.id} className="py-2 pr-4 tabular-nums">
                    {r.value(p)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
