import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { AppConfigService } from '../../config/app-config.service';
import { decryptSecret, encryptSecret } from '../../core/security/crypto';
import { type Db, DbContext } from '../../core/db/db-context';
import { hasPermission } from '../auth/access';
import { AccessService } from '../auth/access.service';
import type { AuthContext, RequestMeta, TenantAccess } from '../auth/auth.types';
import { writeAudit } from '../auth/user-tokens';
import { OrderEventsService } from './order-events';
import { type OrderRow, OrdersService } from './orders.service';
import {
  checkoutSignatureValid,
  GatewayError,
  keyMode,
  RazorpayClient,
  type RazorpayPayment,
  webhookSignatureValid,
} from './razorpay-client';

const PROVIDER = 'razorpay';
const INTENT_TTL_MIN = 15;

interface AccountRow {
  id: string;
  tenant_id: string;
  restaurant_id: string;
  key_id: string;
  key_secret_enc: Buffer;
  webhook_secret_enc: Buffer;
  webhook_key: string;
  mode: 'test' | 'live';
  enabled: boolean;
  verified_at: Date | null;
  last_webhook_at: Date | null;
}
interface IntentRow {
  id: string;
  tenant_id: string;
  order_id: string;
  branch_id: string;
  account_id: string;
  gateway_order_id: string;
  amount_minor: string;
  currency_code: string;
  status: 'created' | 'paid' | 'failed' | 'expired' | 'cancelled' | 'needs_review';
  gateway_payment_id: string | null;
}

const disabled = () =>
  new ConflictException({
    code: 'ONLINE_PAYMENTS_DISABLED',
    message: 'Online payment is not available. Please pay at the counter.',
  });
const conflict = (code: string, message: string) => new ConflictException({ code, message });

/**
 * Customer online payments into the restaurant's OWN Razorpay account.
 *
 * Money is recorded only from the gateway's own record of the payment (fetched with the
 * restaurant's keys, or a signed webhook) — never from what a browser reports. Amounts come
 * from the server's bill; the gateway amount and currency must match the intent. Every captured
 * payment id can be recorded once (unique index), every webhook event id is processed once.
 */
@Injectable()
export class OnlinePaymentsService implements OnModuleInit {
  private readonly logger = new Logger(OnlinePaymentsService.name);
  private key: Buffer | null = null;

  constructor(
    private readonly db: DbContext,
    private readonly access: AccessService,
    private readonly config: AppConfigService,
    private readonly orders: OrdersService,
    private readonly events: OrderEventsService,
  ) {}

  onModuleInit() {
    const base = this.config.get('MFA_ENCRYPTION_KEY');
    // A key of its own for payment credentials (HKDF from the platform secret), so a leak of
    // one purpose's ciphertext never helps with another's.
    if (base) {
      this.key = Buffer.from(
        hkdfSync(
          'sha256',
          Buffer.from(base, 'base64'),
          Buffer.alloc(0),
          'foodstack:payment-credentials:v1',
          32,
        ),
      );
    }
    // Refunds of online payments go back through the restaurant's gateway.
    this.orders.onlineRefund = (db, payment, amountMinor, reason) =>
      this.gatewayRefund(db, payment, amountMinor, reason);
  }

  get enabled() {
    return this.config.get('ONLINE_PAYMENTS_ENABLED');
  }

  // ---------------------------------------------------------------- account (restaurant settings)

  getAccount(auth: AuthContext, restaurantId: string) {
    return this.run(auth, async (db, access) => {
      this.requireManage(access, restaurantId);
      const a = await this.accountFor(db, restaurantId);
      return { enabled: this.enabled, account: a ? this.publicAccount(a) : null };
    });
  }

