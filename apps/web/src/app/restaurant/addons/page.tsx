'use client';

import { Button, buttonVariants } from '@foodstack/ui/components/button';
import { cn } from '@foodstack/ui/lib/utils';
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  CreditCard,
  Loader2,
  PackagePlus,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import {
  ADDON_TYPE_LABEL,
  type AddonPackage,
  type AddonType,
  addonQuantity,
  type OrderAllowance,
  useAddonMarketplace,
  useRequestAddon,
  validityLabel,
} from '@/lib/addons';
import { authErrorMessage } from '@/lib/auth/errors';
import {
  type Invoice,
  money,
  useBillingMutations,
  useInvoiceCheckout,
  useSubscription,
} from '@/lib/billing';

const dateFmt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' });
const fmt = (n: number) => n.toLocaleString('en-IN');

/**
 * Restaurant Admin → Usage & add-ons. Monthly order usage with 80 / 90 / 100 % warnings, packs
 * on sale, purchase confirmation and payment, and purchase history. Every figure (allowance,
 * remaining orders, prices) comes from the server; capacity is added only after the server
 * verifies the payment.
 */
export default function AddonsPage() {
  const market = useAddonMarketplace();
  const sub = useSubscription();
  const [confirming, setConfirming] = useState<AddonPackage | null>(null);
  const [justPaid, setJustPaid] = useState<string | null>(null);

  if (market.isError)
    return (
      <p
        role="alert"
        className="mx-auto max-w-3xl rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
      >
        {authErrorMessage(market.error)}
      </p>
    );
  const m = market.data;
  const types = m ? ([...new Set(m.packages.map((p) => p.addonType))] as AddonType[]) : [];
  const paidPurchase = justPaid ? m?.purchases.find((p) => p.invoiceId === justPaid) : undefined;

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Usage &amp; add-ons</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Buy extra capacity when you need it, without changing your plan.
        </p>
      </div>

      {paidPurchase ? (
        <div
          role="status"
          className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200"
        >
          <CheckCircle2 className="mt-0.5 size-5 shrink-0" />
          <div className="flex-1">
            <p className="font-semibold">
              {addonQuantity(paidPurchase.addonType, paidPurchase.quantity)} added
            </p>
            <p>
              {m?.orders.remaining !== null && m?.orders.remaining !== undefined
                ? `You now have ${fmt(m.orders.remaining)} orders left this month. New orders are allowed again.`
                : 'Your extra capacity is active now.'}
            </p>
          </div>
          <button type="button" aria-label="Dismiss" onClick={() => setJustPaid(null)}>
            <X className="size-4" />
          </button>
        </div>
      ) : null}

      {!m ? (
        <div className="h-48 animate-pulse rounded-xl border bg-card" />
      ) : (
        <OrderUsage orders={m.orders} canManage={m.canManage} />
      )}

      {m?.pendingInvoice ? (
        <PendingPayment
          invoice={m.pendingInvoice}
          canManage={m.canManage}
          online={sub.data?.onlinePayments ?? false}
          instructions={sub.data?.paymentInstructions ?? null}
          onPaid={(id) => setJustPaid(id)}
        />
      ) : null}

      <section id="packs" className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Add-on packs</h2>
            <p className="text-sm text-muted-foreground">
              Capacity is added the moment your payment is confirmed.
            </p>
          </div>
          <Link
            href="/restaurant/profile#subscription"
            className="inline-flex items-center gap-1 text-sm font-medium text-emerald-700 hover:underline dark:text-emerald-400"
          >
            Compare plans <ArrowUpRight className="size-4" />
          </Link>
        </div>
        {!m ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-44 animate-pulse rounded-xl border bg-card" />
            ))}
          </div>
        ) : m.packages.length === 0 ? (
          <p className="rounded-xl border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
            No add-ons are on sale right now. Upgrade your plan for more capacity.
          </p>
        ) : (
          types.map((t) => (
            <div key={t} className="space-y-2">
              <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
                {ADDON_TYPE_LABEL[t]}
              </h3>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {m.packages
                  .filter((p) => p.addonType === t)
                  .map((p) => (
                    <PackCard
                      key={p.id}
                      pack={p}
                      canBuy={m.canManage && m.hasAccess && !m.pendingInvoice}
                      reason={
                        !m.canManage
                          ? 'Ask the owner to buy add-ons'
                          : !m.hasAccess
                            ? 'Renew your plan first'
                            : m.pendingInvoice
                              ? 'Finish the payment in progress first'
                              : null
                      }
                      onBuy={() => setConfirming(p)}
                    />
                  ))}
              </div>
            </div>
          ))
        )}
      </section>

      {m ? <History purchases={m.purchases} /> : null}

      {confirming ? (
        <ConfirmPurchase
          pack={confirming}
          online={sub.data?.onlinePayments ?? false}
          onClose={() => setConfirming(null)}
          onPaid={(id) => {
            setJustPaid(id);
            setConfirming(null);
          }}
        />
      ) : null}
    </div>
  );
}

