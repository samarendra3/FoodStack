import type { AppConfigService } from '../../config/app-config.service';
import { hmacHex, RazorpayGateway, safeEqualHex } from './payment-gateway';

const config = (env: Record<string, string | undefined>) =>
  ({ get: (k: string) => env[k] }) as unknown as AppConfigService;

describe('RazorpayGateway', () => {
  const gw = new RazorpayGateway(
    config({
      RAZORPAY_KEY_ID: 'rzp_test_key',
      RAZORPAY_KEY_SECRET: 'key-secret',
      RAZORPAY_WEBHOOK_SECRET: 'hook-secret',
    }),
  );

  it('is disabled without keys and never exposes the secret', () => {
    const off = new RazorpayGateway(config({}));
    expect(off.enabled).toBe(false);
    expect(off.publicKey).toBeNull();
    expect(off.verifyCheckout('order_1', 'pay_1', 'a'.repeat(64))).toBe(false);
    expect(gw.publicKey).toBe('rzp_test_key');
  });

  it('accepts only the HMAC of order|payment under the key secret', () => {
    const sig = hmacHex('key-secret', 'order_1|pay_1');
    expect(gw.verifyCheckout('order_1', 'pay_1', sig)).toBe(true);
    expect(gw.verifyCheckout('order_1', 'pay_2', sig)).toBe(false);
    expect(gw.verifyCheckout('order_1', 'pay_1', hmacHex('wrong', 'order_1|pay_1'))).toBe(false);
    expect(gw.verifyCheckout('order_1', 'pay_1', 'not-hex')).toBe(false);
  });

  it('verifies webhook signatures over the raw body and maps outcomes', () => {
    const body = Buffer.from(
      JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: { entity: { id: 'pay_9', order_id: 'order_9', amount: 99900, currency: 'INR' } },
        },
      }),
    );
    expect(gw.parseWebhook(body, hmacHex('other', body), 'evt_1')).toBeNull();
    expect(gw.parseWebhook(body, hmacHex('hook-secret', body), 'evt_1')).toMatchObject({
      outcome: 'captured',
      orderId: 'order_9',
      paymentId: 'pay_9',
      amountMinor: 99900,
      currency: 'INR',
    });
  });

  it('compares signatures safely regardless of length', () => {
    expect(safeEqualHex('abcd', 'abcd')).toBe(true);
    expect(safeEqualHex('abcd', 'abc')).toBe(false);
  });
});
