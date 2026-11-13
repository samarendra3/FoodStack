import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal Razorpay REST client for a RESTAURANT's own account (key id / secret entered by the
 * restaurant). Only what customer payments need: create an order, fetch / capture a payment,
 * refund, and signature checks. No SDK dependency; the base URL is configurable so tests run
 * against a local fake gateway that signs exactly like Razorpay.
 */

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
}

export interface RazorpayPayment {
  id: string;
  order_id: string | null;
  amount: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  method?: string;
  error_description?: string | null;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export class RazorpayClient {
  constructor(
    private readonly base: string,
    private readonly creds: RazorpayCredentials,
  ) {}

  createOrder(input: {
    amountMinor: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }) {
    return this.call<{ id: string; amount: number; currency: string; status: string }>(
      'POST',
      '/v1/orders',
      {
        amount: input.amountMinor,
        currency: input.currency,
        receipt: input.receipt.slice(0, 40),
        notes: input.notes,
      },
    );
  }

  fetchPayment(paymentId: string) {
    return this.call<RazorpayPayment>('GET', `/v1/payments/${encodeURIComponent(paymentId)}`);
  }

  capture(paymentId: string, amountMinor: number, currency: string) {
    return this.call<RazorpayPayment>(
      'POST',
      `/v1/payments/${encodeURIComponent(paymentId)}/capture`,
      { amount: amountMinor, currency },
    );
  }

  refund(paymentId: string, amountMinor: number, notes: Record<string, string>) {
    return this.call<{ id: string; amount: number; status: string }>(
      'POST',
      `/v1/payments/${encodeURIComponent(paymentId)}/refund`,
      { amount: amountMinor, notes },
    );
  }

  /** Cheap authenticated call used to check that entered keys work. */
  async verifyCredentials(): Promise<void> {
    await this.call('GET', '/v1/orders?count=1');
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const auth = Buffer.from(`${this.creds.keyId}:${this.creds.keySecret}`).toString('base64');
    let res: Response;
    try {
      res = await fetch(`${this.base.replace(/\/+$/, '')}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new GatewayError(`Payment gateway unreachable: ${(e as Error).message}`, 503);
    }
    const data = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; description?: string };
    };
    if (!res.ok) {
      throw new GatewayError(
        data.error?.description ?? `Payment gateway error (${res.status})`,
        res.status,
        data.error?.code,
      );
    }
    return data as T;
  }
}

const hmac = (secret: string, data: string | Buffer) =>
  createHmac('sha256', secret).update(data).digest('hex');

/** Constant-time hex comparison. */
export function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

/** Checkout success handler signature: HMAC(order_id + "|" + payment_id, key secret). */
export function checkoutSignatureValid(
  keySecret: string,
  gatewayOrderId: string,
  paymentId: string,
  signature: string,
): boolean {
  return (
    /^[0-9a-f]+$/i.test(signature) &&
    sameHex(hmac(keySecret, `${gatewayOrderId}|${paymentId}`), signature)
  );
}

/** Webhook signature: HMAC(raw body, webhook secret) in X-Razorpay-Signature. */
export function webhookSignatureValid(webhookSecret: string, rawBody: Buffer, signature: string) {
  return /^[0-9a-f]+$/i.test(signature) && sameHex(hmac(webhookSecret, rawBody), signature);
}

/** rzp_test_… / rzp_live_… */
export function keyMode(keyId: string): 'test' | 'live' | null {
  if (/^rzp_test_[A-Za-z0-9]{6,40}$/.test(keyId)) return 'test';
  if (/^rzp_live_[A-Za-z0-9]{6,40}$/.test(keyId)) return 'live';
  return null;
}
