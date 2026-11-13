import PDFDocument from 'pdfkit';
import type { InvoiceSnapshot } from './invoices';

/**
 * Renders an issued invoice (from its frozen snapshot) as an A4 PDF. Built-in Helvetica has no
 * rupee glyph, so amounts print as "Rs. 1,234.00"; everything else follows the GST layout:
 * seller with GSTIN and address, invoice number and date, place of supply, SAC, line items,
 * taxable value, CGST / SGST split, total, and how it was paid.
 */
export function renderInvoicePdf(s: InvoiceSnapshot): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
    info: { Title: `Invoice ${s.invoiceNumber}` },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) =>
    doc.on('end', () => resolve(Buffer.concat(chunks))),
  );

  const cur = s.currencyCode === 'INR' ? 'Rs.' : s.currencyCode;
  const amt = (minor: number) =>
    `${cur} ${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100)}`;
  const when = (iso: string) =>
    new Date(iso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  const left = 40;
  const right = 555;
  const width = right - left;
  const grey = '#555555';

  // ---- header: seller ----
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#000').text(s.seller.name, left, 40);
  doc.font('Helvetica').fontSize(9).fillColor(grey);
  if (s.seller.legalName && s.seller.legalName !== s.seller.name) doc.text(s.seller.legalName);
  doc.text(s.seller.branchName);
  if (s.seller.address) doc.text(s.seller.address, { width: 300 });
  const contact = [s.seller.phone, s.seller.email].filter(Boolean).join(' · ');
  if (contact) doc.text(contact);
  if (s.seller.gstin) doc.font('Helvetica-Bold').fillColor('#000').text(`GSTIN: ${s.seller.gstin}`);

  // ---- header: invoice box ----
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#000').text(s.title, 360, 40, {
    width: 195,
    align: 'right',
  });
  doc.font('Helvetica').fontSize(9).fillColor('#000');
  const meta: [string, string][] = [
    ['Invoice no.', s.invoiceNumber],
    ['Date', when(s.issuedAt)],
    ['Order', `#${s.order.orderNumber}`],
    ...(s.order.tableLabel
      ? ([
          [
            'Table',
            `${s.order.tableLabel}${s.order.billLabel ? ` · Bill ${s.order.billLabel}` : ''}`,
          ],
        ] as [string, string][])
      : []),
    ...(s.placeOfSupply ? ([['Place of supply', s.placeOfSupply]] as [string, string][]) : []),
    ['SAC', s.sac],
  ];
  let y = 62;
  for (const [k, v] of meta) {
    doc.fillColor(grey).text(k, 360, y, { width: 80 });
    doc.fillColor('#000').text(v, 440, y, { width: 115, align: 'right' });
    y += 13;
  }

  y = Math.max(doc.y, y) + 12;
  if (s.customer.name || s.customer.phone) {
    doc.font('Helvetica-Bold').fontSize(9).text('Billed to', left, y);
    doc.font('Helvetica').text([s.customer.name, s.customer.phone].filter(Boolean).join(' · '));
    y = doc.y + 8;
  }

  // ---- items table ----
  const cols = { item: left, qty: 330, rate: 380, amount: 470 };
  const line = (yy: number) =>
    doc.moveTo(left, yy).lineTo(right, yy).lineWidth(0.5).strokeColor('#cccccc').stroke();
  line(y);
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#000');
  doc.text('Item', cols.item, y + 5);
  doc.text('Qty', cols.qty, y + 5, { width: 40, align: 'right' });
  doc.text('Rate', cols.rate, y + 5, { width: 80, align: 'right' });
  doc.text('Amount', cols.amount, y + 5, { width: right - cols.amount, align: 'right' });
  y += 20;
  line(y);
  doc.font('Helvetica').fontSize(9);
  for (const i of s.items) {
    if (y > 720) {
      doc.addPage();
      y = 40;
    }
    const name = [
      i.name + (i.variantName ? ` (${i.variantName})` : ''),
      ...i.addons.map((a) => `+ ${a}`),
    ].join('\n');
    const top = y + 5;
    doc.fillColor('#000').text(name, cols.item, top, { width: cols.qty - cols.item - 10 });
    const after = doc.y;
    doc.text(String(i.quantity), cols.qty, top, { width: 40, align: 'right' });
    doc.text(amt(i.unitPriceMinor), cols.rate, top, { width: 80, align: 'right' });
    doc.text(amt(i.lineTotalMinor), cols.amount, top, {
      width: right - cols.amount,
      align: 'right',
    });
    y = after + 4;
    if (i.note) {
      doc.fillColor(grey).fontSize(8).text(`Note: ${i.note}`, cols.item, y, { width: 280 });
      doc.fontSize(9);
      y = doc.y + 2;
    }
  }
  line(y + 2);
  y += 10;

  // ---- totals ----
  const total = (label: string, value: string, bold = false) => {
    doc
      .font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(bold ? 11 : 9)
      .fillColor('#000');
    doc.text(label, 330, y, { width: 140 });
    doc.text(value, cols.amount, y, { width: right - cols.amount, align: 'right' });
    y += bold ? 18 : 14;
  };
  total('Subtotal', amt(s.subtotalMinor));
  for (const d of s.discounts) total(`Discount: ${d.name}`, `- ${amt(d.amountMinor)}`);
  if (!s.discounts.length && s.discountMinor) total('Discount', `- ${amt(s.discountMinor)}`);
  total('Taxable value', amt(s.taxableMinor));
  for (const t of s.taxSplit)
    total(`${t.label} @ ${(t.rateBp / 100).toFixed(2)}%`, amt(t.amountMinor));
  line(y);
  y += 4;
  total('Total', amt(s.totalMinor), true);

  // ---- payments ----
  y += 6;
  doc.font('Helvetica-Bold').fontSize(9).text('Payment', left, y);
  y = doc.y + 2;
  doc.font('Helvetica').fontSize(9);
  for (const p of s.payments) {
    const label =
      { cash: 'Cash', card: 'Card', upi: 'UPI', online: 'Online' }[p.method] ?? p.method;
    doc.text(
      `${label} · ${amt(p.amountMinor)}${p.reference ? ` · Ref ${p.reference}` : ''} · ${when(p.at)}`,
      left,
      y,
      { width },
    );
    y = doc.y + 2;
  }
  doc.text(`Status: ${s.paymentStatus.replace('_', ' ').toUpperCase()}`, left, y + 2);

  doc
    .fontSize(8)
    .fillColor(grey)
    .text('This is a computer-generated invoice and does not require a signature.', left, 790, {
      width,
      align: 'center',
    });
  doc.end();
  return done;
}
