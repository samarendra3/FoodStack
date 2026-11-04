import { type Invoice, KIND_LABEL, METHOD_LABEL, money } from '@/lib/billing';

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const day = (d: string | null) =>
  d ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(new Date(d)) : '—';

/**
 * Opens a printable invoice (the browser's "Save as PDF" downloads it). Built only from the
 * server's invoice record; every value is HTML-escaped.
 */
export function printInvoice(inv: Invoice, restaurant: string) {
  const w = window.open('', '_blank', 'noopener=no,width=800,height=900');
  if (!w) return false;
  const rows: [string, string][] = [
    ['Invoice number', inv.invoiceNumber],
    ['Billed to', restaurant],
    ['Invoice date', day(inv.createdAt)],
    ['Status', inv.status === 'paid' ? `Paid on ${day(inv.paidAt)}` : inv.status],
    ['Plan', `${inv.planName} (${inv.billingCycle})`],
    ['Type', KIND_LABEL[inv.kind]],
    ['Service period', inv.periodStart ? `${day(inv.periodStart)} – ${day(inv.periodEnd)}` : '—'],
    [
      'Payment',
      inv.paymentMethod
        ? `${METHOD_LABEL[inv.paymentMethod] ?? inv.paymentMethod}${inv.paymentReference ? ` · ${inv.paymentReference}` : ''}`
        : '—',
    ],
  ];
  w.document
    .write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(inv.invoiceNumber)}</title>
<style>
  body{font-family:system-ui,sans-serif;color:#0f172a;margin:48px;max-width:680px}
  h1{font-size:22px;margin:0 0 4px} .muted{color:#64748b;font-size:13px}
  table{width:100%;border-collapse:collapse;margin:28px 0;font-size:14px}
  td{padding:8px 0;border-bottom:1px solid #e2e8f0} td:first-child{color:#64748b;width:40%}
  .total{display:flex;justify-content:space-between;font-size:18px;font-weight:700;border-top:2px solid #0f172a;padding-top:12px}
  @media print{body{margin:24px}}
</style></head><body>
<h1>FoodStack</h1><p class="muted">Subscription invoice</p>
<table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
<div class="total"><span>Total</span><span>${esc(money(inv.amountMinor, inv.currencyCode))}</span></div>
<p class="muted" style="margin-top:32px">Amounts exclude GST unless stated. Generated from your FoodStack billing history.</p>
<script>window.onload=()=>window.print()</script>
</body></html>`);
  w.document.close();
  return true;
}
