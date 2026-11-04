/**
 * The subscription state machine. Pure functions over stored dates; everything is compared as
 * UTC instants, so results are identical in every timezone. Both the per-request entitlement
 * check and the background expiry sweep use `effectiveStatus`, so they can never disagree.
 */

export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'expired',
  'pending_payment',
  'past_due',
  'suspended',
  'cancelled',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const TRIAL_DAYS = 15;
/** A trial may run one active branch; paid plans use plans.max_branches (NULL = unlimited). */
export const TRIAL_MAX_BRANCHES = 1;
/** A paid period that ends without renewal keeps working this long as past_due. */
export const PAST_DUE_GRACE_DAYS = 3;

export const EXPIRED_MESSAGE =
  'Your 15-day free trial has expired. Subscribe to a plan to continue using FoodStack.';

/** Statuses that may use operational features (POS, orders, kitchen, inventory, ...). */
const ACCESS: ReadonlySet<SubscriptionStatus> = new Set([
  'trialing',
  'active',
  'past_due',
  'cancelled',
]);

/** Allowed stored-status changes. Time-driven ones are applied by `effectiveStatus`. */
const TRANSITIONS: Record<SubscriptionStatus, readonly SubscriptionStatus[]> = {
  trialing: ['trialing', 'expired', 'active', 'suspended'],
  expired: ['pending_payment', 'active', 'trialing', 'suspended'],
  pending_payment: ['expired', 'active', 'trialing', 'suspended'],
  active: ['active', 'past_due', 'expired', 'cancelled', 'suspended'],
  past_due: ['active', 'expired', 'suspended'],
  cancelled: ['active', 'expired', 'suspended'],
  suspended: ['suspended', 'trialing', 'active', 'expired'],
};

export function canTransition(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export type AlertLevel = 'none' | 'soon' | 'urgent' | 'expired';
/** Trial reminder milestones shown in the app: 7, 3 and 1 days left, then expired. */
export type TrialReminder = 7 | 3 | 1 | 'expired' | null;

export interface StoredSubscription {
  status: SubscriptionStatus;
  periodStart: Date;
  /** NULL: no end (complimentary account). For trials this is the trial end. */
  periodEnd: Date | null;
}

const DAY = 86_400_000;

export function remainingDays(now: Date, end: Date): number {
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY));
}

/** The status once the clock is applied. Idempotent: applying it twice changes nothing. */
export function effectiveStatus(s: StoredSubscription, now: Date): SubscriptionStatus {
  if (!s.periodEnd) return s.status;
  const end = s.periodEnd.getTime();
  const t = now.getTime();
  const ended = t >= end;
  switch (s.status) {
    case 'trialing':
    case 'cancelled':
      return ended ? 'expired' : s.status;
    case 'active':
    case 'past_due':
      if (!ended) return s.status;
      return t >= end + PAST_DUE_GRACE_DAYS * DAY ? 'expired' : 'past_due';
    default:
      return s.status;
  }
}

export function hasAccess(status: SubscriptionStatus): boolean {
  return ACCESS.has(status);
}

/** 16+ days: none; 7–15: soon; 1–6: urgent; 0: expired. */
export function alertLevel(days: number, ended: boolean): AlertLevel {
  if (ended || days <= 0) return 'expired';
  if (days <= 6) return 'urgent';
  if (days <= 15) return 'soon';
  return 'none';
}

export function trialReminder(status: SubscriptionStatus, days: number, wasTrial: boolean) {
  if (status === 'trialing') {
    if (days <= 1) return 1;
    if (days <= 3) return 3;
    if (days <= 7) return 7;
    return null;
  }
  return (status === 'expired' || status === 'pending_payment') && wasTrial ? 'expired' : null;
}

export interface SubscriptionState {
  status: SubscriptionStatus;
  hasAccess: boolean;
  periodStart: Date | null;
  periodEnd: Date | null;
  remainingDays: number;
  totalDays: number;
  /** 0–1 share of the period already used, for the progress bar. */
  elapsed: number;
  alert: AlertLevel;
}

export function subscriptionState(s: StoredSubscription, now: Date): SubscriptionState {
  const status = effectiveStatus(s, now);
  const start = s.periodStart;
  const end = s.periodEnd;
  const days = end ? remainingDays(now, end) : 0;
  const span = end ? end.getTime() - start.getTime() : 0;
  return {
    status,
    hasAccess: hasAccess(status),
    periodStart: start,
    periodEnd: end,
    remainingDays: days,
    totalDays: end ? Math.max(1, Math.round(span / DAY)) : 0,
    elapsed: end ? Math.min(1, Math.max(0, (now.getTime() - start.getTime()) / span)) : 0,
    alert: !end ? (hasAccess(status) ? 'none' : 'expired') : alertLevel(days, now >= end),
  };
}

/** Adds one billing cycle, keeping the day of month where possible (31 Jan → 28/29 Feb). */
export function addCycle(from: Date, cycle: 'monthly' | 'yearly'): Date {
  const months = from.getUTCMonth() + (cycle === 'yearly' ? 12 : 1);
  const year = from.getUTCFullYear() + Math.floor(months / 12);
  const month = months % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(from.getUTCDate(), lastDay),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}
