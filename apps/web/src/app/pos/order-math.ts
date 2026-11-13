import type { PosItem } from './catalog';

export const GST_RATE = 0.05;

export const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
});

export interface OrderLine {
  /** Cart key: item id, plus the portion id when the item has portions. */
  key: string;
  item: PosItem;
  variant: { id: string; name: string; price: number } | null;
  /** Chosen add-ons, prices in major units. */
  addons: { id: string; name: string; price: number }[];
  /** Per-item instruction for the kitchen. */
  note: string;
  qty: number;
}

export const lineKey = (itemId: string, variantId?: string | null) =>
  variantId ? `${itemId}:${variantId}` : itemId;
export const unitPrice = (l: OrderLine) =>
  (l.variant?.price ?? l.item.price) + l.addons.reduce((s, a) => s + a.price, 0);

/**
 * Display totals. `discountMinor` comes from the server quote (never computed here); GST is shown
 * on the discounted amount until the tax module provides real rates.
 */
export function orderTotals(lines: OrderLine[], discountMinor: number) {
  const subtotal = lines.reduce((n, l) => n + l.qty * unitPrice(l), 0);
  const discount = Math.min(discountMinor / 100, subtotal);
  const gst = (subtotal - discount) * GST_RATE;
  return { subtotal, discount, gst, total: subtotal - discount + gst };
}