  connect(
    auth: AuthContext,
    input: { restaurantId: string; keyId: string; keySecret: string; webhookSecret: string },
    meta: RequestMeta,
  ) {
    if (!this.enabled) throw disabled();
    const mode = keyMode(input.keyId);
    if (!mode) {
      throw new BadRequestException({
        code: 'INVALID_KEY_ID',
        message: 'Enter a Razorpay key id (rzp_test_… or rzp_live_…).',
      });
    }
    return this.run(auth, async (db, access) => {
      this.requireManage(access, input.restaurantId);
      // Prove the keys work before storing them.
      try {
        await this.client(input.keyId, input.keySecret).verifyCredentials();
      } catch (e) {
        throw new BadRequestException({
          code: 'GATEWAY_REJECTED_KEYS',
          message: `Razorpay rejected these keys: ${(e as Error).message}`,
        });
      }
      const existing = await this.accountFor(db, input.restaurantId);
      const webhookKey = existing?.webhook_key ?? randomBytes(18).toString('base64url');
      await db.query(
        `INSERT INTO restaurant_payment_accounts
           (tenant_id, restaurant_id, provider, key_id, key_secret_enc, webhook_secret_enc,
            webhook_key, mode, enabled, verified_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, now(), $9)
         ON CONFLICT (tenant_id, restaurant_id) DO UPDATE
           SET key_id = EXCLUDED.key_id, key_secret_enc = EXCLUDED.key_secret_enc,
               webhook_secret_enc = EXCLUDED.webhook_secret_enc, mode = EXCLUDED.mode,
               enabled = true, verified_at = now()`,
        [
          auth.tenantId,
          input.restaurantId,
          PROVIDER,
          input.keyId,
          encryptSecret(input.keySecret, this.requireKey()),
          encryptSecret(input.webhookSecret, this.requireKey()),
          webhookKey,
          mode,
          auth.userId,
        ],
      );
      await this.audit(db, auth, meta, 'payments.gateway_connected', input.restaurantId, {
        provider: PROVIDER,
        keyId: input.keyId,
        mode,
      });
      return this.publicAccount((await this.accountFor(db, input.restaurantId))!);
    });
  }

