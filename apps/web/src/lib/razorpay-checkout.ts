'use client';

/**
 * Razorpay Standard Checkout in the browser. The page only collects the gateway's result and
 * hands it to the server, which verifies the signature AND re-reads the payment from Razorpay
 * before anything is marked paid; nothing here is trusted as proof of payment.
 */

const SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';

interface RazorpayOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  prefill?: { contact?: string };
  handler: (r: {
    razorpay_payment_id: string;
    razorpay_order_id: string;
    razorpay_signature: string;
  }) => void;
  modal?: { ondismiss?: () => void };
  theme?: { color?: string };
}
type RazorpayCtor = new (o: RazorpayOptions) => {
  open: () => void;
  on: (event: 'payment.failed', fn: (r: { error?: { description?: string } }) => void) => void;
};
/** Typed locally: the subscription billing screen declares its own window.Razorpay. */
const razorpay = () => (window as unknown as { Razorpay?: RazorpayCtor }).Razorpay;

let loading: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (typeof window !== 'undefined' && razorpay()) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error('Could not load the payment window. Check your connection and try again.'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export interface CheckoutStart {
  intentId: string;
  keyId: string;
  gatewayOrderId: string;
  amountMinor: number;
  currency: string;
  name: string;
  orderNumber: string;
}

export type CheckoutResult =
  | { kind: 'paid'; paymentId: string; signature: string }
  | { kind: 'dismissed' }
  | { kind: 'failed'; reason: string };

/** Opens the payment window; resolves once the guest pays, closes it or the payment fails. */
export async function openCheckout(
  start: CheckoutStart,
  phone?: string | null,
): Promise<CheckoutResult> {
  await loadScript();
  return new Promise<CheckoutResult>((resolve) => {
    const Rzp = razorpay()!;
    const rzp = new Rzp({
      key: start.keyId,
      order_id: start.gatewayOrderId,
      amount: start.amountMinor,
      currency: start.currency,
      name: start.name,
      description: `Order #${start.orderNumber}`,
      prefill: phone ? { contact: phone } : undefined,
      theme: { color: '#059669' },
      handler: (r) =>
        resolve({
          kind: 'paid',
          paymentId: r.razorpay_payment_id,
          signature: r.razorpay_signature,
        }),
      modal: { ondismiss: () => resolve({ kind: 'dismissed' }) },
    });
    rzp.on('payment.failed', (r) =>
      resolve({ kind: 'failed', reason: r.error?.description ?? 'Payment failed' }),
    );
    rzp.open();
  });
}
