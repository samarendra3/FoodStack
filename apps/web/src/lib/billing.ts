'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import type { PublicPlan } from '@/lib/plans';

export type SubscriptionStatus =
  'trialing' | 'active' | 'expired' | 'pending_payment' | 'past_due' | 'suspended' | 'cancelled';
export type AlertLevel = 'none' | 'soon' | 'urgent' | 'expired';
export type TrialReminder = 7 | 3 | 1 | 'expired' | null;

/** GET /billing/entitlement: what any member may know about access. */
export interface Entitlement {
  status: SubscriptionStatus;
  hasAccess: boolean;
  isTrial: boolean;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  periodEnd: string | null;
  remainingDays: number;
  reminder: TrialReminder;
  alert: AlertLevel;
  branchLimit: number | null;
  reason: string | null;
  canManage: boolean;
}

export const EXPIRED_MESSAGE =
  'Your 15-day free trial has expired. Subscribe to a plan to continue using FoodStack.';

/** API error codes meaning "the subscription does not allow this"; the app shows the gate. */
export const SUBSCRIPTION_ERROR_CODES = [
  'SUBSCRIPTION_EXPIRED',
  'SUBSCRIPTION_SUSPENDED',
  'SUBSCRIPTION_PAYMENT_PENDING',
];
export type Cycle = 'monthly' | 'yearly';

/** A catalogue plan. Admin-only fields are present only on /platform responses. */
export interface Plan extends PublicPlan {
  isActive?: boolean;
  isPublic?: boolean;
  archivedAt?: string | null;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  planId: string;
  planName: string;
  billingCycle: Cycle;
  kind: 'new' | 'renewal' | 'upgrade' | 'downgrade' | 'cycle_change';
  amountMinor: number;
  currencyCode: string;
  status: 'pending' | 'paid' | 'cancelled';
  periodStart: string | null;
  periodEnd: string | null;
  paymentMethod: string | null;
  paymentReference: string | null;
  createdAt: string;
  paidAt: string | null;
  gateway: string | null;
  failureReason: string | null;
  failedAt: string | null;
}

export interface SubscriptionOverview {
  status: SubscriptionStatus;
  hasAccess: boolean;
  alert: AlertLevel;
  reminder: TrialReminder;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  onlinePayments: boolean;
  branchLimit: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  renewsOn: string | null;
  remainingDays: number;
  totalDays: number;
  elapsed: number;
  billingCycle: Cycle | null;
  plan: Plan | null;
  /** Agreed price per cycle (frozen when paid; unaffected by later plan edits). */
  price: number | null;
  currencyCode: string;
  limits: Plan['limits'];
  autoRenew: boolean;
  pendingInvoice: Invoice | null;
  paymentInstructions: string | null;
  plans: Plan[];
  usage: {
    branches: number;
    staff: number;
    ordersThisMonth: number;
    ordersPerMonth: number;
    menuItems: number;
  };
  canManage: boolean;
}

export const STATUS_META: Record<SubscriptionStatus, { label: string; cls: string; dot: string }> =
  {
    trialing: {
      label: 'Free trial',
      cls: 'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
      dot: 'bg-sky-500',
    },
    active: {
      label: 'Active',
      cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
      dot: 'bg-emerald-500',
    },
    past_due: {
      label: 'Past due',
      cls: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
      dot: 'bg-amber-500',
    },
    expired: {
      label: 'Expired',
      cls: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300',
      dot: 'bg-red-500',
    },
    cancelled: {
      label: 'Cancelled',
      cls: 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300',
      dot: 'bg-slate-400',
    },
    suspended: {
      label: 'Suspended',
      cls: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300',
      dot: 'bg-red-600',
    },
    pending_payment: {
      label: 'Pending payment',
      cls: 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
      dot: 'bg-violet-500',
    },
  };

export const KIND_LABEL: Record<Invoice['kind'], string> = {
  new: 'New subscription',
  renewal: 'Renewal',
  upgrade: 'Upgrade',
  downgrade: 'Downgrade',
  cycle_change: 'Billing cycle change',
};

export const METHOD_LABEL: Record<string, string> = {
  bank_transfer: 'Bank transfer',
  upi: 'UPI',
  card: 'Card',
  cash: 'Cash',
  other: 'Other',
  online: 'Online (Razorpay)',
};

