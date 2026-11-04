import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { runPaged } from '../../common/pagination/paged';
import { type Db, DbContext } from '../../core/db/db-context';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { writeAudit } from '../auth/user-tokens';
import { type InvoiceRow, invoiceDto } from './billing.service';
import { type PlanRow, planDto, planSnapshot } from './plan-catalogue';
import type {
  AdminActivateInput,
  CreatePlanInput,
  ExtendTrialInput,
  MarkPaidInput,
  PlatformInvoicesQuery,
  PlatformSubscriptionsQuery,
  SuspendInput,
  UpdatePlanInput,
} from './billing.schemas';
import {
  iso,
  stored,
  SubscriptionLifecycleService,
  type SubscriptionRow,
} from './subscription-lifecycle.service';
import { addCycle, subscriptionState } from './subscription-state';

const DAY = 86_400_000;

type SubscriptionListRow = SubscriptionRow & {
  tenant_name: string;
  tenant_slug: string;
  tenant_status: string;
  plan_name: string | null;
};

function subscriptionDto(r: SubscriptionListRow) {
  const state = subscriptionState(stored(r), new Date());
  return {
    id: r.id,
    tenantId: r.tenant_id,
    tenantName: r.tenant_name,
    tenantSlug: r.tenant_slug,
    tenantStatus: r.tenant_status,
    status: state.status,
    hasAccess: state.hasAccess,
    planId: r.plan_id,
    planName: r.plan_name,
    billingCycle: r.billing_cycle,
    trialStartedAt: iso(r.trial_started_at),
    trialEndsAt: iso(r.trial_ends_at),
    periodStart: iso(r.current_period_start),
    periodEnd: iso(r.current_period_end),
    remainingDays: state.remainingDays,
    statusReason: r.status_reason,
    statusChangedAt: iso(r.status_changed_at),
  };
}

const planNotFound = () =>
  new NotFoundException({ code: 'PLAN_NOT_FOUND', message: 'Plan not found.' });

/** API field → column. Only fields present in the input are written. */
const PLAN_COLUMNS: Record<string, string> = {
  name: 'name',
  description: 'description',
  currencyCode: 'currency_code',
  customPricing: 'custom_pricing',
  priceMonthlyMinor: 'price_monthly_minor',
  priceYearlyMinor: 'price_yearly_minor',
  trialDays: 'trial_days',
  maxBranches: 'max_branches',
  maxStaff: 'max_staff',
  maxOrdersPerMonth: 'max_orders_per_month',
  maxMenuItems: 'max_menu_items',
  maxStorageMb: 'max_storage_mb',
  features: 'features',
  featureFlags: 'feature_flags',
  isActive: 'is_active',
  isPublic: 'is_public',
  badge: 'badge',
  icon: 'icon',
  sortOrder: 'sort_order',
};

function planColumns(input: Partial<CreatePlanInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const col = PLAN_COLUMNS[k];
    if (!col || v === undefined) continue;
    out[col] = k === 'featureFlags' ? JSON.stringify(v) : v;
  }
  return out;
}

const notFound = () =>
  new NotFoundException({ code: 'SUBSCRIPTION_NOT_FOUND', message: 'Subscription not found.' });

/**
 * Super Admin side of billing: plan catalogue, payment verification, and subscription controls
 * (extend trial, grant a plan, suspend, reinstate) with full history. Every status change goes
 * through SubscriptionLifecycleService.
 */
@Injectable()
export class PlatformBillingService {
  constructor(
    private readonly db: DbContext,
    private readonly lifecycle: SubscriptionLifecycleService,
  ) {}

  /** Every plan, including inactive and archived ones (archived last). */
  listPlans(auth: AuthContext) {
    return this.run(auth, async (db) =>
      (
        await db.query<PlanRow>(
          `SELECT * FROM plans ORDER BY archived_at IS NOT NULL, sort_order, price_monthly_minor NULLS LAST`,
        )
      ).map(planDto),
    );
  }

