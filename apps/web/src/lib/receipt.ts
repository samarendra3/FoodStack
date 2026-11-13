'use client';

import { useQuery } from '@tanstack/react-query';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import type { Order, PaymentMethod } from './orders';

/** GET /branches/:id/receipt-header — what the bill prints at the top. */
export interface ReceiptHeader {
  branchName: string;
  name: string;
  legalName: string | null;
  logoUrl: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  gstin: string | null;
  countryCode: string;
}

export function useReceiptHeader(branchId: string | undefined) {
  const { client } = useAuth();
  const profile = useProfile();
  return useQuery({
    queryKey: ['receipt-header', profile.activeTenant?.id, branchId],
    queryFn: () => client.request<ReceiptHeader | null>(`/branches/${branchId}/receipt-header`),
    enabled: Boolean(branchId),
    staleTime: 10 * 60_000,
  });
}

export interface ReceiptInput {
  header: ReceiptHeader | null;
  /** Fallback when the header could not be loaded. */
  fallbackName: string;
  orders: Order[];
  /** e.g. "T3 · Bill A" or null for counter orders. */
  tableText: string | null;
  cashier: string;
  /** Set once paid; without it the slip is a pre-bill ("not paid"). */
  payment?: { method: PaymentMethod; amountMinor: number; tenderedMinor: number | null } | null;
}

const money = (minor: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(minor / 100);
const num = (minor: number) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    minor / 100,
  );
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const METHOD: Record<PaymentMethod, string> = { cash: 'Cash', card: 'Card', upi: 'UPI' };