export const money = (minor: number, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: minor % 100 ? 2 : 0,
  }).format(minor / 100);

export function useSubscription() {
  const { client } = useAuth();
  const profile = useProfile();
  return useQuery({
    queryKey: ['billing', profile.activeTenant?.id, 'subscription'],
    queryFn: () => client.request<SubscriptionOverview>('/billing/subscription'),
  });
}

/** Access state for the active restaurant. Only for tenant sessions. */
export function useEntitlement(enabled = true) {
  const { client } = useAuth();
  const profile = useProfile();
  return useQuery({
    queryKey: ['billing', profile.activeTenant?.id, 'entitlement'],
    queryFn: () => client.request<Entitlement>('/billing/entitlement'),
    enabled: enabled && profile.audience === 'tenant',
    staleTime: 60_000,
    // Re-check periodically so a trial that ends mid-shift locks promptly.
    refetchInterval: 5 * 60_000,
  });
}

interface CheckoutOrder {
  invoice: Invoice;
  gateway: 'razorpay';
  keyId: string;
  orderId: string;
  amountMinor: number;
  currencyCode: string;
}

interface RazorpayResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayInstance {
  open(): void;
  on(event: 'payment.failed', cb: (r: { error?: { description?: string } }) => void): void;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

let razorpayScript: Promise<void> | null = null;
function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  razorpayScript ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      razorpayScript = null;
      reject(new Error('Could not load the payment window. Check your connection and retry.'));
    };
    document.body.appendChild(s);
  });
  return razorpayScript;
}

/**
 * Online payment: the server creates the order and prices it; the browser only opens the
 * gateway window and hands the signed result back for server-side verification. Resolves with
 * 'paid', 'failed' or 'dismissed'.
 */
export function usePlanCheckout() {
  const { client } = useAuth();
  const profile = useProfile();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['billing', profile.activeTenant?.id] });
  return useMutation({
    mutationFn: async (body: { planId: string; billingCycle: Cycle }) => {
      const order = await client.request<CheckoutOrder>('/billing/subscription/checkout', {
        method: 'POST',
        body,
      });
      await loadRazorpay();
      return new Promise<'paid' | 'failed' | 'dismissed'>((resolve, reject) => {
        // The gateway keeps its window open after a failed attempt so the owner can retry.
        let failed = false;
        const rzp = new window.Razorpay!({
          key: order.keyId,
          order_id: order.orderId,
          amount: order.amountMinor,
          currency: order.currencyCode,
          name: 'FoodStack',
          description: `${order.invoice.planName} · ${order.invoice.billingCycle}`,
          prefill: { name: profile.user.fullName, email: profile.user.email },
          theme: { color: '#4f46e5' },
          handler: (r: RazorpayResponse) => {
            client
              .request<Invoice>('/billing/subscription/checkout/verify', {
                method: 'POST',
                body: {
                  invoiceId: order.invoice.id,
                  orderId: r.razorpay_order_id,
                  paymentId: r.razorpay_payment_id,
                  signature: r.razorpay_signature,
                },
              })
              .then(() => resolve('paid'), reject);
          },
          modal: { ondismiss: () => resolve(failed ? 'failed' : 'dismissed') },
        });
        rzp.on('payment.failed', (r) => {
          failed = true;
          void client
            .request<void>('/billing/subscription/checkout/failed', {
              method: 'POST',
              body: { invoiceId: order.invoice.id, reason: r.error?.description?.slice(0, 300) },
            })
            .catch(() => undefined);
        });
        rzp.open();
      });
    },
    onSettled: refresh,
  });
}

export function useBillingMutations() {
  const { client } = useAuth();
  const profile = useProfile();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['billing', profile.activeTenant?.id] });
  return {
    request: useMutation({
      mutationFn: (body: { planId: string; billingCycle: Cycle }) =>
        client.request<Invoice>('/billing/subscription/requests', { method: 'POST', body }),
      onSuccess: refresh,
    }),
    cancel: useMutation({
      mutationFn: (id: string) =>
        client.request<void>(`/billing/invoices/${id}/cancel`, { method: 'POST' }),
      onSuccess: refresh,
    }),
  };
}
