import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { runPaged } from '../../common/pagination/paged';
import { type Db, DbContext } from '../../core/db/db-context';
import { CacheNs } from '../../shared/cache/cache.keys';
import { CacheService } from '../../shared/cache/cache.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { writeAudit } from '../auth/user-tokens';
import { type InvoiceRow, invoiceDto } from './billing.service';
import { type PlanRow, planDto, planSnapshot } from './plan-catalogue';
import { planRuleIssue } from './billing.schemas';
import type {
  AdminActivateInput,
  CreatePlanInput,
  ExtendTrialInput,
  MarkPaidInput,
  PlansQuery,
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
  owner_name?: string | null;
  owner_email?: string | null;
  /** The latest request / payment for this restaurant (any status). */
  last_invoice?: InvoiceRow | null;
  /** The open request awaiting payment, if any (a requested plan is not the current plan). */
  pending_invoice?: InvoiceRow | null;
};

/** Owner and latest invoice for each listed restaurant (platform scope). */
/** The restaurant's owner (first to join), one look-up per row for both name and email. */
const OWNER_JOIN = `
  LEFT JOIN LATERAL (SELECT u.full_name AS owner_name, u.email::text AS owner_email
                       FROM user_role_assignments a
                       JOIN roles r ON r.id = a.role_id AND r.code = 'owner'
                       JOIN tenant_memberships m ON m.id = a.membership_id
                       JOIN users u ON u.id = m.user_id
                      WHERE a.tenant_id = t.id
                      ORDER BY m.joined_at NULLS LAST, m.created_at LIMIT 1) ow ON true`;
const LATEST_INVOICE_JOIN = `
  LEFT JOIN LATERAL (SELECT * FROM subscription_invoices i WHERE i.tenant_id = s.tenant_id
                      ORDER BY i.created_at DESC LIMIT 1) li ON true`;
const PENDING_INVOICE_JOIN = `
  LEFT JOIN LATERAL (SELECT * FROM subscription_invoices i WHERE i.tenant_id = s.tenant_id
                        AND i.status = 'pending' LIMIT 1) pi ON true`;