  disconnect(auth: AuthContext, restaurantId: string, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      this.requireManage(access, restaurantId);
      await db.query(
        `UPDATE restaurant_payment_accounts SET enabled = false WHERE restaurant_id = $1`,
        [restaurantId],
      );
      await this.audit(db, auth, meta, 'payments.gateway_disconnected', restaurantId, {});
    });
  }

  /** Whether guests of this branch can pay online (feature on + account connected). */
  async availableFor(db: Db, branchId: string) {
    if (!this.enabled) return false;
    const r = await db.one<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM restaurant_payment_accounts a JOIN branches b ON b.restaurant_id = a.restaurant_id
                      WHERE b.id = $1 AND a.enabled) AS ok`,
      [branchId],
    );
    return Boolean(r?.ok);
  }

  // ---------------------------------------------------------------- pay

  /**
   * Starts (or restarts) an online payment for what is due on one order. Called by the guest
   * flow with the guest's own order (already authorised) inside its transaction.
   */
  async startForOrder(db: Db, orderId: string, who: { guestId?: string; userId?: string }) {
    if (!this.enabled) throw disabled();
    const order = await this.orders.lockForPayment(db, orderId);
    if (order.status !== 'open') throw conflict('ORDER_CLOSED', 'This bill is already settled.');
    const due = Number(order.total_minor) - Number(order.paid_minor);
    if (due <= 0) throw conflict('NOTHING_DUE', 'Nothing is due on this order.');
    const account = await this.accountForBranch(db, order.branch_id);
    if (!account?.enabled) throw disabled();

    // Only one live attempt per order: older ones are closed (a late capture is still recorded).
    await db.query(
      `UPDATE payment_intents SET status = 'cancelled' WHERE order_id = $1 AND status = 'created'`,
      [orderId],
    );
    const intentId = randomUUID();
    const gw = await this.clientFor(account)
      .createOrder({
        amountMinor: due,
        currency: order.currency_code.trim(),
        receipt: intentId,
        notes: { foodstack_order: orderId, foodstack_intent: intentId },
      })
      .catch((e: GatewayError) => {
        throw new ServiceUnavailableException({
          code: 'GATEWAY_UNAVAILABLE',
          message: `Online payment could not be started: ${e.message}`,
        });
      });
    if (gw.amount !== due)
      throw conflict('GATEWAY_MISMATCH', 'The gateway returned a different amount.');
    await db.query(
      `INSERT INTO payment_intents
         (id, tenant_id, order_id, branch_id, account_id, provider, gateway_order_id, amount_minor,
          currency_code, guest_id, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(mins => $12))`,
      [
        intentId,
        order.tenant_id,
        orderId,
        order.branch_id,
        account.id,
        PROVIDER,
        gw.id,
        due,
        order.currency_code.trim(),
        who.guestId ?? null,
        who.userId ?? null,
        INTENT_TTL_MIN,
      ],
    );
    const r = await db.one<{ name: string }>(
      `SELECT r.name FROM branches b JOIN restaurants r ON r.id = b.restaurant_id WHERE b.id = $1`,
      [order.branch_id],
    );
    // Everything the browser needs for Razorpay Checkout; the key SECRET never leaves the server.
    return {
      intentId,
      provider: PROVIDER,
      keyId: account.key_id,
      gatewayOrderId: gw.id,
      amountMinor: due,
      currency: order.currency_code.trim(),
      name: r?.name ?? 'Restaurant',
      orderNumber: String(order.order_number),
    };
  }

  /**
   * After Checkout reports success: check its signature, then ask the GATEWAY what really
   * happened and record that (capturing an authorised payment if needed). Idempotent.
   */
  async confirm(
    db: Db,
    input: { intentId: string; paymentId: string; signature: string },
    meta: RequestMeta,
  ) {
    if (!this.enabled) throw disabled();
    const intent = await db.one<IntentRow>(
      `SELECT * FROM payment_intents WHERE id = $1 FOR UPDATE`,
      [input.intentId],
    );
    if (!intent) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Payment not found.' });
    const account = await this.accountById(db, intent.account_id);
    const secret = this.secret(account.key_secret_enc);
    if (
      !checkoutSignatureValid(secret, intent.gateway_order_id, input.paymentId, input.signature)
    ) {
      throw new BadRequestException({
        code: 'BAD_SIGNATURE',
        message: 'Payment could not be verified.',
      });
    }
    const payment = await this.clientFor(account).fetchPayment(input.paymentId);
    return this.settle(db, account, intent, payment, meta);
  }

  /** Signed webhook from the restaurant's Razorpay account. */
  async webhook(
    webhookKey: string,
    rawBody: Buffer | undefined,
    signature: string,
    eventId: string,
    meta: RequestMeta,
  ): Promise<{ status: string }> {
    if (!this.enabled) return { status: 'disabled' };
    if (!rawBody || !/^[A-Za-z0-9_-]{16,64}$/.test(webhookKey)) throw this.badWebhook();
    // Resolve the account first (platform scope: the URL carries no tenant), then work inside
    // that tenant only.
    const account = await this.db.run({ platform: true }, (db) =>
      db.one<AccountRow>(`SELECT * FROM restaurant_payment_accounts WHERE webhook_key = $1`, [
        webhookKey,
      ]),
    );
    if (!account) throw this.badWebhook();
    if (!webhookSignatureValid(this.secret(account.webhook_secret_enc), rawBody, signature)) {
      throw this.badWebhook();
    }
    const event = JSON.parse(rawBody.toString('utf8')) as {
      event: string;
      payload?: { payment?: { entity?: RazorpayPayment } };
    };
    const id = eventId || `${event.event}:${event.payload?.payment?.entity?.id ?? 'none'}`;
    return this.db.run({ tenantId: account.tenant_id }, async (db) => {
      const fresh = await db.one<{ id: string }>(
        `INSERT INTO gateway_events (tenant_id, provider, event_id, type, result)
         VALUES ($1, $2, $3, $4, 'received') ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
        [account.tenant_id, PROVIDER, id.slice(0, 200), event.event.slice(0, 60)],
      );
      if (!fresh) return { status: 'duplicate' };
      await db.query(
        `UPDATE restaurant_payment_accounts SET last_webhook_at = now() WHERE id = $1`,
        [account.id],
      );
      const p = event.payload?.payment?.entity;
      let result = 'ignored';
      if (p?.order_id) {
        const intent = await db.one<IntentRow>(
          `SELECT * FROM payment_intents WHERE provider = $1 AND gateway_order_id = $2 FOR UPDATE`,
          [PROVIDER, p.order_id],
        );
        if (intent && (event.event === 'payment.captured' || event.event === 'order.paid')) {
          // Webhook content is signed, but the amount is still re-read from the gateway.
          const truth = await this.clientFor(account).fetchPayment(p.id);
          result = (await this.settle(db, account, intent, truth, meta)).status;
        } else if (intent && event.event === 'payment.failed' && intent.status === 'created') {
          await db.query(
            `UPDATE payment_intents SET status = 'failed', failure_reason = $2 WHERE id = $1`,
            [intent.id, (p.error_description ?? 'Payment failed').slice(0, 300)],
          );
          await this.events.record(db, {
            tenantId: intent.tenant_id,
            branchId: intent.branch_id,
            orderId: intent.order_id,
            type: 'payment.failed',
            payload: { reason: p.error_description ?? 'Payment failed', method: 'online' },
            actor: { kind: 'system' },
          });
          result = 'failed';
        }
      }
      await db.query(`UPDATE gateway_events SET result = $2 WHERE id = $1`, [fresh.id, result]);
      return { status: result };
    });
  }

  // ---------------------------------------------------------------- internals

  /**
   * Records a gateway payment once. Captures an authorised payment; refuses anything whose
   * order, amount or currency does not match; a mismatch is parked as needs_review (money was
   * taken but cannot be applied automatically — staff refund or reconcile it).
   */
  private async settle(
    db: Db,
    account: AccountRow,
    intent: IntentRow,
    payment: RazorpayPayment,
    meta: RequestMeta,
  ): Promise<{ status: 'paid' | 'already_paid' | 'pending' | 'needs_review'; orderId: string }> {
    const done = await db.one<{ id: string }>(
      `SELECT id FROM payments WHERE gateway = $1 AND gateway_payment_id = $2`,
      [PROVIDER, payment.id],
    );
    if (done) return { status: 'already_paid', orderId: intent.order_id };
    const amount = Number(intent.amount_minor);
    const matches =
      payment.order_id === intent.gateway_order_id &&
      payment.amount === amount &&
      payment.currency === intent.currency_code.trim();
    if (!matches) return this.review(db, intent, 'Gateway payment does not match the bill.');
    let p = payment;
    if (p.status === 'authorized')
      p = await this.clientFor(account).capture(p.id, amount, p.currency);
    if (p.status !== 'captured') return { status: 'pending', orderId: intent.order_id };

    const order: OrderRow = await this.orders.lockForPayment(db, intent.order_id);
    const due = Number(order.total_minor) - Number(order.paid_minor);
    if (order.status !== 'open' || due < amount) {
      return this.review(
        db,
        intent,
        'Bill changed or was paid another way after online payment began.',
      );
    }
    await this.orders.recordGatewayPayment(
      db,
      order,
      { amountMinor: amount, provider: PROVIDER, paymentId: p.id, intentId: intent.id },
      meta,
    );
    await db.query(
      `UPDATE payment_intents SET status = 'paid', gateway_payment_id = $2 WHERE id = $1`,
      [intent.id, p.id],
    );
    return { status: 'paid', orderId: intent.order_id };
  }

  private async review(db: Db, intent: IntentRow, reason: string) {
    await db.query(
      `UPDATE payment_intents SET status = 'needs_review', failure_reason = $2 WHERE id = $1`,
      [intent.id, reason],
    );
    await this.events.record(db, {
      tenantId: intent.tenant_id,
      branchId: intent.branch_id,
      orderId: intent.order_id,
      type: 'payment.failed',
      payload: { reason, method: 'online', needsReview: true },
      actor: { kind: 'system' },
    });
    this.logger.warn(`Payment intent ${intent.id} needs review: ${reason}`);
    return { status: 'needs_review' as const, orderId: intent.order_id };
  }

  /** Refund an online payment through the restaurant's gateway (called inside the refund tx). */
  private async gatewayRefund(
    db: Db,
    payment: {
      id: string;
      gateway: string | null;
      gateway_payment_id: string | null;
      payment_intent_id: string | null;
    },
    amountMinor: number,
    reason: string,
  ) {
    if (!payment.gateway_payment_id || !payment.payment_intent_id) return;
    const intent = await db.one<{ account_id: string }>(
      `SELECT account_id FROM payment_intents WHERE id = $1`,
      [payment.payment_intent_id],
    );
    const account = await this.accountById(db, intent!.account_id);
    try {
      await this.clientFor(account).refund(payment.gateway_payment_id, amountMinor, {
        reason: reason.slice(0, 200),
        foodstack_payment: payment.id,
      });
    } catch (e) {
      throw new ServiceUnavailableException({
        code: 'GATEWAY_REFUND_FAILED',
        message: `The refund was not accepted by the payment gateway: ${(e as Error).message}`,
      });
    }
  }

  private badWebhook() {
    return new BadRequestException({ code: 'BAD_WEBHOOK', message: 'Invalid webhook.' });
  }

  private publicAccount(a: AccountRow) {
    return {
      provider: PROVIDER,
      keyId: a.key_id,
      mode: a.mode,
      enabled: a.enabled,
      verifiedAt: a.verified_at ? new Date(a.verified_at).toISOString() : null,
      lastWebhookAt: a.last_webhook_at ? new Date(a.last_webhook_at).toISOString() : null,
      /** Path to configure in the Razorpay dashboard (prefix with the public API origin). */
      webhookPath: `/api/v1/public/payments/razorpay/${a.webhook_key}`,
      webhookEvents: ['payment.captured', 'payment.failed', 'order.paid'],
    };
  }

  private accountFor(db: Db, restaurantId: string) {
    return db.one<AccountRow>(
      `SELECT * FROM restaurant_payment_accounts WHERE restaurant_id = $1`,
      [restaurantId],
    );
  }

  private accountForBranch(db: Db, branchId: string) {
    return db.one<AccountRow>(
      `SELECT a.* FROM restaurant_payment_accounts a JOIN branches b ON b.restaurant_id = a.restaurant_id
        WHERE b.id = $1`,
      [branchId],
    );
  }

  private async accountById(db: Db, id: string) {
    const a = await db.one<AccountRow>(`SELECT * FROM restaurant_payment_accounts WHERE id = $1`, [
      id,
    ]);
    if (!a)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Payment account not found.' });
    return a;
  }

  private client(keyId: string, keySecret: string) {
    return new RazorpayClient(this.config.get('RAZORPAY_API_BASE'), { keyId, keySecret });
  }

  private clientFor(a: AccountRow) {
    return this.client(a.key_id, this.secret(a.key_secret_enc));
  }

  private secret(enc: Buffer) {
    return decryptSecret(enc, this.requireKey());
  }

  private requireKey() {
    if (!this.key) {
      throw new ServiceUnavailableException({
        code: 'PAYMENTS_NOT_CONFIGURED',
        message: 'Online payments are not configured on this server.',
      });
    }
    return this.key;
  }

  private requireManage(access: TenantAccess, restaurantId: string) {
    // The restaurant must be this tenant's (a tenant-wide grant alone would match any id).
    if (!access.allBranches.some((b) => b.restaurantId === restaurantId)) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Restaurant not found.' });
    }
    if (!hasPermission(access, 'restaurant:manage', { restaurantId })) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'You cannot manage payments.' });
    }
  }

  private audit(
    db: Db,
    auth: AuthContext,
    meta: RequestMeta,
    action: string,
    restaurantId: string,
    metadata: Record<string, unknown>,
  ) {
    return writeAudit(db, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      actorSessionId: auth.sessionId,
      actorAudience: 'tenant',
      action,
      entityType: 'restaurant',
      entityId: restaurantId,
      metadata,
      ...meta,
    });
  }

  private run<T>(auth: AuthContext, work: (db: Db, access: TenantAccess) => Promise<T>) {
    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, async (db) =>
      work(db, await this.access.forRequest(db, auth)),
    );
  }
}
