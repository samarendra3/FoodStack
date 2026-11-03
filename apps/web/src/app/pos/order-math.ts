import type { PosItem } from './catalog';

export const GST_RATE = 0.05;

export const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
});

export interface OrderLine {
  item: PosItem;
  qty: number;
}

/**
 * Display totals. `discountMinor` comes from the server quote (never computed here); GST is shown
 * on the discounted amount until the tax module provides real rates.
 */
export function orderTotals(lines: OrderLine[], discountMinor: number) {
  const subtotal = lines.reduce((n, l) => n + l.qty * l.item.price, 0);
  const discount = Math.min(discountMinor / 100, subtotal);
  const gst = (subtotal - discount) * GST_RATE;
  return { subtotal, discount, gst, total: subtotal - discount + gst };
}