function OrderUsage({ orders: o, canManage }: { orders: OrderAllowance; canManage: boolean }) {
  if (o.total === null) {
    return (
      <section className="rounded-xl border bg-card p-5 shadow-xs">
        <h2 className="text-sm font-medium text-muted-foreground">Monthly orders</h2>
        <p className="mt-1 text-2xl font-semibold">{fmt(o.used)} this month</p>
        <p className="mt-1 text-sm text-muted-foreground">Your plan includes unlimited orders.</p>
      </section>
    );
  }
  const tone =
    o.warning === 100
      ? {
          bar: 'bg-red-500',
          box: 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200',
        }
      : o.warning === 90
        ? {
            bar: 'bg-orange-500',
            box: 'border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-200',
          }
        : o.warning === 80
          ? {
              bar: 'bg-amber-500',
              box: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
            }
          : { bar: 'bg-emerald-500', box: '' };
  return (
    <section className="space-y-4 rounded-xl border bg-card p-5 shadow-xs">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-muted-foreground">Monthly orders</h2>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {fmt(o.used)}{' '}
            <span className="text-base font-normal text-muted-foreground">
              of {fmt(o.total)} used
            </span>
          </p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-semibold tabular-nums">{fmt(o.remaining ?? 0)}</p>
          <p className="text-sm text-muted-foreground">orders remaining</p>
        </div>
      </div>
      <div
        className="h-2.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="Monthly orders used"
        aria-valuenow={o.percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-700', tone.bar)}
          style={{ width: `${o.percent}%` }}
        />
      </div>
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Plan</dt>
          <dd className="font-medium tabular-nums">{fmt(o.planLimit ?? 0)}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Add-on orders</dt>
          <dd className="font-medium tabular-nums">+{fmt(o.addonOrders)}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Total this month</dt>
          <dd className="font-medium tabular-nums">{fmt(o.total)}</dd>
        </div>
      </dl>
      {o.warning ? (
        <div
          role="alert"
          className={cn(
            'flex flex-col gap-3 rounded-lg border p-3 text-sm sm:flex-row sm:items-center',
            tone.box,
          )}
        >
          <AlertTriangle className="size-5 shrink-0" />
          <div className="flex-1">
            <p className="font-semibold">
              {o.warning === 100
                ? 'Subscription limit reached'
                : `You have used ${o.warning}% of this month's orders`}
            </p>
            <p>
              {o.warning === 100
                ? 'New orders are paused until you add more. Buy an order pack to continue right away, or upgrade your plan.'
                : `${fmt(o.remaining ?? 0)} orders left. Add a pack now so service is never interrupted.`}
            </p>
          </div>
          {canManage ? (
            <div className="flex shrink-0 gap-2">
              <a href="#packs" className={buttonVariants({ size: 'sm' })}>
                <PackagePlus /> Buy extra orders
              </a>
              <Link
                href="/restaurant/profile#subscription"
                className={buttonVariants({ size: 'sm', variant: 'outline' })}
              >
                Upgrade plan
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function PackCard({
  pack: p,
  canBuy,
  reason,
  onBuy,
}: {
  pack: AddonPackage;
  canBuy: boolean;
  reason: string | null;
  onBuy: () => void;
}) {
  return (
    <div
      className={cn(
        'relative flex flex-col rounded-xl border bg-card p-5 shadow-xs',
        p.isPopular &&
          'border-emerald-300 ring-1 ring-emerald-200 dark:border-emerald-500/40 dark:ring-emerald-500/20',
      )}
    >
      {p.isPopular ? (
        <span className="absolute -top-2.5 right-4 inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-0.5 text-[11px] font-semibold text-white">
          <Sparkles className="size-3" /> Popular
        </span>
      ) : null}
      <p className="text-sm font-medium text-muted-foreground">{p.name}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">
        +{addonQuantity(p.addonType, p.quantity)}
      </p>
      <p className="mt-3 text-xl font-semibold tabular-nums">
        {money(p.priceMinor, p.currencyCode)}
      </p>
      <p className="text-xs text-muted-foreground">One-time payment · {validityLabel(p)}</p>
      {p.description ? (
        <p className="mt-3 flex-1 text-sm text-muted-foreground">{p.description}</p>
      ) : (
        <span className="flex-1" />
      )}
      <Button className="mt-4" disabled={!canBuy} onClick={onBuy} title={reason ?? undefined}>
        <PackagePlus /> Buy pack
      </Button>
      {!canBuy && reason ? (
        <p className="mt-1.5 text-center text-xs text-muted-foreground">{reason}</p>
      ) : null}
    </div>
  );
}

/** Purchase confirmation: shows exactly what is bought, then creates the request and pays. */
function ConfirmPurchase({
  pack: p,
  online,
  onClose,
  onPaid,
}: {
  pack: AddonPackage;
  online: boolean;
  onClose: () => void;
  onPaid: (invoiceId: string) => void;
}) {
  const requestAddon = useRequestAddon();
  const pay = useInvoiceCheckout();
  const [error, setError] = useState<string | null>(null);
  const busy = requestAddon.isPending || pay.isPending;

  const confirm = async (payOnline: boolean) => {
    setError(null);
    try {
      const inv = await requestAddon.mutateAsync(p.id);
      if (!payOnline) {
        onClose();
        return;
      }
      const result = await pay.mutateAsync(inv.id);
      if (result === 'paid') onPaid(inv.id);
      else if (result === 'failed')
        setError(
          'The payment did not go through and you have not been charged. You can try again below.',
        );
      else onClose();
    } catch (e) {
      setError(authErrorMessage(e));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm add-on purchase"
    >
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-950/50 backdrop-blur-[2px]"
        onClick={busy ? undefined : onClose}
      />
      <div className="relative w-full max-w-md rounded-xl border bg-card shadow-2xl">
        <div className="border-b p-5">
          <h2 className="text-lg font-semibold">Confirm your purchase</h2>
          <p className="text-sm text-muted-foreground">Review the pack before paying.</p>
        </div>
        <dl className="divide-y px-5 text-sm">
          {[
            ['Pack', p.name],
            ['You get', `+${addonQuantity(p.addonType, p.quantity)}`],
            ['Validity', validityLabel(p)],
            ['Price', money(p.priceMinor, p.currencyCode)],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 py-3">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="text-right font-medium">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mx-5 mb-4 flex gap-2 rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
          <ShieldCheck className="size-4 shrink-0 text-emerald-600" />
          Your plan does not change. The extra capacity is added only after the payment is confirmed
          {online ? ' (instantly when you pay online)' : ' by the FoodStack team'}.
        </p>
        {error ? (
          <p
            role="alert"
            className="mx-5 mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300"
          >
            {error}
          </p>
        ) : null}
        <div className="flex flex-col gap-2 border-t p-4 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {online ? (
            <>
              <Button variant="outline" disabled={busy} onClick={() => void confirm(false)}>
                Pay offline
              </Button>
              <Button disabled={busy} onClick={() => void confirm(true)}>
                {busy ? <Loader2 className="animate-spin" /> : <CreditCard />} Pay{' '}
                {money(p.priceMinor, p.currencyCode)}
              </Button>
            </>
          ) : (
            <Button disabled={busy} onClick={() => void confirm(false)}>
              {busy ? <Loader2 className="animate-spin" /> : null} Confirm request
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Payment status for the request in progress: pay online, offline instructions, or cancel. */
function PendingPayment({
  invoice: inv,
  canManage,
  online,
  instructions,
  onPaid,
}: {
  invoice: Invoice;
  canManage: boolean;
  online: boolean;
  instructions: string | null;
  onPaid: (invoiceId: string) => void;
}) {
  const pay = useInvoiceCheckout();
  const { cancel } = useBillingMutations();
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="space-y-3 rounded-xl border border-violet-200 bg-violet-50 p-5 text-sm text-violet-900 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-100">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex gap-3">
          <Clock className="mt-0.5 size-5 shrink-0" />
          <div>
            <p className="font-semibold">
              Awaiting payment · {inv.planName} · {money(inv.amountMinor, inv.currencyCode)}
            </p>
            <p className="opacity-80">
              Invoice {inv.invoiceNumber}. Nothing is added until the payment is confirmed.
            </p>
            {inv.failureReason ? (
              <p className="mt-1 font-medium text-red-700 dark:text-red-300">
                Last attempt failed: {inv.failureReason}
              </p>
            ) : null}
          </div>
        </div>
        {canManage ? (
          <div className="flex gap-2">
            {online ? (
              <Button
                size="sm"
                disabled={pay.isPending}
                onClick={() => {
                  setError(null);
                  pay.mutate(inv.id, {
                    onSuccess: (r) =>
                      r === 'paid'
                        ? onPaid(inv.id)
                        : r === 'failed' &&
                          setError('The payment did not go through. You have not been charged.'),
                    onError: (e) => setError(authErrorMessage(e)),
                  });
                }}
              >
                {pay.isPending ? <Loader2 className="animate-spin" /> : <CreditCard />} Pay now
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={cancel.isPending}
              onClick={() =>
                cancel.mutate(inv.id, { onError: (e) => setError(authErrorMessage(e)) })
              }
            >
              Cancel request
            </Button>
          </div>
        ) : null}
      </div>
      {instructions ? (
        <pre className="rounded-lg bg-white/70 p-3 font-sans whitespace-pre-wrap dark:bg-black/20">
          {instructions}
        </pre>
      ) : null}
      {error ? (
        <p role="alert" className="text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function History({ purchases }: { purchases: import('@/lib/addons').AddonPurchase[] }) {
  const tone = {
    active:
      'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20',
    expired:
      'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-white/5 dark:text-slate-400 dark:ring-white/10',
    revoked:
      'bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/20',
  } as const;
  const label = { active: 'Active', expired: 'Expired', revoked: 'Refunded' } as const;
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">Purchase history</h2>
      {purchases.length === 0 ? (
        <p className="rounded-xl border border-dashed bg-card p-6 text-center text-sm text-muted-foreground">
          No add-ons bought yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full min-w-[44rem] text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs font-medium text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5">Pack</th>
                <th className="px-4 py-2.5">Invoice</th>
                <th className="px-4 py-2.5 text-right">Price</th>
                <th className="px-4 py-2.5">Valid</th>
                <th className="px-4 py-2.5 text-right">Used</th>
                <th className="px-4 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {purchases.map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-3 font-medium">{p.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {p.invoiceNumber}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {money(p.priceMinor, 'INR')}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {dateFmt.format(new Date(p.startsAt))} – {dateFmt.format(new Date(p.expiresAt))}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {p.used === null ? '—' : `${fmt(p.used)} / ${fmt(p.quantity)}`}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
                        tone[p.status],
                      )}
                      title={p.revokeReason ?? undefined}
                    >
                      {label[p.status]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
