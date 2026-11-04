import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { runPaged } from '../../common/pagination/paged';
import { AppConfigService } from '../../config/app-config.service';
import { type Db, DbContext } from '../../core/db/db-context';
import { AccessService } from '../auth/access.service';
import type { AuthContext, RequestMeta, TenantAccess } from '../auth/auth.types';
import { writeAudit } from '../auth/user-tokens';
import type {
  CheckoutFailedInput,
  InvoicesQuery,
  RequestChangeInput,
  VerifyCheckoutInput,
} from './billing.schemas';
import { PAYMENT_GATEWAY, type PaymentGateway } from './payment-gateway';
import { OFFERED_SQL, type PlanRow, publicPlanDto } from './plan-catalogue';
import { iso, stored, SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { subscriptionState, trialReminder } from './subscription-state';

export interface InvoiceRow {
  id: string;
  tenant_id: string;
  invoice_number: string;
  plan_id: string;
  plan_name: string;
  billing_cycle: 'monthly' | 'yearly';
  kind: string;
  amount_minor: string;
  currency_code: string;
  status: 'pending' | 'paid' | 'cancelled';
  period_start: Date | null;
  period_end: Date | null;
  payment_method: string | null;
  payment_reference: string | null;
  created_at: Date;
  paid_at: Date | null;
  gateway: string | null;
  gateway_order_id: string | null;
  failure_reason: string | null;
  failed_at: Date | null;
}

export function invoiceDto(r: InvoiceRow) {
  return {
    id: r.id,
    invoiceNumber: r.invoice_number,
    planId: r.plan_id,
    planName: r.plan_name,
    billingCycle: r.billing_cycle,
    kind: r.kind,
    amountMinor: Number(r.amount_minor),
    currencyCode: r.currency_code.trim(),
    status: r.status,
    periodStart: iso(r.period_start),
    periodEnd: iso(r.period_end),
    paymentMethod: r.payment_method,
    paymentReference: r.payment_reference,
    createdAt: iso(r.created_at)!,
    paidAt: iso(r.paid_at),
    gateway: r.gateway,
    failureReason: r.failure_reason,
    failedAt: iso(r.failed_at),
  };
}

const forbidden = () =>
  new ForbiddenException({
    code: 'BILLING_FORBIDDEN',
    message: 'Only the owner or an admin can manage the subscription.',
  });

/**
 * The restaurant's own subscription: status and dates computed from stored data, plan usage
 * from real counts, plan purchase (online checkout or an offline request) and billing history.
 * A plan activates only after payment is verified on the server: a gateway signature or webhook
 * for online checkout, or a Super Admin confirming an offline payment. Never on the client's word.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger('Billing');

  constructor(
    private readonly db: DbContext,
    private readonly access: AccessService,
    private readonly config: AppConfigService,
    private readonly lifecycle: SubscriptionLifecycleService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  /** Access state for any member (drives the expired screen and trial reminders). */
  entitlement(auth: AuthContext) {
    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, async (db) => {
      const access = await this.access.tenantAccess(db, auth.membershipId!);
      return {
        ...(await this.lifecycle.entitlement(db, auth.tenantId!)),
        canManage: canManage(access),
      };
    });
  }

  overview(auth: AuthContext) {
    return this.run(auth, async (db, access) => {
      this.requireView(access);
      const sub = await this.lifecycle.sync(db, await this.lifecycle.load(db, auth.tenantId!));
      const pending = await db.one<InvoiceRow>(
        `SELECT * FROM subscription_invoices WHERE status = 'pending'`,
      );
      // The same offered-plan list and view the public landing page uses.
      const plans = await db.query<PlanRow>(
        `SELECT * FROM plans WHERE ${OFFERED_SQL} ORDER BY sort_order, price_monthly_minor NULLS LAST`,
      );
      const live = sub.plan_id
        ? await db.one<PlanRow>('SELECT * FROM plans WHERE id = $1', [sub.plan_id])
        : undefined;
      const snap = sub.plan_snapshot;
      // The current plan as agreed: name, limits and features from the snapshot, not the live row.
      const plan =
        live && snap
          ? {
              ...publicPlanDto(live),
              name: snap.name,
              limits: snap.limits,
              features: snap.features,
            }
          : live
            ? publicPlanDto(live)
            : null;
      const state = subscriptionState(stored(sub), new Date());
      const paid = Boolean(plan);
      const used = await this.lifecycle.usage(db);

      return {
        status: state.status,
        hasAccess: state.hasAccess,
        alert: state.alert,
        reminder: trialReminder(
          state.status,
          state.remainingDays,
          !paid && sub.trial_ends_at !== null,
        ),
        trialStartedAt: iso(sub.trial_started_at),
        trialEndsAt: iso(sub.trial_ends_at),
        periodStart: iso(state.periodStart),
        periodEnd: iso(state.periodEnd),
        renewsOn: paid && state.status === 'active' ? iso(state.periodEnd) : null,
        remainingDays: state.remainingDays,
        totalDays: state.totalDays,
        elapsed: state.elapsed,
        billingCycle: sub.billing_cycle,
        plan,
        /** What this customer pays per cycle (agreed price, unaffected by later plan edits). */
        price: snap?.priceMinor ?? null,
        currencyCode: snap?.currencyCode ?? plan?.currencyCode ?? 'INR',
        limits: this.lifecycle.limitsFor(sub),
        autoRenew: false,
        branchLimit: this.lifecycle.limitsFor(sub).branches,
        pendingInvoice: pending ? invoiceDto(pending) : null,
        paymentInstructions: this.config.get('BILLING_PAYMENT_INSTRUCTIONS') ?? null,
        onlinePayments: this.gateway.enabled,
        plans: plans.map(publicPlanDto),
        usage: { ...used, ordersThisMonth: used.ordersPerMonth },
        canManage: canManage(access),
      };
    });
  }

  /** Creates a pending invoice for an offline payment that a Super Admin will verify. */
  requestChange(auth: AuthContext, input: RequestChangeInput, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      if (!canManage(access)) throw forbidden();
      return invoiceDto(await this.createInvoice(db, auth, input, meta));
    });
  }

  /**
   * Starts an online payment: reuses or creates the pending invoice for this plan and cycle and
   * opens a gateway order for its server-computed amount. The browser never sets the price.
   */
  checkout(auth: AuthContext, input: RequestChangeInput, meta: RequestMeta) {
    if (!this.gateway.enabled) {
      throw new BadRequestException({
        code: 'PAYMENTS_UNAVAILABLE',
        message: 'Online payment is not set up yet. Request the plan and pay offline instead.',
      });
    }
    return this.run(auth, async (db, access) => {
      if (!canManage(access)) throw forbidden();
      const existing = await db.one<InvoiceRow>(
        `SELECT * FROM subscription_invoices WHERE status = 'pending' FOR UPDATE`,
      );
      const inv =
        existing &&
        existing.plan_id === input.planId &&
        existing.billing_cycle === input.billingCycle
          ? existing
          : await this.createInvoice(db, auth, input, meta);
      let orderId = inv.gateway_order_id;
      if (!orderId) {
        orderId = (
          await this.gateway.createOrder({
            amountMinor: Number(inv.amount_minor),
            currency: inv.currency_code.trim(),
            receipt: inv.invoice_number,
            notes: { invoiceId: inv.id, tenantId: auth.tenantId! },
          })
        ).orderId;
        await db.query(
          `UPDATE subscription_invoices SET gateway = $2, gateway_order_id = $3 WHERE id = $1`,
          [inv.id, this.gateway.name, orderId],
        );
      }
      await this.lifecycle.markPendingPayment(db, auth.tenantId!, inv.id);
      return {
        invoice: invoiceDto(inv),
        gateway: this.gateway.name,
        keyId: this.gateway.publicKey,
        orderId,
        amountMinor: Number(inv.amount_minor),
        currencyCode: inv.currency_code.trim(),
      };
    });
  }

  /**
   * Confirms a checkout from the signature the gateway gave the browser. The signature is an
   * HMAC over (order, payment) with our secret, so it cannot be forged client-side; the order
   * must also belong to this tenant's invoice.
   */
  verifyCheckout(auth: AuthContext, input: VerifyCheckoutInput, meta: RequestMeta) {
    return this.db.run(
      { platform: true, tenantId: auth.tenantId, userId: auth.userId },
      async (db) => {
        await this.assertCanManage(db, auth);
        const inv = await db.one<InvoiceRow>(
          `SELECT * FROM subscription_invoices WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
          [input.invoiceId, auth.tenantId],
        );
        if (!inv || inv.gateway_order_id !== input.orderId) {
          throw new NotFoundException({ code: 'INVOICE_NOT_FOUND', message: 'Payment not found.' });
        }
        if (!this.gateway.verifyCheckout(input.orderId, input.paymentId, input.signature)) {
          await this.audit(db, auth, meta, 'subscription.payment_rejected', inv.id, {});
          throw new BadRequestException({
            code: 'PAYMENT_VERIFICATION_FAILED',
            message:
              'We could not verify this payment. If money was deducted, it will be confirmed automatically or refunded by the bank.',
          });
        }
        await this.lifecycle.applyPaidInvoice(db, inv.id, {
          method: 'online',
          reference: input.paymentId,
          gateway: this.gateway.name,
          gatewayPaymentId: input.paymentId,
        });
        await this.audit(db, auth, meta, 'subscription.payment_succeeded', inv.id, {
          gateway: this.gateway.name,
          paymentId: input.paymentId,
        });
        const row = await db.one<InvoiceRow>('SELECT * FROM subscription_invoices WHERE id = $1', [
          inv.id,
        ]);
        return invoiceDto(row!);
      },
    );
  }

  /** The checkout reported a failed or abandoned attempt. Only records it; grants nothing. */
  checkoutFailed(auth: AuthContext, input: CheckoutFailedInput, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      if (!canManage(access)) throw forbidden();
      const inv = await db.one<{ id: string }>(
        `SELECT id FROM subscription_invoices WHERE id = $1 AND status = 'pending'`,
        [input.invoiceId],
      );
      if (!inv) {
        throw new NotFoundException({ code: 'INVOICE_NOT_FOUND', message: 'Payment not found.' });
      }
      await this.lifecycle.recordPaymentFailure(db, inv.id, input.reason ?? 'Payment failed');
      await this.audit(db, auth, meta, 'subscription.payment_failed', inv.id, {});
    });
  }

  /**
   * Gateway webhook (no session). Authenticated by its HMAC signature, de-duplicated by event id,
   * and only applied when the order maps to a pending invoice with the same amount and currency.
   */
  async webhook(rawBody: Buffer | undefined, signature: string, eventId: string) {
    const evt =
      rawBody && this.gateway.webhooksEnabled && eventId
        ? this.gateway.parseWebhook(rawBody, signature, eventId)
        : null;
    if (!evt) {
      throw new UnauthorizedException({ code: 'WEBHOOK_REJECTED', message: 'Webhook rejected.' });
    }
    await this.db.run({ platform: true }, async (db) => {
      const fresh = await db.one(
        `INSERT INTO payment_webhook_events (gateway, event_id, event_type) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING RETURNING event_id`,
        [this.gateway.name, evt.eventId.slice(0, 100), evt.eventType.slice(0, 60)],
      );
      if (!fresh || evt.outcome === 'other' || !evt.orderId) return;
      const inv = await db.one<InvoiceRow>(
        `SELECT * FROM subscription_invoices WHERE gateway = $1 AND gateway_order_id = $2 FOR UPDATE`,
        [this.gateway.name, evt.orderId],
      );
      if (!inv || inv.status !== 'pending') return; // unknown, or already confirmed by checkout
      if (evt.outcome === 'failed') {
        await this.lifecycle.recordPaymentFailure(db, inv.id, evt.failureReason);
        return;
      }
      if (
        evt.amountMinor !== Number(inv.amount_minor) ||
        evt.currency?.toUpperCase() !== inv.currency_code.trim().toUpperCase()
      ) {
        this.logger.warn(`Webhook for invoice ${inv.id} ignored: amount or currency mismatch`);
        return;
      }
      await this.lifecycle.applyPaidInvoice(db, inv.id, {
        method: 'online',
        reference: evt.paymentId ?? evt.orderId,
        gateway: this.gateway.name,
        gatewayPaymentId: evt.paymentId,
      });
    });
  }

  cancelPending(auth: AuthContext, invoiceId: string, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      if (!canManage(access)) throw forbidden();
      const r = await db.one<{ id: string }>(
        `UPDATE subscription_invoices SET status = 'cancelled', cancelled_at = now()
          WHERE id = $1 AND status = 'pending' RETURNING id`,
        [invoiceId],
      );
      if (!r)
        throw new BadRequestException({
          code: 'NOT_PENDING',
          message: 'This invoice is not awaiting payment.',
        });
      await this.lifecycle.clearPendingPayment(db, auth.tenantId!, invoiceId);
      await this.audit(db, auth, meta, 'subscription.request_cancelled', invoiceId, {});
    });
  }

  invoices(auth: AuthContext, query: InvoicesQuery) {
    return this.run(auth, async (db, access) => {
      this.requireView(access);
      const where = ['tenant_id = $1'];
      const params: unknown[] = [auth.tenantId];
      if (query.status) {
        params.push(query.status);
        where.push(`status = $${params.length}`);
      }
      if (query.from) {
        params.push(query.from);
        where.push(`created_at::date >= $${params.length}::date`);
      }
      if (query.to) {
        params.push(query.to);
        where.push(`created_at::date <= $${params.length}::date`);
      }
      if (query.search) {
        params.push(`%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        where.push(`(invoice_number ILIKE $${params.length} OR plan_name ILIKE $${params.length})`);
      }
      return runPaged<InvoiceRow, ReturnType<typeof invoiceDto>>(db, {
        select: '*',
        from: 'subscription_invoices',
        where,
        params,
        sortColumns: { createdAt: 'created_at', amountMinor: 'amount_minor' },
        tiebreak: 'id',
        query,
        map: invoiceDto,
      });
    });
  }

  /**
   * Prices the request on the server and picks the invoice kind from the current subscription.
   * A same-plan, same-cycle renewal keeps the price the customer agreed to (the snapshot); new
   * purchases, upgrades, downgrades and cycle changes use the plan's current price.
   */
  private async createInvoice(
    db: Db,
    auth: AuthContext,
    input: RequestChangeInput,
    meta: RequestMeta,
  ): Promise<InvoiceRow> {
    const sub = await this.lifecycle.load(db, auth.tenantId!, true);
    const snap = sub.plan_snapshot;
    const renewing = snap?.planId === input.planId && snap.billingCycle === input.billingCycle;
    // Subscribers may renew their plan on the agreed terms even after it is no longer offered.
    const plan = await db.one<PlanRow>(
      renewing
        ? 'SELECT * FROM plans WHERE id = $1'
        : `SELECT * FROM plans WHERE id = $1 AND ${OFFERED_SQL}`,
      [input.planId],
    );
    if (!plan)
      throw new NotFoundException({
        code: 'PLAN_NOT_FOUND',
        message: 'That plan is not available.',
      });
    if (plan.custom_pricing && !renewing) {
      throw new BadRequestException({
        code: 'PLAN_CUSTOM_PRICING',
        message: 'This plan is priced individually. Contact FoodStack sales to subscribe.',
      });
    }
    const listPrice = (p: PlanRow, cycle: string) =>
      Number(cycle === 'yearly' ? p.price_yearly_minor : p.price_monthly_minor);
    let kind: 'new' | 'renewal' | 'upgrade' | 'downgrade' | 'cycle_change' = 'new';
    if (snap) {
      if (snap.planId === plan.id) kind = renewing ? 'renewal' : 'cycle_change';
      else {
        const currentMonthly =
          snap.billingCycle === 'monthly' ? snap.priceMinor : snap.priceMinor / 12;
        kind = listPrice(plan, 'monthly') >= currentMonthly ? 'upgrade' : 'downgrade';
      }
    }
    if (kind === 'downgrade' || kind === 'new') await this.assertFits(db, plan);
    const amount = renewing ? snap!.priceMinor : listPrice(plan, input.billingCycle);
    const currency = renewing ? snap!.currencyCode : plan.currency_code.trim();
    try {
      const row = await db.one<InvoiceRow>(
        `INSERT INTO subscription_invoices (tenant_id, plan_id, plan_name, billing_cycle, kind, amount_minor,
                                            currency_code, requested_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          auth.tenantId,
          plan.id,
          renewing ? snap!.name : plan.name,
          input.billingCycle,
          kind,
          amount,
          currency,
          auth.userId,
        ],
      );
      await this.audit(db, auth, meta, 'subscription.requested', row!.id, {
        plan: plan.code,
        cycle: input.billingCycle,
        kind,
        amount,
      });
      return row!;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new ConflictException({
          code: 'PENDING_INVOICE_EXISTS',
          message:
            'You already have a request awaiting payment. Cancel it first to choose a different plan.',
        });
      }
      throw e;
    }
  }

  /** Refuses a plan whose limits are below what the restaurant already uses. */
  private async assertFits(db: Db, plan: PlanRow) {
    const used = await this.lifecycle.usage(db);
    const over: string[] = [];
    if (plan.max_branches !== null && used.branches > plan.max_branches)
      over.push(`${used.branches} active branches (plan allows ${plan.max_branches})`);
    if (plan.max_staff !== null && used.staff > plan.max_staff)
      over.push(`${used.staff} team members (plan allows ${plan.max_staff})`);
    if (plan.max_menu_items !== null && used.menuItems > plan.max_menu_items)
      over.push(`${used.menuItems} menu items (plan allows ${plan.max_menu_items})`);
    if (over.length) {
      throw new BadRequestException({
        code: 'PLAN_LIMITS_EXCEEDED',
        message: `${plan.name} is too small for your current usage: ${over.join(', ')}. Reduce usage or choose a larger plan.`,
      });
    }
  }

  private run<T>(auth: AuthContext, work: (db: Db, access: TenantAccess) => Promise<T>) {
    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, async (db) =>
      work(db, await this.access.tenantAccess(db, auth.membershipId!)),
    );
  }

  /** Checks the caller's tenant role, then returns the transaction to the platform scope. */
  private async assertCanManage(db: Db, auth: AuthContext) {
    await db.setScope({ tenantId: auth.tenantId, userId: auth.userId });
    const access = await this.access.tenantAccess(db, auth.membershipId!);
    await db.setScope({ platform: true, tenantId: auth.tenantId, userId: auth.userId });
    if (!canManage(access)) throw forbidden();
  }

  private requireView(access: TenantAccess) {
    if (!access.tenant.includes('restaurant:read')) {
      throw new ForbiddenException({
        code: 'BILLING_FORBIDDEN',
        message: 'You cannot view the subscription.',
      });
    }
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
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      actorSessionId: auth.sessionId,
      actorAudience: 'tenant',
      entityType: 'subscription_invoice',
      entityId: id,
      metadata: metadata as Record<string, unknown>,
      ...meta,
    });
  }
}

/** Business-wide restaurant managers (owner, restaurant admin). */
function canManage(access: TenantAccess) {
  return access.tenant.includes('restaurant:manage');
}
