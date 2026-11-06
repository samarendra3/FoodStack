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

const DAY = 86_400_000;

/**
 * The tenant's orders this month (tenant scope): each restaurant's counter for the month that is
 * current in that restaurant's own time zone, summed. Selects one column, `n`.
 */
const CURRENT_ORDERS_SQL = `SELECT coalesce(sum(c.orders), 0)::int AS n
    FROM restaurants r
    JOIN tenant_usage_counters c
      ON c.tenant_id = r.tenant_id AND c.restaurant_id = r.id
     AND c.period = date_trunc('month', now() AT TIME ZONE r.timezone)::date`;
/** How long an opened online checkout may stay unpaid before it expires. */
export const CHECKOUT_SESSION_HOURS = 24;

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
  status: 'pending' | 'paid' | 'cancelled' | 'refunded' | 'expired';
  gateway_payment_id: string | null;
  addon_package_id: string | null;
  addon_snapshot: AddonSnapshot | null;
}

export type AddonType = 'orders' | 'branches' | 'staff' | 'storage';
/** What was bought, frozen on the invoice when it was requested. */
export interface AddonSnapshot {
  packageId: string;
  code: string;
  name: string;
  addonType: AddonType;
  quantity: number;
  validity: 'current_cycle' | 'fixed_days' | 'custom';
  validityDays: number | null;
  validUntil: string | null;
}

export interface AddonGrantRow {
  id: string;
  tenant_id: string;
  invoice_id: string;
  addon_package_id: string;
  addon_type: AddonType;
  quantity: number;
  name: string;
  starts_at: Date;
  expires_at: Date;
  status: 'active' | 'revoked';
  revoked_at: Date | null;
  revoke_reason: string | null;
  created_at: Date;
}

/** Add-on type → the plan limit it extends. */
const ADDON_LIMIT: Record<AddonType, keyof PlanSnapshot['limits']> = {
  orders: 'ordersPerMonth',
  branches: 'branches',
  staff: 'staff',
  storage: 'storageMb',
};