const LIST_EXTRAS = `ow.owner_name, ow.owner_email, to_jsonb(li.*) AS last_invoice,
  to_jsonb(pi.*) AS pending_invoice`;

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
    ownerName: r.owner_name ?? null,
    ownerEmail: r.owner_email ?? null,
    /**
     * What the restaurant is on now: the paid plan's agreed terms (snapshot), or the Free Trial.
     * Never a requested plan: that only becomes current once its payment is verified.
     */
    currentPlan: r.plan_id
      ? {
          name: r.plan_snapshot?.name ?? r.plan_name,
          billingCycle: r.billing_cycle,
          priceMinor: r.plan_snapshot?.priceMinor ?? null,
          currencyCode: r.plan_snapshot?.currencyCode ?? 'INR',
        }
      : r.trial_ends_at
        ? { name: 'Free Trial', billingCycle: null, priceMinor: 0, currencyCode: 'INR' }
        : null,
    requested: r.pending_invoice ? invoiceDto(r.pending_invoice) : null,
    lastInvoice: r.last_invoice ? invoiceDto(r.last_invoice) : null,
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
  planType: 'plan_type',
  allowTrial: 'allow_trial',
  billingCycles: 'billing_cycles',
  featureFlags: 'feature_flags',
  ctaLabel: 'cta_label',
  adminNotes: 'admin_notes',
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
  // features[] mirrors the included lines; subscription snapshots and older clients read it.
  // A plain features list (older clients) means every line is included.
  const items = input.featureItems ?? input.features?.map((label) => ({ label, enabled: true }));
  if (items) {
    out.feature_items = JSON.stringify(items);
    out.features = items.filter((i) => i.enabled).map((i) => i.label);
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
    private readonly cache: CacheService,
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

  /** The Super Admin plan table: search by name/slug, filter, sort, paginate. */
  plansPage(auth: AuthContext, query: PlansQuery) {
    return this.run(auth, (db) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.status === 'archived') where.push('archived_at IS NOT NULL');
      if (query.status === 'active') where.push('archived_at IS NULL AND is_active');
      if (query.status === 'inactive') where.push('archived_at IS NULL AND NOT is_active');
      if (query.planType) {
        params.push(query.planType);
        where.push(`plan_type = $${params.length}`);
      }
      if (query.visibility)
        where.push(query.visibility === 'public' ? 'is_public' : 'NOT is_public');
      if (query.search) {
        params.push(`%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        where.push(`(name ILIKE $${params.length} OR code::text ILIKE $${params.length})`);
      }
      return runPaged<PlanRow, ReturnType<typeof planDto>>(db, {
        select: '*',
        from: 'plans',
        where,
        params,
        sortColumns: {
          sortOrder: 'sort_order',
          name: 'lower(name)',
          priceMonthlyMinor: 'price_monthly_minor',
          createdAt: 'created_at',
        },
        tiebreak: 'id',
        query,
        map: planDto,
      });
    });
  }

  plan(auth: AuthContext, id: string) {
    return this.run(auth, async (db) => {
      const row = await db.one<PlanRow>('SELECT * FROM plans WHERE id = $1', [id]);
      if (!row) throw planNotFound();
      return planDto(row);
    });
  }

  /**
   * Copies a plan as a hidden, inactive draft ("Name (copy)", slug "slug-copy[-n]") so the
   * Super Admin can adjust it before publishing. A Free Trial plan is copied as a paid plan,
   * since only one Free Trial plan may exist.
   */
  duplicatePlan(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.run(auth, async (db) => {
      // Public plan cache: invalidated once this write commits (not on rollback).
      this.cache.invalidateAfterCommit(db, CacheNs.plans());
      const src = await db.one<PlanRow>('SELECT * FROM plans WHERE id = $1', [id]);
      if (!src) throw planNotFound();
      const base = src.code.slice(0, 22);
      const baseName = src.name.slice(0, 30);
      const taken = await db.query<{ code: string; name: string }>(
        `SELECT code::text AS code, lower(name) AS name FROM plans
          WHERE code::text LIKE $1 OR lower(name) LIKE $2`,
        [`${base}-copy%`, `${baseName.toLowerCase()} (copy%`],
      );
      const codes = new Set(taken.map((t) => t.code));
      const names = new Set(taken.map((t) => t.name));
      let n = 1;
      const code = () => `${base}-copy${n > 1 ? `-${n}` : ''}`;
      const name = () => `${baseName} (copy${n > 1 ? ` ${n}` : ''})`;
      while (codes.has(code()) || names.has(name().toLowerCase())) n++;
      const row = await this.writePlan(() =>
        db.one<PlanRow>(
          `INSERT INTO plans (code, name, description, plan_type, currency_code, custom_pricing,
                              price_monthly_minor, price_yearly_minor, trial_days, allow_trial,
                              billing_cycles, max_branches, max_staff, max_orders_per_month,
                              max_menu_items, max_storage_mb, features, feature_items, feature_flags,
                              is_active, is_public, badge, icon, cta_label, admin_notes, sort_order)
           SELECT $2, $3, description,
                  CASE WHEN plan_type = 'free_trial' THEN 'paid' ELSE plan_type END,
                  currency_code, custom_pricing, price_monthly_minor, price_yearly_minor, trial_days,
                  allow_trial, billing_cycles, max_branches, max_staff, max_orders_per_month,
                  max_menu_items, max_storage_mb, features, feature_items, feature_flags,
                  false, false, NULL, icon, cta_label, admin_notes, least(sort_order + 1, 1000)
             FROM plans WHERE id = $1
           RETURNING *`,
          [id, code(), name()],
        ),
      );
      await this.audit(db, auth, meta, 'plan.duplicated', row!.id, {
        from: src.code,
        code: row!.code,
      });
      return planDto(row!);
    });
  }

  createPlan(auth: AuthContext, input: CreatePlanInput, meta: RequestMeta) {
    return this.run(auth, async (db) => {
      // Public plan cache: invalidated once this write commits (not on rollback).
      this.cache.invalidateAfterCommit(db, CacheNs.plans());
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
      // Public plan cache: invalidated once this write commits (not on rollback).
      this.cache.invalidateAfterCommit(db, CacheNs.plans());
      const current = await db.one<PlanRow>('SELECT * FROM plans WHERE id = $1 FOR UPDATE', [id]);
      if (!current) throw planNotFound();
      if (current.archived_at && (input.isActive || input.isPublic)) {
        throw new BadRequestException({
          code: 'PLAN_ARCHIVED',
          message: 'Restore this plan before activating or publishing it.',
        });
      }
      // Re-check cross-field rules against the row as it will be after this edit.
      const toNumber = (v: string | null) => (v === null ? null : Number(v));
      const customPricing = input.customPricing ?? current.custom_pricing;
      const issue = planRuleIssue({
        planType: input.planType ?? current.plan_type,
        customPricing,
        priceMonthlyMinor: customPricing
          ? null
          : input.priceMonthlyMinor !== undefined
            ? input.priceMonthlyMinor
            : toNumber(current.price_monthly_minor),
        priceYearlyMinor: customPricing
          ? null
          : input.priceYearlyMinor !== undefined
            ? input.priceYearlyMinor
            : toNumber(current.price_yearly_minor),
      });
      if (issue) {
        throw new BadRequestException({
          code: 'PLAN_INVALID',
          message: issue.message,
          details: { field: issue.path },
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

  /**
   * Restores an archived plan as an inactive, hidden draft. The Super Admin then reviews it and
   * activates / publishes it explicitly. Fails if another live Free Trial plan exists.
   */
  restorePlan(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.run(auth, async (db) => {
      // Public plan cache: invalidated once this write commits (not on rollback).
      this.cache.invalidateAfterCommit(db, CacheNs.plans());
      const row = await this.writePlan(() =>
        db.one<PlanRow>(
          `UPDATE plans SET archived_at = NULL, updated_at = now()
            WHERE id = $1 AND archived_at IS NOT NULL RETURNING *`,
          [id],
        ),
      );
      await this.audit(db, auth, meta, 'plan.restored', id, { code: row!.code });
      return planDto(row!);
    });
  }

  /** Withdraws a plan from new customers (reversible: see restorePlan); subscribers keep their terms. */
  archivePlan(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.run(auth, async (db) => {
      // Public plan cache: invalidated once this write commits (not on rollback).
      this.cache.invalidateAfterCommit(db, CacheNs.plans());
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
      // Public plan cache: invalidated once this write commits (not on rollback).
      this.cache.invalidateAfterCommit(db, CacheNs.plans());
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
      const constraint = (e as { constraint?: string }).constraint;
      if (code === '23505') {
        throw new ConflictException(
          constraint === 'plans_name_key'
            ? { code: 'PLAN_NAME_EXISTS', message: 'A plan with this name already exists.' }
            : constraint === 'plans_one_free_trial'
              ? {
                  code: 'FREE_TRIAL_EXISTS',
                  message:
                    'There is already a Free Trial plan. Edit it, or archive it before creating another.',
                }
              : { code: 'PLAN_EXISTS', message: 'A plan with this slug already exists.' },
        );
      }
      if (code === '23514') {
        throw new BadRequestException({
          code: 'PLAN_INVALID',
          message:
            constraint === 'plans_free_trial_price'
              ? 'A Free Trial plan is always ₹0.'
              : constraint === 'plans_custom_pricing_type'
                ? 'Only Enterprise plans can use custom pricing.'
                : 'Check the plan details: enter both prices, or use custom pricing with no prices.',
        });
      }
      throw e;
    }
  }

  invoices(auth: AuthContext, query: PlatformInvoicesQuery) {
    return this.run(auth, (db) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.status === 'failed') {
        where.push(`i.status = 'pending' AND i.failed_at IS NOT NULL`);
      } else if (query.status) {
        params.push(query.status);
        where.push(`i.status = $${params.length}`);
      }
      if (query.search) {
        params.push(`%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        const n = params.length;
        where.push(
          `(i.invoice_number ILIKE $${n} OR t.name ILIKE $${n} OR i.gateway_payment_id ILIKE $${n}
             OR i.payment_reference ILIKE $${n})`,
        );
      }
      return runPaged<
        InvoiceRow & { tenant_name: string; owner_name: string | null; owner_email: string | null },
        unknown
      >(db, {
        select: 'i.*, t.name AS tenant_name, ow.owner_name, ow.owner_email',
        from: `subscription_invoices i JOIN tenants t ON t.id = i.tenant_id ${OWNER_JOIN}`,
        // The owner look-up only adds columns: counting needs the invoices and tenants alone.
        countFrom: 'subscription_invoices i JOIN tenants t ON t.id = i.tenant_id',
        where,
        params,
        sortColumns: { createdAt: 'i.created_at', amountMinor: 'i.amount_minor' },
        tiebreak: 'i.id',
        cursor: {
          types: { createdAt: 'timestamptz', amountMinor: 'bigint' },
          tiebreakType: 'uuid',
        },
        query,
        map: (r) => ({
          ...invoiceDto(r),
          tenantId: r.tenant_id,
          tenantName: r.tenant_name,
          ownerName: r.owner_name,
          ownerEmail: r.owner_email,
        }),
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
      if (query.group === 'pending') {
        where.push(
          `(s.status = 'pending_payment' OR EXISTS (SELECT 1 FROM subscription_invoices pi
              WHERE pi.tenant_id = s.tenant_id AND pi.status = 'pending'))`,
        );
      } else if (query.group === 'active') {
        where.push(`s.status IN ('active', 'past_due')`);
      } else if (query.group === 'expired') {
        where.push(`s.status = 'expired'`);
      } else if (query.group === 'inactive') {
        where.push(`s.status IN ('cancelled', 'suspended')`);
      }
      if (query.paymentStatus) {
        const ps = query.paymentStatus;
        if (ps === 'payment_failed')
          where.push(`li.status = 'pending' AND li.failed_at IS NOT NULL`);
        else if (ps === 'pending_payment')
          where.push(
            `li.status = 'pending' AND li.failed_at IS NULL AND li.gateway_order_id IS NOT NULL`,
          );
        else if (ps === 'awaiting_payment')
          where.push(
            `li.status = 'pending' AND li.failed_at IS NULL AND li.gateway_order_id IS NULL`,
          );
        else {
          params.push(ps);
          where.push(`li.status = $${params.length}`);
        }
      }
      if (query.search) {
        params.push(`%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        const n = params.length;
        where.push(
          `(t.name ILIKE $${n} OR t.slug::text ILIKE $${n} OR li.invoice_number ILIKE $${n}
             OR li.gateway_payment_id ILIKE $${n} OR li.payment_reference ILIKE $${n})`,
        );
      }
      const usesLatest = where.some((w) => /\bli\./.test(w));
      return runPaged<SubscriptionListRow, unknown>(db, {
        select: `s.*, t.name AS tenant_name, t.slug::text AS tenant_slug, t.status AS tenant_status,
                 p.name AS plan_name, ${LIST_EXTRAS}`,
        from: `subscriptions s JOIN tenants t ON t.id = s.tenant_id LEFT JOIN plans p ON p.id = s.plan_id
                ${LATEST_INVOICE_JOIN} ${PENDING_INVOICE_JOIN} ${OWNER_JOIN}`,
        // Filters may use the latest invoice (li); the owner and pending look-ups only add columns.
        countFrom: `subscriptions s JOIN tenants t ON t.id = s.tenant_id
                     ${usesLatest ? LATEST_INVOICE_JOIN : ''}`,
        where,
        params,
        sortColumns: {
          periodEnd: 's.current_period_end',
          createdAt: 's.created_at',
          name: 'lower(t.name)',
          requestedAt: 'li.created_at',
          amountMinor: 'li.amount_minor',
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
        // The Free Trial plan is the starting terms for new restaurants, not something to grant.
        `SELECT * FROM plans WHERE id = $1 AND archived_at IS NULL AND plan_type <> 'free_trial'`,
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