/** Restaurant bill / tax invoice, 80 mm thermal layout. */
export function receiptHtml(r: ReceiptInput): string {
  const h = r.header;
  const lines = new Map<string, { name: string; qty: number; rate: number; amount: number }>();
  for (const o of r.orders) {
    for (const i of o.items) {
      if (i.status !== 'active') continue;
      const base = i.variantName ? `${i.name} (${i.variantName})` : i.name;
      const name = i.addons?.length ? `${base} + ${i.addons.map((a) => a.name).join(', ')}` : base;
      const key = `${name}|${i.unitPriceMinor}`;
      const l = lines.get(key) ?? { name, qty: 0, rate: i.unitPriceMinor, amount: 0 };
      l.qty += i.quantity;
      l.amount += i.lineTotalMinor;
      lines.set(key, l);
    }
  }
  const sum = (f: (o: Order) => number) => r.orders.reduce((s, o) => s + f(o), 0);
  const subtotal = sum((o) => o.subtotalMinor);
  const discount = sum((o) => o.discountMinor);
  const tax = sum((o) => o.taxMinor);
  const total = sum((o) => o.totalMinor);
  const rateBp = r.orders[0]?.taxRateBp ?? 0;
  // Indian GST on restaurant bills is shown as equal CGST + SGST halves.
  const gstSplit = (h?.countryCode ?? 'IN') === 'IN';
  const half = Math.floor(tax / 2);
  const paid = Boolean(r.payment);
  const qtyTotal = [...lines.values()].reduce((n, l) => n + l.qty, 0);
  const billNo = r.orders.map((o) => o.orderNumber).join(', ');
  const when = new Date().toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const row = (k: string, v: string, cls = '') =>
    `<tr class="${cls}"><td>${k}</td><td class="r">${v}</td></tr>`;
  const change =
    r.payment?.method === 'cash' && r.payment.tenderedMinor
      ? r.payment.tenderedMinor - r.payment.amountMinor
      : null;

  return `<!doctype html><html><head><meta charset="utf-8"><title>Bill ${esc(billNo)}</title>
<style>
  *{box-sizing:border-box}
  body{font:12px/1.4 ui-monospace,'SF Mono',Menlo,Consolas,monospace;margin:0;padding:10px 12px;width:80mm;color:#000}
  .c{text-align:center} .r{text-align:right;white-space:nowrap} .m{font-size:11px}
  h1{font-size:17px;margin:4px 0 2px;letter-spacing:.3px} img{max-height:48px;max-width:60%}
  .tag{display:inline-block;border:1px solid #000;padding:1px 8px;margin:6px 0 2px;font-weight:700;letter-spacing:1px}
  hr{border:0;border-top:1px dashed #000;margin:6px 0}
  table{width:100%;border-collapse:collapse} td,th{padding:1.5px 0;vertical-align:top}
  th{font-weight:700;text-align:left;border-bottom:1px dashed #000;padding-bottom:3px}
  .items td:nth-child(2),.items td:nth-child(3),.items th:nth-child(2),.items th:nth-child(3){text-align:right;padding-left:6px;white-space:nowrap}
  .items td:last-child,.items th:last-child{text-align:right;padding-left:6px;white-space:nowrap}
  .grand td{font-size:15px;font-weight:700;padding-top:4px;border-top:1px solid #000}
  .meta td{padding:0} .b{font-weight:700}
  @page{size:80mm auto;margin:0}
</style></head><body>
<div class="c">
  ${h?.logoUrl ? `<img src="${esc(h.logoUrl)}" alt=""><br>` : ''}
  <h1>${esc(h?.name ?? r.fallbackName)}</h1>
  ${h?.legalName && h.legalName !== h.name ? `<div class="m">${esc(h.legalName)}</div>` : ''}
  ${h?.branchName ? `<div class="m">${esc(h.branchName)}</div>` : ''}
  ${h?.address ? `<div class="m">${esc(h.address)}</div>` : ''}
  ${h?.phone ? `<div class="m">Ph: ${esc(h.phone)}</div>` : ''}
  ${h?.gstin ? `<div class="m">GSTIN: ${esc(h.gstin)}</div>` : ''}
  <div class="tag">${paid ? (h?.gstin ? 'TAX INVOICE' : 'BILL') : 'BILL – NOT PAID'}</div>
</div>
<hr>
<table class="meta m">
  ${row(`Bill No: <span class="b">${esc(billNo)}</span>`, esc(when))}
  ${row(r.tableText ? `Table: <span class="b">${esc(r.tableText)}</span>` : 'Counter', `Cashier: ${esc(r.cashier)}`)}
</table>
<hr>
<table class="items">
  <tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amt</th></tr>
  ${[...lines.values()]
    .map(
      (l) =>
        `<tr><td>${esc(l.name)}</td><td>${l.qty}</td><td>${num(l.rate)}</td><td>${num(l.amount)}</td></tr>`,
    )
    .join('')}
</table>
<hr>
<table>
  ${row(`Sub Total <span class="m">(${qtyTotal} item${qtyTotal === 1 ? '' : 's'})</span>`, num(subtotal))}
  ${discount ? row('Discount', `-${num(discount)}`) : ''}
  ${
    tax
      ? gstSplit
        ? row(`CGST @ ${rateBp / 200}%`, num(half)) +
          row(`SGST @ ${rateBp / 200}%`, num(tax - half))
        : row(`Tax @ ${rateBp / 100}%`, num(tax))
      : ''
  }
  ${row('GRAND TOTAL', money(total), 'grand')}
</table>
${
  r.payment
    ? `<hr><table class="m">
  ${row(`Paid by ${METHOD[r.payment.method]}`, money(r.payment.amountMinor))}
  ${r.payment.tenderedMinor ? row('Cash received', money(r.payment.tenderedMinor)) : ''}
  ${change && change > 0 ? row('Change returned', money(change), 'b') : ''}
</table>`
    : `<hr><div class="c m">Please pay at the counter.</div>`
}
<hr>
<div class="c">
  <div class="b">Thank you! Visit again.</div>
  ${h?.email ? `<div class="m">${esc(h.email)}</div>` : ''}
  <div class="m" style="margin-top:4px">Powered by FoodStack</div>
</div>
</body></html>`;
}

/**
 * Prints through a hidden iframe: no pop-up window, so it also works right after an async
 * payment (browsers block window.open outside a click).
 */
export function printReceipt(r: ReceiptInput) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText =
    'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(receiptHtml(r));
  doc.close();
  const go = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 1000);
  };
  // Wait for the logo (if any) so it is on the print.
  const img = doc.querySelector('img');
  if (img && !img.complete) {
    img.addEventListener('load', go, { once: true });
    img.addEventListener('error', go, { once: true });
  } else {
    setTimeout(go, 50);
  }
}