export type Limits = PlanSnapshot['limits'];

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
    // A gateway-verified payment for a checkout that expired meanwhile is still applied: the
    // customer paid, so the money is never lost. Offline verification needs a live request.
    const latePayment = inv.status === 'expired' && Boolean(proof.gatewayPaymentId);
    if (inv.status !== 'pending' && !latePayment) {
      throw new BadRequestException({
        code: 'NOT_PENDING',
        message: `This invoice is already ${inv.status}.`,
      });
    }
    if (inv.kind === 'addon') return this.applyPaidAddon(db, inv, proof);

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
              gateway = coalesce($8, gateway), gateway_payment_id = $9, failure_reason = NULL, failed_at = NULL, expired_at = NULL
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

  /**
   * Grants a paid add-on: one entitlement row per invoice (unique), valid from now until the
   * end of its validity policy. Never changes the plan or the subscription status.
   *  - current_cycle: until the current paid period (or trial) ends;
   *  - fixed_days: validity_days from now;
   *  - custom: until the package's fixed date.
   */
  private async applyPaidAddon(
    db: Db,
    inv: PaidInvoiceRow,
    proof: PaymentProof,
  ): Promise<PaidInvoiceRow> {
    const snap = inv.addon_snapshot!;
    const sub = await this.sync(db, await this.load(db, inv.tenant_id, true));
    const now = new Date();
    const cycleEnd = sub.current_period_end ? new Date(sub.current_period_end) : null;
    let expires: Date;
    if (snap.validity === 'fixed_days')
      expires = new Date(now.getTime() + snap.validityDays! * DAY);
    else if (snap.validity === 'custom') expires = new Date(snap.validUntil!);
    else expires = cycleEnd && cycleEnd > now ? cycleEnd : new Date(now.getTime() + 30 * DAY);
    if (expires <= now) {
      // e.g. a custom-dated pack paid after its date: refuse rather than grant nothing.
      throw new BadRequestException({
        code: 'ADDON_EXPIRED',
        message: 'This add-on is no longer valid. Cancel the request and choose another pack.',
      });
    }
    await db.query(
      `UPDATE subscription_invoices SET status = 'paid', paid_at = now(), period_start = $2, period_end = $3,
              payment_method = $4, payment_reference = $5, note = $6, verified_by = $7,
              gateway = coalesce($8, gateway), gateway_payment_id = $9, failure_reason = NULL, failed_at = NULL, expired_at = NULL
        WHERE id = $1`,
      [
        inv.id,
        now,
        expires,
        proof.method,
        proof.reference,
        proof.note ?? null,
        proof.verifiedBy ?? null,
        proof.gateway ?? null,
        proof.gatewayPaymentId ?? null,
      ],
    );
    await db.query(
      `INSERT INTO addon_grants (tenant_id, invoice_id, addon_package_id, addon_type, quantity, name,
                                 starts_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        inv.tenant_id,
        inv.id,
        snap.packageId,
        snap.addonType,
        snap.quantity,
        snap.name,
        now,
        expires,
      ],
    );
    await this.event(db, sub, {
      event: 'addon_purchased',
      invoiceId: inv.id,
      actorUserId: proof.verifiedBy ?? null,
      metadata: {
        name: snap.name,
        addonType: snap.addonType,
        quantity: snap.quantity,
        method: proof.method,
        amountMinor: Number(inv.amount_minor),
        expiresAt: expires.toISOString(),
      },
    });
    return (await db.one<PaidInvoiceRow>('SELECT * FROM subscription_invoices WHERE id = $1', [
      inv.id,
    ]))!;
  }

  /**
   * Reverses a paid add-on (refund or lost chargeback): the invoice becomes refunded and its
   * entitlement is revoked at once. History is kept. Idempotent: a second call is a no-op.
   */
  async revokeAddon(
    db: Db,
    invoiceId: string,
    reason: string,
    actorUserId: string | null,
  ): Promise<boolean> {
    const inv = await db.one<PaidInvoiceRow>(
      'SELECT * FROM subscription_invoices WHERE id = $1 FOR UPDATE',
      [invoiceId],
    );
    if (!inv)
      throw new NotFoundException({ code: 'INVOICE_NOT_FOUND', message: 'Invoice not found.' });
    if (inv.kind !== 'addon') {
      throw new BadRequestException({
        code: 'NOT_AN_ADDON',
        message: 'Only add-on purchases can be refunded here.',
      });
    }
    if (inv.status === 'refunded') return false;
    if (inv.status !== 'paid') {
      throw new BadRequestException({
        code: 'NOT_PAID',
        message: `This invoice is ${inv.status}; only paid add-ons can be refunded.`,
      });
    }
    await db.query(
      `UPDATE subscription_invoices SET status = 'refunded', refunded_at = now(), refund_reason = $2
        WHERE id = $1`,
      [inv.id, reason.slice(0, 300)],
    );
    const grant = await db.one<AddonGrantRow>(
      `UPDATE addon_grants SET status = 'revoked', revoked_at = now(), revoke_reason = $2
        WHERE invoice_id = $1 AND status = 'active' RETURNING *`,
      [inv.id, reason.slice(0, 300)],
    );
    const sub = await this.load(db, inv.tenant_id);
    await this.event(db, sub, {
      event: 'addon_revoked',
      invoiceId: inv.id,
      actorUserId,
      reason: reason.slice(0, 300),
      metadata: { quantity: grant?.quantity ?? null, addonType: grant?.addon_type ?? null },
    });
    return true;
  }

  /**
   * Expires online checkouts abandoned for longer than CHECKOUT_SESSION_HOURS: the request stops
   * blocking new ones and an expired subscription waiting on it returns to expired. Offline
   * requests (no gateway order) stay pending for Super Admin verification.
   */
  async expireAbandonedCheckouts(db: Db, now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - CHECKOUT_SESSION_HOURS * 3_600_000);
    const stale = await db.query<{ id: string; tenant_id: string }>(
      `UPDATE subscription_invoices SET status = 'expired', expired_at = $1
        WHERE id IN (SELECT id FROM subscription_invoices
                      WHERE status = 'pending' AND gateway_order_id IS NOT NULL
                        AND checkout_started_at < $2
                      ORDER BY checkout_started_at LIMIT 1000 FOR UPDATE SKIP LOCKED)
        RETURNING id, tenant_id`,
      [now, cutoff],
    );
    for (const inv of stale) {
      const sub = await this.load(db, inv.tenant_id, true);
      if (sub.status === 'pending_payment') {
        await this.transition(db, sub, 'expired', {
          event: 'checkout_expired',
          invoiceId: inv.id,
          reason: 'Payment not completed',
        });
      } else {
        await this.event(db, sub, {
          event: 'checkout_expired',
          invoiceId: inv.id,
          reason: 'Payment not completed',
        });
      }
    }
    return stale.length;
  }

  /** Records add-on expiries in the history (capacity already stops counting at expires_at). */
  async recordAddonExpiries(db: Db, now = new Date()): Promise<number> {
    const expired = await db.query<AddonGrantRow>(
      `UPDATE addon_grants SET expiry_recorded_at = $1
        WHERE id IN (SELECT id FROM addon_grants
                      WHERE status = 'active' AND expiry_recorded_at IS NULL AND expires_at <= $1
                      ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [now],
    );
    for (const g of expired) {
      await db.query(
        `INSERT INTO subscription_events (tenant_id, subscription_id, event, invoice_id, metadata)
         SELECT $1, id, 'addon_expired', $2, $3 FROM subscriptions WHERE tenant_id = $1`,
        [
          g.tenant_id,
          g.invoice_id,
          JSON.stringify({ name: g.name, addonType: g.addon_type, quantity: g.quantity }),
        ],
      );
    }
    return expired.length;
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
      const abandoned = await this.expireAbandonedCheckouts(db, now);
      if (abandoned) this.logger.log(`Expired ${abandoned} abandoned checkout(s)`);
      const expiredAddons = await this.recordAddonExpiries(db, now);
      if (expiredAddons) this.logger.log(`Recorded ${expiredAddons} add-on expiry(ies)`);
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

  /** Live add-on capacity per limit: active, started, not yet expired, not revoked. */
  async addonCapacity(db: Db, tenantId: string, now = new Date()): Promise<Partial<Limits>> {
    const rows = await db.query<{ addon_type: AddonType; qty: string }>(
      `SELECT addon_type, sum(quantity) AS qty FROM addon_grants
        WHERE tenant_id = $1 AND status = 'active' AND starts_at <= $2 AND expires_at > $2
        GROUP BY addon_type`,
      [tenantId, now],
    );
    const out: Partial<Limits> = {};
    for (const r of rows) out[ADDON_LIMIT[r.addon_type]] = Number(r.qty);
    return out;
  }

  /**
   * The central entitlement: plan (or trial) limits from the agreed snapshot plus live add-on
   * capacity. Total allowed = plan limit + valid add-ons; an unlimited plan limit stays unlimited.
   * Every limit check and every usage display uses this.
   */
  async effectiveLimits(db: Db, sub: SubscriptionRow, now = new Date()): Promise<Limits> {
    const base = this.limitsFor(sub);
    const extra = await this.addonCapacity(db, sub.tenant_id, now);
    const add = (k: keyof Limits) => (base[k] === null ? null : base[k]! + (extra[k] ?? 0));
    return {
      branches: add('branches'),
      staff: add('staff'),
      ordersPerMonth: add('ordersPerMonth'),
      menuItems: add('menuItems'),
      storageMb: add('storageMb'),
    };
  }

  /**
   * Current counts for each limited resource (scope: the tenant), or only the one asked for.
   *
   * Orders this month come from tenant_usage_counters (one row per restaurant and month), which
   * order creation and cancellation keep in step: open or completed orders from any channel (POS,
   * waiter, QR, online), one per order, so items and kitchen tickets never count and retried
   * submissions are de-duplicated by client_request_id. Cancelled orders do not count (they free
   * their slot). Refunded orders still count: the order was served, only money was returned.
   * Each restaurant's month follows its own time zone; the tenant's usage is the sum of each
   * restaurant's current month.
   */
  async usage(db: Db): Promise<Record<LimitKind, number>>;
  async usage(db: Db, only: LimitKind): Promise<Partial<Record<LimitKind, number>>>;
  async usage(db: Db, only?: LimitKind) {
    const want = (k: LimitKind) => only === undefined || only === k;
    const cols = [
      want('branches') && `(SELECT count(*) FROM branches WHERE status = 'active') AS branches`,
      want('staff') &&
        `(SELECT count(*) FROM tenant_memberships WHERE status IN ('active', 'invited')) AS staff`,
      want('ordersPerMonth') && `(${CURRENT_ORDERS_SQL}) AS orders`,
      want('menuItems') &&
        `(SELECT count(*) FROM menu_items WHERE deleted_at IS NULL) AS menu_items`,
    ].filter(Boolean);
    const u = await db.one<{
      branches?: string;
      staff?: string;
      orders?: string;
      menu_items?: string;
    }>(`SELECT ${cols.join(', ')}`);
    const all = {
      branches: Number(u?.branches ?? 0),
      staff: Number(u?.staff ?? 0),
      ordersPerMonth: Number(u?.orders ?? 0),
      menuItems: Number(u?.menu_items ?? 0),
    };
    return only === undefined ? all : { [only]: all[only] };
  }

  /**
   * Central plan-limit check, called by every module before it creates a limited resource, in
   * the caller's transaction (tenant scope).
   *
   * Orders (`ordersPerMonth`, with `branchId`): **reserves** the slot by incrementing the
   * ordering restaurant's counter for its current month, in one statement that only inserts or
   * updates while the tenant's total (every restaurant's current month) stays within the limit.
   * The limit is per tenant while counters are per restaurant, so a transaction-level advisory
   * lock per tenant serializes limited creations across restaurants; it is held only for this
   * statement's transaction. If the order then fails, the transaction rolls the reservation back.
   * Unlimited plans still count (usage is shown), without the lock or a limit condition.
   *
   * Other kinds: a per-tenant advisory lock serializes creations, then one count is taken.
   */
  async assertWithinLimit(
    db: Db,
    tenantId: string,
    kind: LimitKind,
    adding = 1,
    opts: { branchId?: string } = {},
  ) {
    const sub = await this.sync(db, await this.load(db, tenantId));
    if (!subscriptionState(stored(sub), new Date()).hasAccess)
      throw subscriptionRequired(sub.status);

    if (kind === 'ordersPerMonth' && opts.branchId) {
      const unlimited = this.limitsFor(sub).ordersPerMonth === null;
      const limit = unlimited ? null : (await this.effectiveLimits(db, sub)).ordersPerMonth!;
      if (limit !== null && adding > limit) this.limitReached(sub, kind, limit, 0);
      if (limit !== null) {
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`orders:${tenantId}`]);
      }
      // Under READ COMMITTED this statement's snapshot is taken after the lock, so it sees every
      // reservation committed before us.
      const row = await db.one<{ orders: number }>(
        `WITH used AS (${CURRENT_ORDERS_SQL})
         INSERT INTO tenant_usage_counters AS c (tenant_id, restaurant_id, period, orders)
         SELECT $1, r.id, date_trunc('month', now() AT TIME ZONE r.timezone)::date, $3
           FROM branches b JOIN restaurants r ON r.id = b.restaurant_id
          WHERE b.id = $2 AND ($4::int IS NULL OR (SELECT n FROM used) + $3 <= $4::int)
         ON CONFLICT (tenant_id, restaurant_id, period) DO UPDATE
           SET orders = c.orders + EXCLUDED.orders, updated_at = now()
         RETURNING c.orders`,
        [tenantId, opts.branchId, adding, limit],
      );
      if (!row) {
        const used = (await this.usage(db, kind)).ordersPerMonth ?? 0;
        this.limitReached(sub, kind, limit!, used);
      }
      return;
    }

    if (this.limitsFor(sub)[kind] === null) return; // unlimited: no lock, so busy tenants are not serialized
    // Serialize creations per tenant and limit, then read capacity and usage inside the lock, so
    // two concurrent requests cannot both take the last slot (and a just-granted add-on counts).
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`limit:${tenantId}:${kind}`]);
    const limit = (await this.effectiveLimits(db, sub))[kind]!;
    const used = (await this.usage(db, kind))[kind] ?? 0;
    if (used + adding > limit) this.limitReached(sub, kind, limit, used);
  }

  /**
   * Gives back an order's monthly slot when it is cancelled: the counter of the month (restaurant
   * time zone) the order was created in. Never goes below zero.
   */
  async releaseOrderSlot(db: Db, orderId: string) {
    await db.query(
      `UPDATE tenant_usage_counters c SET orders = c.orders - 1, updated_at = now()
         FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
        WHERE o.id = $1 AND c.tenant_id = o.tenant_id AND c.restaurant_id = o.restaurant_id
          AND c.period = date_trunc('month', o.created_at AT TIME ZONE r.timezone)::date
          AND c.orders > 0`,
      [orderId],
    );
  }

  private limitReached(sub: SubscriptionRow, kind: LimitKind, limit: number, used: number): never {
    const trial = sub.status === 'trialing';
    const packs = kind === 'ordersPerMonth' || kind === 'branches' || kind === 'staff';
    throw new ForbiddenException({
      code: LIMIT_CODES[kind],
      message: trial
        ? `The free trial includes ${limit} ${LIMIT_NOUNS[kind](limit)}. ${packs ? 'Buy an add-on pack or subscribe to a plan' : 'Subscribe to a plan'} to add more.`
        : `Your plan allows ${limit} ${LIMIT_NOUNS[kind](limit)}. ${packs ? 'Buy an add-on pack or upgrade your plan' : 'Upgrade your plan'} to add more.`,
      details: { limit, used, addonsAvailable: packs },
    });
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
      branchLimit:
        state.status === 'trialing' ? (await this.effectiveLimits(db, sub)).branches : null,
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
