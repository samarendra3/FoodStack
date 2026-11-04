import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { type Db, DbContext } from '../../core/db/db-context';
import { type PlanRow, type PlanSnapshot, planSnapshot } from './plan-catalogue';
import {
  addCycle,
  canTransition,
  EXPIRED_MESSAGE,
  effectiveStatus,
  type StoredSubscription,
  type SubscriptionStatus,
  subscriptionState,
  TRIAL_MAX_BRANCHES,
  trialReminder,
} from './subscription-state';

export interface SubscriptionRow {
  id: string;
  tenant_id: string;
  plan_id: string | null;
  billing_cycle: 'monthly' | 'yearly' | null;
  status: SubscriptionStatus;
  current_period_start: Date;
  current_period_end: Date | null;
  trial_started_at: Date | null;
  trial_ends_at: Date | null;
  cancelled_at: Date | null;
  status_changed_at: Date;
  status_reason: string | null;
  plan_snapshot: PlanSnapshot | null;
}

export type LimitKind = 'branches' | 'staff' | 'ordersPerMonth' | 'menuItems';
const LIMIT_CODES: Record<LimitKind, string> = {
  branches: 'BRANCH_LIMIT_REACHED',
  staff: 'STAFF_LIMIT_REACHED',
  ordersPerMonth: 'ORDER_LIMIT_REACHED',
  menuItems: 'MENU_ITEM_LIMIT_REACHED',
};
const LIMIT_NOUNS: Record<LimitKind, (n: number) => string> = {
  branches: (n) => (n === 1 ? 'active branch' : 'active branches'),
  staff: (n) => (n === 1 ? 'team member' : 'team members'),
  ordersPerMonth: (n) => (n === 1 ? 'order per month' : 'orders per month'),
  menuItems: (n) => (n === 1 ? 'menu item' : 'menu items'),
};

export interface PaidInvoiceRow {
  id: string;
  tenant_id: string;
  plan_id: string;
  billing_cycle: 'monthly' | 'yearly';
  kind: string;
  amount_minor: string;
  currency_code: string;
  status: 'pending' | 'paid' | 'cancelled';
  gateway_payment_id: string | null;
}

export interface TransitionOptions {
  event: string;
  reason?: string | null;
  actorUserId?: string | null;
  invoiceId?: string | null;
  metadata?: Record<string, unknown>;
  /** Extra columns to set in the same UPDATE. Keys are trusted column names. */
  set?: Record<string, unknown>;
}

export interface PaymentProof {
  method: 'bank_transfer' | 'upi' | 'card' | 'cash' | 'other' | 'online';
  reference: string;
  note?: string | null;
  verifiedBy?: string | null;
  gateway?: 'razorpay' | null;
  gatewayPaymentId?: string | null;
}

export const stored = (r: SubscriptionRow): StoredSubscription => ({
  status: r.status,
  periodStart: new Date(r.current_period_start),
  periodEnd: r.current_period_end ? new Date(r.current_period_end) : null,
});

/** Statuses whose stored value can become stale with time (see effectiveStatus). */
const TIME_DRIVEN: SubscriptionStatus[] = ['trialing', 'active', 'past_due', 'cancelled'];

/** 402 with a code the web app recognises to show the subscription screen. */
export function subscriptionRequired(status: SubscriptionStatus): HttpException {
  const [code, message] =
    status === 'suspended'
      ? [
          'SUBSCRIPTION_SUSPENDED',
          'This restaurant subscription is suspended. Please contact FoodStack support.',
        ]
      : status === 'pending_payment'
        ? [
            'SUBSCRIPTION_PAYMENT_PENDING',
            'Your payment is being processed. Access returns as soon as it is confirmed.',
          ]
        : ['SUBSCRIPTION_EXPIRED', EXPIRED_MESSAGE];
  return new HttpException({ code, message, status }, HttpStatus.PAYMENT_REQUIRED);
}

/**
 * The single owner of subscription state changes. Every status write goes through `transition`,
 * which validates it against the state machine and appends to subscription_events, so the
 * history is complete. Callers supply the transaction (and its RLS scope).
 */
@Injectable()
export class SubscriptionLifecycleService {
  private readonly logger = new Logger('Subscriptions');

  constructor(private readonly db: DbContext) {}

  async load(db: Db, tenantId: string, lock = false): Promise<SubscriptionRow> {
    const row = await db.one<SubscriptionRow>(
      `SELECT * FROM subscriptions WHERE tenant_id = $1${lock ? ' FOR UPDATE' : ''}`,
      [tenantId],
    );
    if (!row) {
      throw new NotFoundException({
        code: 'SUBSCRIPTION_NOT_FOUND',
        message: 'No subscription found for this restaurant.',
      });
    }
    return row;
  }