  createPlan(auth: AuthContext, input: CreatePlanInput, meta: RequestMeta) {
    return this.run(auth, async (db) => {
      const cols = { code: input.code, ...planColumns(input) };
      const names = Object.keys(cols);
      const row = await this.writePlan(() =>
        db.one<PlanRow>(
          `INSERT INTO plans (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
          Object.values(cols),
        ),
      );
      await this.audit(db, auth, meta, 'plan.created', row!.id, { code: input.code });
      return planDto(row!);
    });
  }

  /**
   * Edits a plan. Existing subscriptions keep their snapshot (price, limits, features); the
   * change applies to new purchases and to upgrades/cycle changes from now on.
   */
  updatePlan(auth: AuthContext, id: string, input: UpdatePlanInput, meta: RequestMeta) {
    return this.run(auth, async (db) => {
      const current = await db.one<PlanRow>('SELECT * FROM plans WHERE id = $1 FOR UPDATE', [id]);
      if (!current) throw planNotFound();
      if (current.archived_at && (input.isActive || input.isPublic)) {
        throw new BadRequestException({
          code: 'PLAN_ARCHIVED',
          message: 'Archived plans cannot be activated or shown. Create a new plan instead.',
        });
      }
      const cols = planColumns(input);
      // Switching to custom pricing clears prices unless new ones were given (and vice versa).
      if (input.customPricing === true) {
        cols.price_monthly_minor = null;
        cols.price_yearly_minor = null;
      }
      const params: unknown[] = [id];
      const sets = Object.entries(cols).map(([c, v]) => {
        params.push(v);
        return `${c} = $${params.length}`;
      });
      const row = await this.writePlan(() =>
        db.one<PlanRow>(
          `UPDATE plans SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
          params,
        ),
      );
      await this.audit(db, auth, meta, 'plan.updated', id, input);
      return planDto(row!);
    });
  }

  /** Hides a plan from new customers for good; existing subscribers keep their snapshot. */
  archivePlan(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.run(auth, async (db) => {
      const row = await db.one<PlanRow>(
        `UPDATE plans SET archived_at = coalesce(archived_at, now()), is_active = false, is_public = false,
                updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id],
      );
      if (!row) throw planNotFound();
      await this.audit(db, auth, meta, 'plan.archived', id, { code: row.code });
      return planDto(row);
    });
  }

  /** Deletes a plan nobody has ever used; otherwise asks to archive it instead. */
  deletePlan(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.run(auth, async (db) => {
      const used = await db.one<{ n: string }>(
        `SELECT (SELECT count(*) FROM subscriptions WHERE plan_id = $1)
              + (SELECT count(*) FROM subscription_invoices WHERE plan_id = $1) AS n`,
        [id],
      );
      if (Number(used?.n ?? 0) > 0) {
        throw new ConflictException({
          code: 'PLAN_IN_USE',
          message:
            'This plan has subscriptions or invoices, so it cannot be deleted. Archive it instead to hide it from new customers.',
        });
      }
      const row = await db.one<{ code: string }>('DELETE FROM plans WHERE id = $1 RETURNING code', [
        id,
      ]);
      if (!row) throw planNotFound();
      await this.audit(db, auth, meta, 'plan.deleted', id, { code: row.code });
    });
  }

  private async writePlan<T>(write: () => Promise<T>): Promise<T> {
    try {
      const row = await write();
      if (!row) throw planNotFound();
      return row;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23505') {
        throw new ConflictException({
          code: 'PLAN_EXISTS',
          message: 'A plan with this slug already exists.',
        });
      }
      if (code === '23514') {
        throw new BadRequestException({
          code: 'PLAN_INVALID',
          message: 'Set both prices, or mark the plan as custom pricing with no prices.',
        });
      }
      throw e;
    }
  }

  invoices(auth: AuthContext, query: PlatformInvoicesQuery) {
    return this.run(auth, (db) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.status) {
        params.push(query.status);
        where.push(`i.status = $${params.length}`);
      }
      if (query.search) {
        params.push(`%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        where.push(`(i.invoice_number ILIKE $${params.length} OR t.name ILIKE $${params.length})`);
      }
      return runPaged<InvoiceRow & { tenant_name: string }, unknown>(db, {
        select: 'i.*, t.name AS tenant_name',
        from: 'subscription_invoices i JOIN tenants t ON t.id = i.tenant_id',
        where,
        params,
        sortColumns: { createdAt: 'i.created_at', amountMinor: 'i.amount_minor' },
        tiebreak: 'i.id',
        query,
        map: (r) => ({ ...invoiceDto(r), tenantId: r.tenant_id, tenantName: r.tenant_name }),
      });
    });
  }

  /**
   * Verifies an offline payment and applies it through the same path as online checkout.
   * Renewals, downgrades and cycle changes extend from the end of an active period (no days
   * lost); upgrades and first purchases start now.
   */
  markPaid(auth: AuthContext, invoiceId: string, input: MarkPaidInput, meta: RequestMeta) {
    return this.run(auth, async (db) => {
      const inv = await this.lifecycle.applyPaidInvoice(db, invoiceId, {
        method: input.paymentMethod,
        reference: input.paymentReference,
        note: input.note ?? null,
        verifiedBy: auth.userId,
      });
      const updated = await db.one<InvoiceRow>(
        'SELECT * FROM subscription_invoices WHERE id = $1',
        [invoiceId],
      );
      await this.audit(db, auth, meta, 'subscription.payment_verified', invoiceId, {
        tenantId: inv.tenant_id,
        amountMinor: Number(inv.amount_minor),
        method: input.paymentMethod,
        periodEnd: iso(updated!.period_end),
      });
      return invoiceDto(updated!);
    });
  }

