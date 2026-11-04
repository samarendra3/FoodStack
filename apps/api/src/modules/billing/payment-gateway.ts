import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';

/** DI token: tests replace the gateway; production uses Razorpay. */
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

export interface GatewayOrder {
  orderId: string;
}

export interface WebhookPayment {
  eventId: string;
  eventType: string;
  orderId: string | null;
  paymentId: string | null;
  amountMinor: number | null;
  currency: string | null;
  /** captured: money received; failed: attempt failed; other: ignored. */
  outcome: 'captured' | 'failed' | 'other';
  failureReason: string | null;
}

export interface PaymentGateway {
  readonly name: 'razorpay';
  /** False when keys are not configured; owners then pay offline (manual verification). */
  readonly enabled: boolean;
  /** Publishable key for the browser checkout; never the secret. */
  readonly publicKey: string | null;
  readonly webhooksEnabled: boolean;
  createOrder(input: {
    amountMinor: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<GatewayOrder>;
  /** Checks the signature the checkout returns for (orderId, paymentId). */
  verifyCheckout(orderId: string, paymentId: string, signature: string): boolean;
  /** Verifies and parses a webhook; returns null when the signature is wrong. */
  parseWebhook(rawBody: Buffer, signature: string, eventId: string): WebhookPayment | null;
}

export function hmacHex(secret: string, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/** Constant-time comparison of two hex signatures. */
export function safeEqualHex(expected: string, given: string): boolean {
  if (!/^[0-9a-f]+$/i.test(given) || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(given, 'hex'));
}

@Injectable()
export class RazorpayGateway implements PaymentGateway {
  readonly name = 'razorpay' as const;
  private readonly keyId: string | undefined;
  private readonly keySecret: string | undefined;
  private readonly webhookSecret: string | undefined;

  constructor(config: AppConfigService) {
    this.keyId = config.get('RAZORPAY_KEY_ID');
    this.keySecret = config.get('RAZORPAY_KEY_SECRET');
    this.webhookSecret = config.get('RAZORPAY_WEBHOOK_SECRET');
  }

  get enabled() {
    return Boolean(this.keyId && this.keySecret);
  }
  get publicKey() {
    return this.enabled ? this.keyId! : null;
  }
  get webhooksEnabled() {
    return Boolean(this.webhookSecret);
  }

  async createOrder(input: {
    amountMinor: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<GatewayOrder> {
    if (!this.enabled) throw unavailable();
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: input.amountMinor,
        currency: input.currency,
        receipt: input.receipt.slice(0, 40),
        notes: input.notes,
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { id?: string } | null;
    if (!res?.ok || !body?.id) throw unavailable();
    return { orderId: body.id };
  }

  verifyCheckout(orderId: string, paymentId: string, signature: string): boolean {
    if (!this.keySecret) return false;
    return safeEqualHex(hmacHex(this.keySecret, `${orderId}|${paymentId}`), signature);
  }

  parseWebhook(rawBody: Buffer, signature: string, eventId: string): WebhookPayment | null {
    if (!this.webhookSecret || !safeEqualHex(hmacHex(this.webhookSecret, rawBody), signature)) {
      return null;
    }
    const event = JSON.parse(rawBody.toString('utf8')) as {
      event?: string;
      payload?: {
        payment?: {
          entity?: {
            id?: string;
            order_id?: string;
            amount?: number;
            currency?: string;
            error_description?: string;
          };
        };
      };
    };
    const p = event.payload?.payment?.entity;
    const type = event.event ?? 'unknown';
    return {
      eventId,
      eventType: type,
      orderId: p?.order_id ?? null,
      paymentId: p?.id ?? null,
      amountMinor: typeof p?.amount === 'number' ? p.amount : null,
      currency: p?.currency ?? null,
      outcome:
        type === 'payment.captured' || type === 'order.paid'
          ? 'captured'
          : type === 'payment.failed'
            ? 'failed'
            : 'other',
      failureReason: p?.error_description?.slice(0, 300) ?? null,
    };
  }
}

function unavailable() {
  return new ServiceUnavailableException({
    code: 'PAYMENTS_UNAVAILABLE',
    message: 'Online payment is not available right now. Please try again shortly.',
  });
}