  /**
   * Persists a time-driven change (trial ended → expired, period ended → past_due/expired).
   * Idempotent: a no-op when nothing changed or another transaction got there first.
   */
  async sync(db: Db, row: SubscriptionRow, now = new Date()): Promise<SubscriptionRow> {
    const next = effectiveStatus(stored(row), now);
    if (next === row.status) return row;
    const updated = await db.one<SubscriptionRow>(
      `UPDATE subscriptions SET status = $3, status_changed_at = now(), status_reason = $4, updated_at = now()
        WHERE id = $1 AND status = $2 RETURNING *`,
      [row.id, row.status, next, row.status === 'trialing' ? 'Trial ended' : 'Period ended'],
    );
    if (!updated)
      return (await db.one<SubscriptionRow>('SELECT * FROM subscriptions WHERE id = $1', [
        row.id,
      ]))!;
    await this.event(db, updated, {
      event:
        row.status === 'trialing' ? 'trial_expired' : next === 'past_due' ? 'past_due' : 'expired',
      from: row.status,
      to: next,
    });
    return updated;
  }

  async transition(
    db: Db,
    row: SubscriptionRow,
    to: SubscriptionStatus,
    opts: TransitionOptions,
  ): Promise<SubscriptionRow> {
    if (!canTransition(row.status, to)) {
      throw new ConflictException({
        code: 'INVALID_SUBSCRIPTION_TRANSITION',
        message: `A ${row.status.replace('_', ' ')} subscription cannot become ${to.replace('_', ' ')}.`,
      });
    }
    const params: unknown[] = [row.id, row.status, to, opts.reason ?? null];
    const sets = Object.entries(opts.set ?? {}).map(([col, v]) => {
      params.push(v);
      return `${col} = $${params.length}`;
    });
    const updated = await db.one<SubscriptionRow>(
      `UPDATE subscriptions
          SET status = $3, status_reason = $4, updated_at = now(),
              status_changed_at = CASE WHEN status = $3 THEN status_changed_at ELSE now() END
              ${sets.length ? `, ${sets.join(', ')}` : ''}
        WHERE id = $1 AND status = $2 RETURNING *`,
      params,
    );
    if (!updated) {
      throw new ConflictException({
        code: 'SUBSCRIPTION_CHANGED',
        message: 'The subscription changed meanwhile. Please retry.',
      });
    }
    await this.event(db, updated, { ...opts, from: row.status, to });
    return updated;
  }

  /**
   * Applies a verified payment: activates (or extends) the plan, records how it was paid and
   * restores access. Requires the platform scope (it may also promote tenants.status). Safe to
   * call twice for the same gateway payment: the second call returns the paid invoice unchanged.
   */
  async applyPaidInvoice(db: Db, invoiceId: string, proof: PaymentProof): Promise<PaidInvoiceRow> {
    const inv = await db.one<PaidInvoiceRow>(
      'SELECT * FROM subscription_invoices WHERE id = $1 FOR UPDATE',
      [invoiceId],
    );
    if (!inv)
      throw new NotFoundException({ code: 'INVOICE_NOT_FOUND', message: 'Invoice not found.' });
    if (
      inv.status === 'paid' &&
      proof.gatewayPaymentId &&
      inv.gateway_payment_id === proof.gatewayPaymentId
    ) {
      return inv;
    }
    if (inv.status !== 'pending') {
      throw new BadRequestException({
        code: 'NOT_PENDING',
        message: `This invoice is already ${inv.status}.`,
      });
    }

    const sub = await this.sync(db, await this.load(db, inv.tenant_id, true));
    const now = new Date();
    const activeEnd =
      ['active', 'past_due', 'cancelled'].includes(sub.status) &&
      sub.plan_id &&
      sub.current_period_end &&
      new Date(sub.current_period_end) > now
        ? new Date(sub.current_period_end)
        : null;
    const extend =
      activeEnd !== null && ['renewal', 'downgrade', 'cycle_change'].includes(inv.kind);
    const start = extend ? activeEnd : now;
    const end = addCycle(start, inv.billing_cycle);
    const periodStart = extend ? new Date(sub.current_period_start) : start;
    // Freeze the terms the customer is paying for: the invoiced amount and the plan's current
    // limits and features. Later edits to the plan do not touch this subscription.
    const plan = await db.one<PlanRow>('SELECT * FROM plans WHERE id = $1', [inv.plan_id]);
    const set = {
      plan_id: inv.plan_id,
      billing_cycle: inv.billing_cycle,
      current_period_start: periodStart,
      current_period_end: end,
      cancelled_at: null,
      plan_snapshot: JSON.stringify(
        planSnapshot(plan!, inv.billing_cycle, Number(inv.amount_minor)),
      ),
    };
    const opts: TransitionOptions = {
      event: 'payment_succeeded',
      invoiceId: inv.id,
      actorUserId: proof.verifiedBy ?? null,
      metadata: {
        method: proof.method,
        gateway: proof.gateway ?? null,
        amountMinor: Number(inv.amount_minor),
        periodEnd: end.toISOString(),
      },
      set,
    };
    // A suspension is an administrative decision: payment updates the plan but does not lift it.
    if (sub.status === 'suspended') {
      await this.transition(db, sub, 'suspended', { ...opts, reason: sub.status_reason, set });
    } else {
      await this.transition(db, sub, 'active', opts);
    }

    await db.query(
      `UPDATE subscription_invoices SET status = 'paid', paid_at = now(), period_start = $2, period_end = $3,
              payment_method = $4, payment_reference = $5, note = $6, verified_by = $7,
              gateway = coalesce($8, gateway), gateway_payment_id = $9, failure_reason = NULL, failed_at = NULL
        WHERE id = $1`,
      [
        inv.id,
        start,
        end,
        proof.method,
        proof.reference,
        proof.note ?? null,
        proof.verifiedBy ?? null,
        proof.gateway ?? null,
        proof.gatewayPaymentId ?? null,
      ],
    );
    await db.query(
      `UPDATE tenants SET status = 'active', status_changed_at = now() WHERE id = $1 AND status = 'trial'`,
      [inv.tenant_id],
    );
    return (await db.one<PaidInvoiceRow>('SELECT * FROM subscription_invoices WHERE id = $1', [
      inv.id,
    ]))!;
  }