  /**
   * All restaurant subscriptions with trial and period dates. Runs the expiry sweep first so the
   * stored statuses (and the status filter) are current.
   */
  async subscriptions(auth: AuthContext, query: PlatformSubscriptionsQuery) {
    await this.lifecycle.sweep();
    return this.run(auth, (db) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.status) {
        params.push(query.status);
        where.push(`s.status = $${params.length}`);
      }
      if (query.search) {
        params.push(`%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        where.push(`(t.name ILIKE $${params.length} OR t.slug::text ILIKE $${params.length})`);
      }
      return runPaged<SubscriptionListRow, unknown>(db, {
        select: `s.*, t.name AS tenant_name, t.slug::text AS tenant_slug, t.status AS tenant_status,
                 p.name AS plan_name`,
        from: 'subscriptions s JOIN tenants t ON t.id = s.tenant_id LEFT JOIN plans p ON p.id = s.plan_id',
        where,
        params,
        sortColumns: {
          periodEnd: 's.current_period_end',
          createdAt: 's.created_at',
          name: 't.name',
        },
        tiebreak: 's.id',
        query,
        map: subscriptionDto,
      });
    });
  }

  /** One restaurant's subscription with its status history and payments. */
  subscription(auth: AuthContext, tenantId: string) {
    return this.run(auth, async (db) => {
      const row = await db.one<SubscriptionListRow>(
        `SELECT s.*, t.name AS tenant_name, t.slug::text AS tenant_slug, t.status AS tenant_status,
                p.name AS plan_name
           FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id LEFT JOIN plans p ON p.id = s.plan_id
          WHERE s.tenant_id = $1`,
        [tenantId],
      );
      if (!row) throw notFound();
      const synced = await this.lifecycle.sync(db, row);
      const events = await db.query<{
        id: string;
        event: string;
        from_status: string | null;
        to_status: string | null;
        reason: string | null;
        invoice_id: string | null;
        actor_name: string | null;
        metadata: Record<string, unknown>;
        created_at: Date;
      }>(
        `SELECT e.*, u.full_name AS actor_name FROM subscription_events e
           LEFT JOIN users u ON u.id = e.actor_user_id
          WHERE e.tenant_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT 200`,
        [tenantId],
      );
      const invoices = await db.query<InvoiceRow>(
        'SELECT * FROM subscription_invoices WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100',
        [tenantId],
      );
      return {
        ...subscriptionDto({ ...row, ...synced }),
        events: events.map((e) => ({
          id: e.id,
          event: e.event,
          fromStatus: e.from_status,
          toStatus: e.to_status,
          reason: e.reason,
          invoiceId: e.invoice_id,
          actorName: e.actor_name,
          metadata: e.metadata,
          createdAt: iso(e.created_at)!,
        })),
        invoices: invoices.map(invoiceDto),
      };
    });
  }

  /** Extends (or restarts) a trial from the later of now and the current trial end. */
  extendTrial(auth: AuthContext, tenantId: string, input: ExtendTrialInput, meta: RequestMeta) {
    return this.change(auth, tenantId, meta, 'subscription.trial_extended', async (db, sub) => {
      if (sub.plan_id && ['active', 'past_due', 'cancelled'].includes(sub.status)) {
        throw new BadRequestException({
          code: 'NOT_A_TRIAL',
          message: 'This restaurant has a paid plan; its trial cannot be extended.',
        });
      }
      if (sub.status === 'suspended') {
        throw new BadRequestException({
          code: 'SUBSCRIPTION_SUSPENDED',
          message: 'Reinstate the subscription before extending its trial.',
        });
      }
      const current = sub.trial_ends_at ? new Date(sub.trial_ends_at).getTime() : 0;
      const end = new Date(Math.max(Date.now(), current) + input.days * DAY);
      const started = sub.trial_started_at ?? sub.current_period_start;
      return this.lifecycle.transition(db, sub, 'trialing', {
        event: 'trial_extended',
        reason: input.reason,
        actorUserId: auth.userId,
        metadata: { days: input.days, trialEndsAt: end.toISOString() },
        set: {
          plan_id: null,
          billing_cycle: null,
          plan_snapshot: null,
          trial_started_at: started,
          current_period_start: started,
          trial_ends_at: end,
          current_period_end: end,
        },
      });
    });
  }

  /** Grants a plan for one cycle without a payment (e.g. a negotiated deal); always audited. */
  activate(auth: AuthContext, tenantId: string, input: AdminActivateInput, meta: RequestMeta) {
    return this.change(auth, tenantId, meta, 'subscription.admin_activated', async (db, sub) => {
      const plan = await db.one<PlanRow>(
        'SELECT * FROM plans WHERE id = $1 AND archived_at IS NULL',
        [input.planId],
      );
      if (!plan) {
        throw new NotFoundException({ code: 'PLAN_NOT_FOUND', message: 'Plan not found.' });
      }
      if (sub.status === 'suspended') {
        throw new BadRequestException({
          code: 'SUBSCRIPTION_SUSPENDED',
          message: 'Reinstate the subscription before activating a plan.',
        });
      }
      const now = new Date();
      await db.query(
        `UPDATE tenants SET status = 'active', status_changed_at = now() WHERE id = $1 AND status = 'trial'`,
        [tenantId],
      );
      return this.lifecycle.transition(db, sub, 'active', {
        event: 'admin_activated',
        reason: input.reason,
        actorUserId: auth.userId,
        metadata: { planId: input.planId, billingCycle: input.billingCycle },
        set: {
          plan_id: input.planId,
          billing_cycle: input.billingCycle,
          current_period_start: now,
          current_period_end: addCycle(now, input.billingCycle),
          cancelled_at: null,
          plan_snapshot: JSON.stringify(
            planSnapshot(
              plan,
              input.billingCycle,
              Number(
                (input.billingCycle === 'yearly'
                  ? plan.price_yearly_minor
                  : plan.price_monthly_minor) ?? 0,
              ),
            ),
          ),
        },
      });
    });
  }

  suspend(auth: AuthContext, tenantId: string, input: SuspendInput, meta: RequestMeta) {
    return this.change(auth, tenantId, meta, 'subscription.suspended', (db, sub) => {
      if (sub.status === 'suspended') {
        throw new BadRequestException({
          code: 'ALREADY_SUSPENDED',
          message: 'This subscription is already suspended.',
        });
      }
      return this.lifecycle.transition(db, sub, 'suspended', {
        event: 'suspended',
        reason: input.reason,
        actorUserId: auth.userId,
      });
    });
  }

  /** Lifts a suspension; the status returns to what the dates say (trial, active or expired). */
  reinstate(auth: AuthContext, tenantId: string, meta: RequestMeta) {
    return this.change(auth, tenantId, meta, 'subscription.reinstated', (db, sub) => {
      if (sub.status !== 'suspended') {
        throw new BadRequestException({
          code: 'NOT_SUSPENDED',
          message: 'This subscription is not suspended.',
        });
      }
      const live = !sub.current_period_end || new Date(sub.current_period_end) > new Date();
      const to = !live ? 'expired' : sub.plan_id || !sub.trial_ends_at ? 'active' : 'trialing';
      return this.lifecycle.transition(db, sub, to, {
        event: 'reinstated',
        actorUserId: auth.userId,
      });
    });
  }

  private change(
    auth: AuthContext,
    tenantId: string,
    meta: RequestMeta,
    action: string,
    work: (db: Db, sub: SubscriptionRow) => Promise<SubscriptionRow>,
  ) {
    return this.run(auth, async (db) => {
      const sub = await db.one<SubscriptionRow>(
        'SELECT * FROM subscriptions WHERE tenant_id = $1 FOR UPDATE',
        [tenantId],
      );
      if (!sub) throw notFound();
      const updated = await work(db, await this.lifecycle.sync(db, sub));
      await this.audit(db, auth, meta, action, updated.id, {
        tenantId,
        status: updated.status,
        reason: updated.status_reason,
      });
      return { status: updated.status, periodEnd: iso(updated.current_period_end) };
    });
  }

  cancelInvoice(auth: AuthContext, invoiceId: string, meta: RequestMeta) {
    return this.run(auth, async (db) => {
      const r = await db.one<{ id: string; tenant_id: string }>(
        `UPDATE subscription_invoices SET status = 'cancelled', cancelled_at = now()
          WHERE id = $1 AND status = 'pending' RETURNING id, tenant_id`,
        [invoiceId],
      );
      if (!r)
        throw new BadRequestException({
          code: 'NOT_PENDING',
          message: 'This invoice is not awaiting payment.',
        });
      await this.lifecycle.clearPendingPayment(db, r.tenant_id, invoiceId);
      await this.audit(db, auth, meta, 'subscription.invoice_cancelled', invoiceId, {});
    });
  }

  private run<T>(auth: AuthContext, work: (db: Db) => Promise<T>) {
    return this.db.run({ platform: true, userId: auth.userId }, work);
  }

  private audit(
    db: Db,
    auth: AuthContext,
    meta: RequestMeta,
    action: string,
    id: string,
    metadata: object,
  ) {
    return writeAudit(db, {
      action,
      actorUserId: auth.userId,
      actorSessionId: auth.sessionId,
      actorAudience: 'platform',
      entityType: 'billing',
      entityId: id,
      metadata: metadata as Record<string, unknown>,
      ...meta,
    });
  }
}