  /** Records a failed attempt. The invoice stays pending so the owner can retry. */
  async recordPaymentFailure(db: Db, invoiceId: string, reason: string | null) {
    const inv = await db.one<{ tenant_id: string; status: string }>(
      `UPDATE subscription_invoices SET failure_reason = $2, failed_at = now()
        WHERE id = $1 AND status = 'pending' RETURNING tenant_id, status`,
      [invoiceId, reason ?? 'Payment failed'],
    );
    if (!inv) return;
    const sub = await this.load(db, inv.tenant_id, true);
    if (sub.status === 'pending_payment') {
      await this.transition(db, sub, 'expired', {
        event: 'payment_failed',
        invoiceId,
        reason: reason ?? 'Payment failed',
      });
    } else {
      await this.event(db, sub, {
        event: 'payment_failed',
        invoiceId,
        reason: reason ?? 'Payment failed',
      });
    }
  }

  /** An expired subscription waiting on a checkout shows (and is) pending_payment. */
  async markPendingPayment(db: Db, tenantId: string, invoiceId: string) {
    const sub = await this.sync(db, await this.load(db, tenantId, true));
    if (sub.status === 'expired') {
      await this.transition(db, sub, 'pending_payment', { event: 'checkout_started', invoiceId });
    }
  }

  /** Undo of markPendingPayment when the request is cancelled. */
  async clearPendingPayment(db: Db, tenantId: string, invoiceId: string) {
    const sub = await this.load(db, tenantId, true);
    if (sub.status === 'pending_payment') {
      await this.transition(db, sub, 'expired', { event: 'checkout_cancelled', invoiceId });
    }
  }

  /**
   * Background sweep: persists every time-driven change that is due. Uses SKIP LOCKED and a
   * transaction-level advisory lock, so concurrent instances neither block nor double-process.
   */
  async sweep(now = new Date()): Promise<number> {
    return this.db.run({ platform: true }, async (db) => {
      const lock = await db.one<{ ok: boolean }>(
        `SELECT pg_try_advisory_xact_lock(hashtext('foodstack.subscription_sweep')) AS ok`,
      );
      if (!lock?.ok) return 0;
      const due = await db.query<SubscriptionRow>(
        `SELECT * FROM subscriptions
          WHERE status = ANY($1) AND current_period_end IS NOT NULL AND current_period_end <= $2
          ORDER BY current_period_end LIMIT 1000 FOR UPDATE SKIP LOCKED`,
        [TIME_DRIVEN, now],
      );
      let changed = 0;
      for (const row of due) {
        if ((await this.sync(db, row, now)).status !== row.status) changed++;
      }
      if (changed) this.logger.log(`Subscription sweep updated ${changed} subscription(s)`);
      return changed;
    });
  }

  /**
   * The limits this subscription is entitled to: the snapshot agreed at payment (never the live
   * plan, which the Super Admin may have edited since). Trials: 1 branch, other limits open.
   * Complimentary accounts (no plan, no end) are unlimited.
   */
  limitsFor(sub: SubscriptionRow): PlanSnapshot['limits'] {
    if (sub.plan_snapshot) return sub.plan_snapshot.limits;
    const open = {
      branches: null,
      staff: null,
      ordersPerMonth: null,
      menuItems: null,
      storageMb: null,
    };
    return sub.status === 'trialing' || sub.trial_ends_at
      ? { ...open, branches: TRIAL_MAX_BRANCHES }
      : open;
  }

  /** Current counts for each limited resource (scope: the tenant). */
  async usage(db: Db) {
    const u = await db.one<{ branches: string; staff: string; orders: string; menu_items: string }>(
      `SELECT (SELECT count(*) FROM branches WHERE status = 'active') AS branches,
              (SELECT count(*) FROM tenant_memberships WHERE status IN ('active', 'invited')) AS staff,
              (SELECT count(*) FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
                WHERE o.status <> 'cancelled'
                  AND o.created_at >= date_trunc('month', now() AT TIME ZONE r.timezone) AT TIME ZONE r.timezone) AS orders,
              (SELECT count(*) FROM menu_items WHERE deleted_at IS NULL) AS menu_items`,
    );
    return {
      branches: Number(u?.branches ?? 0),
      staff: Number(u?.staff ?? 0),
      ordersPerMonth: Number(u?.orders ?? 0),
      menuItems: Number(u?.menu_items ?? 0),
    };
  }

  /**
   * Central plan-limit check, called by every module before it creates a limited resource.
   * Requires the tenant scope and runs in the caller's transaction; a per-tenant advisory lock
   * serializes concurrent creations so two requests cannot both take the last slot.
   */
  async assertWithinLimit(db: Db, tenantId: string, kind: LimitKind, adding = 1) {
    const sub = await this.sync(db, await this.load(db, tenantId));
    if (!subscriptionState(stored(sub), new Date()).hasAccess)
      throw subscriptionRequired(sub.status);
    const limit = this.limitsFor(sub)[kind];
    if (limit === null) return; // unlimited: no lock, so busy tenants are not serialized
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`limit:${tenantId}:${kind}`]);
    const used = (await this.usage(db))[kind];
    if (used + adding > limit) {
      const trial = sub.status === 'trialing';
      throw new ForbiddenException({
        code: LIMIT_CODES[kind],
        message: trial
          ? `The free trial includes ${limit} ${LIMIT_NOUNS[kind](limit)}. Subscribe to a plan to add more.`
          : `Your plan allows ${limit} ${LIMIT_NOUNS[kind](limit)}. Upgrade your plan to add more.`,
        details: { limit, used },
      });
    }
  }

  /** Branch limit: 1 on a trial, the agreed plan limit when paid (NULL = unlimited). */
  assertCanAddBranch(db: Db, tenantId: string) {
    return this.assertWithinLimit(db, tenantId, 'branches');
  }

  /** What any member of the restaurant may know about access (no prices or invoices). */
  async entitlement(db: Db, tenantId: string) {
    const sub = await this.sync(db, await this.load(db, tenantId));
    const state = subscriptionState(stored(sub), new Date());
    const wasTrial = sub.plan_id === null && sub.trial_ends_at !== null;
    return {
      status: state.status,
      hasAccess: state.hasAccess,
      isTrial: state.status === 'trialing',
      trialStartedAt: iso(sub.trial_started_at),
      trialEndsAt: iso(sub.trial_ends_at),
      periodEnd: iso(state.periodEnd),
      remainingDays: state.remainingDays,
      reminder: trialReminder(state.status, state.remainingDays, wasTrial),
      alert: state.alert,
      branchLimit: state.status === 'trialing' ? TRIAL_MAX_BRANCHES : null,
      reason: sub.status_reason,
    };
  }

  private event(
    db: Db,
    sub: SubscriptionRow,
    e: Omit<TransitionOptions, 'set'> & { from?: string; to?: string },
  ) {
    return db.query(
      `INSERT INTO subscription_events (tenant_id, subscription_id, event, from_status, to_status, invoice_id,
                                        actor_user_id, reason, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        sub.tenant_id,
        sub.id,
        e.event,
        e.from ?? null,
        e.to ?? null,
        e.invoiceId ?? null,
        e.actorUserId ?? null,
        e.reason ?? null,
        JSON.stringify(e.metadata ?? {}),
      ],
    );
  }
}

export const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
