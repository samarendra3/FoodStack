import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { type Db, DbContext } from '../../core/db/db-context';
import { hasPermission } from '../auth/access';
import { AccessService } from '../auth/access.service';
import type { AuthContext, TenantAccess } from '../auth/auth.types';
import { writeAudit } from '../auth/user-tokens';
import { OrderEventsService } from './order-events';
import { OrdersService } from './orders.service';

/** SAC for restaurant services (GST). */
export const RESTAURANT_SAC = '996331';

/** Everything printed on an issued invoice; frozen at issue time. */
export interface InvoiceSnapshot {
  invoiceNumber: string;
  issuedAt: string;
  financialYear: string;
  title: 'TAX INVOICE' | 'BILL OF SUPPLY';
  seller: {
    name: string;
    legalName: string | null;
    gstin: string | null;
    address: string | null;
    state: string | null;
    phone: string | null;
    email: string | null;
    logoUrl: string | null;
    branchName: string;
  };
  placeOfSupply: string | null;
  sac: string;
  order: {
    id: string;
    orderNumber: string;
    channel: string;
    tableLabel: string | null;
    billLabel: string | null;
    createdAt: string;
  };
  customer: { name: string | null; phone: string | null };
  currencyCode: string;
  items: {
    name: string;
    variantName: string | null;
    addons: string[];
    note: string | null;
    quantity: number;
    unitPriceMinor: number;
    lineTotalMinor: number;
    discountMinor: number;
  }[];
  subtotalMinor: number;
  discountMinor: number;
  discounts: { name: string; amountMinor: number }[];
  taxableMinor: number;
  taxRateBp: number;
  /** India with tax: CGST + SGST halves (intra-state restaurant supply). */
  taxSplit: { label: string; rateBp: number; amountMinor: number }[];
  taxMinor: number;
  totalMinor: number;
  payments: {
    method: string;
    amountMinor: number;
    reference: string | null;
    at: string;
  }[];
  paymentStatus: string;
}

const conflict = (code: string, message: string) => new ConflictException({ code, message });

/** Indian financial year label for a local date: Apr 2025–Mar 2026 → "25-26". */
export function financialYear(localDate: string): string {
  const [y, m] = localDate.split('-').map(Number) as [number, number];
  const start = m >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** e.g. "MAIN/25-26/00042" — ≤ 16 chars, letters, digits, "/" and "-" only (GST rule 46). */
export function invoiceNumber(branchCode: string, fy: string, n: number): string {
  const prefix =
    branchCode
      .replace(/[^A-Za-z0-9]/g, '')
      .toUpperCase()
      .slice(0, 4) || 'INV';
  return `${prefix}/${fy}/${String(n).padStart(5, '0')}`;
}

/**
 * GST invoices. Every bill gets its invoice in the SAME transaction that settles it (the last
 * payment), so numbering is consecutive and gap-free per branch and financial year; issuing
 * is idempotent (one invoice per order). Older settled bills can be issued on demand.
 */
@Injectable()
export class InvoicesService implements OnModuleInit {
  constructor(
    private readonly db: DbContext,
    private readonly access: AccessService,
    private readonly orders: OrdersService,
    private readonly events: OrderEventsService,
  ) {}

  onModuleInit() {
    this.orders.onSettled = (db, orderId, userId) => this.issueInTx(db, orderId, userId);
  }

  /** Issues (or returns) the invoice of a settled order, in the caller's transaction. */
  async issueInTx(db: Db, orderId: string, userId: string | null) {
    const existing = await db.one<{ id: string }>('SELECT id FROM invoices WHERE order_id = $1', [
      orderId,
    ]);
    if (existing) return existing.id;
    const o = await db.one<{
      id: string;
      tenant_id: string;
      restaurant_id: string;
      branch_id: string;
      order_number: number;
      channel: string;
      table_label: string | null;
      bill_label: string | null;
      status: string;
      payment_status: string;
      currency_code: string;
      tax_rate_bp: number;
      subtotal_minor: string;
      discount_minor: string;
      tax_minor: string;
      total_minor: string;
      created_at: Date;
      customer_name: string | null;
      customer_phone: string | null;
    }>(
      `SELECT o.*, coalesce(c.name, g.display_name) AS customer_name,
              coalesce(c.phone, g.phone) AS customer_phone
         FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
         LEFT JOIN table_guests g ON g.id = o.guest_id
        WHERE o.id = $1 FOR UPDATE OF o`,
      [orderId],
    );
    if (!o) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Order not found.' });
    if (o.status !== 'completed')
      throw conflict('NOT_SETTLED', 'An invoice is issued once the bill is fully paid.');

    const seller = (await db.one<{
      name: string;
      legal_name: string | null;
      gstin: string | null;
      address_line: string | null;
      city: string | null;
      state: string | null;
      postal_code: string | null;
      phone: string | null;
      email: string | null;
      logo_url: string | null;
      country_code: string;
      branch_name: string;
      branch_code: string;
      local_date: string;
    }>(
      `SELECT r.name, r.legal_name, r.gstin, r.address_line, r.city, r.state, r.postal_code,
              r.phone, r.email, r.logo_url, r.country_code, b.name AS branch_name,
              b.code::text AS branch_code,
              to_char(now() AT TIME ZONE b.timezone, 'YYYY-MM-DD') AS local_date
         FROM branches b JOIN restaurants r ON r.id = b.restaurant_id WHERE b.id = $1`,
      [o.branch_id],
    ))!;
    const items = await db.query<{
      id: string;
      name: string;
      variant_name: string | null;
      note: string | null;
      quantity: number;
      unit_price_minor: string;
      line_total_minor: string;
      discount_minor: string;
    }>(
      `SELECT id, name, variant_name, note, quantity, unit_price_minor, line_total_minor, discount_minor
         FROM order_items WHERE order_id = $1 AND status = 'active' ORDER BY created_at, id`,
      [orderId],
    );
    const addons = await db.query<{ order_item_id: string; name: string }>(
      `SELECT order_item_id, name FROM order_item_addons WHERE order_id = $1 ORDER BY id`,
      [orderId],
    );
    const discounts = await db.query<{ name: string; discount_minor: string }>(
      `SELECT name, discount_minor FROM order_discounts WHERE order_id = $1`,
      [orderId],
    );
    const payments = await db.query<{
      method: string;
      amount_minor: string;
      reference: string | null;
      gateway_payment_id: string | null;
      created_at: Date;
    }>(
      `SELECT method, amount_minor, reference, gateway_payment_id, created_at FROM payments
        WHERE order_id = $1 ORDER BY created_at`,
      [orderId],
    );

    // Consecutive number for this branch and financial year, allocated in this transaction.
    const fy = financialYear(seller.local_date);
    const seq = await db.one<{ last_number: number }>(
      `INSERT INTO invoice_series (tenant_id, branch_id, financial_year, last_number)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (tenant_id, branch_id, financial_year)
       DO UPDATE SET last_number = invoice_series.last_number + 1
       RETURNING last_number`,
      [o.tenant_id, o.branch_id, fy],
    );
    const number = invoiceNumber(seller.branch_code, fy, seq!.last_number);

    const tax = Number(o.tax_minor);
    const india = seller.country_code.trim() === 'IN';
    const half = Math.floor(tax / 2);
    const snapshot: InvoiceSnapshot = {
      invoiceNumber: number,
      issuedAt: new Date().toISOString(),
      financialYear: fy,
      title: seller.gstin && tax > 0 ? 'TAX INVOICE' : 'BILL OF SUPPLY',
      seller: {
        name: seller.name,
        legalName: seller.legal_name,
        gstin: seller.gstin,
        address:
          [seller.address_line, seller.city, seller.state, seller.postal_code]
            .filter(Boolean)
            .join(', ') || null,
        state: seller.state,
        phone: seller.phone,
        email: seller.email,
        logoUrl: seller.logo_url,
        branchName: seller.branch_name,
      },
      placeOfSupply: seller.state,
      sac: RESTAURANT_SAC,
      order: {
        id: o.id,
        orderNumber: String(o.order_number),
        channel: o.channel,
        tableLabel: o.table_label,
        billLabel: o.bill_label,
        createdAt: new Date(o.created_at).toISOString(),
      },
      customer: { name: o.customer_name, phone: o.customer_phone },
      currencyCode: o.currency_code.trim(),
      items: items.map((i) => ({
        name: i.name,
        variantName: i.variant_name,
        addons: addons.filter((a) => a.order_item_id === i.id).map((a) => a.name),
        note: i.note,
        quantity: i.quantity,
        unitPriceMinor: Number(i.unit_price_minor),
        lineTotalMinor: Number(i.line_total_minor),
        discountMinor: Number(i.discount_minor),
      })),
      subtotalMinor: Number(o.subtotal_minor),
      discountMinor: Number(o.discount_minor),
      discounts: discounts.map((d) => ({ name: d.name, amountMinor: Number(d.discount_minor) })),
      taxableMinor: Number(o.subtotal_minor) - Number(o.discount_minor),
      taxRateBp: o.tax_rate_bp,
      taxSplit:
        tax <= 0
          ? []
          : india
            ? [
                { label: 'CGST', rateBp: o.tax_rate_bp / 2, amountMinor: half },
                { label: 'SGST', rateBp: o.tax_rate_bp / 2, amountMinor: tax - half },
              ]
            : [{ label: 'Tax', rateBp: o.tax_rate_bp, amountMinor: tax }],
      taxMinor: tax,
      totalMinor: Number(o.total_minor),
      payments: payments.map((p) => ({
        method: p.method,
        amountMinor: Number(p.amount_minor),
        reference: p.gateway_payment_id ?? p.reference,
        at: new Date(p.created_at).toISOString(),
      })),
      paymentStatus: o.payment_status,
    };
    const inv = await db.one<{ id: string }>(
      `INSERT INTO invoices (tenant_id, restaurant_id, branch_id, order_id, invoice_number,
                             financial_year, series_number, total_minor, customer_phone, snapshot, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11) RETURNING id`,
      [
        o.tenant_id,
        o.restaurant_id,
        o.branch_id,
        orderId,
        number,
        fy,
        seq!.last_number,
        Number(o.total_minor),
        o.customer_phone,
        JSON.stringify(snapshot),
        userId,
      ],
    );
    await writeAudit(db, {
      tenantId: o.tenant_id,
      actorUserId: userId,
      actorAudience: userId ? 'tenant' : 'system',
      action: 'invoice.generated',
      entityType: 'order',
      entityId: orderId,
      metadata: { invoiceId: inv!.id, invoiceNumber: number },
    });
    await this.events.record(db, {
      tenantId: o.tenant_id,
      branchId: o.branch_id,
      orderId,
      type: 'invoice.generated',
      payload: { invoiceId: inv!.id, invoiceNumber: number },
      actor: userId ? { kind: 'staff', userId } : { kind: 'system' },
    });
    return inv!.id;
  }

  // ---- API ----

  /** Issue on demand (bills settled before invoices existed); returns the existing one if any. */
  issue(auth: AuthContext, orderId: string) {
    return this.run(auth, async (db, access) => {
      const o = await db.one<{ branch_id: string }>('SELECT branch_id FROM orders WHERE id = $1', [
        orderId,
      ]);
      if (!o) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Order not found.' });
      this.require(access, o.branch_id);
      const id = await this.issueInTx(db, orderId, auth.userId);
      return this.view(db, id);
    });
  }

  byOrder(auth: AuthContext, orderId: string) {
    return this.run(auth, async (db, access) => {
      const r = await db.one<{ id: string; branch_id: string }>(
        'SELECT id, branch_id FROM invoices WHERE order_id = $1',
        [orderId],
      );
      if (!r) return null;
      this.require(access, r.branch_id);
      return this.view(db, r.id);
    });
  }

  get(auth: AuthContext, id: string) {
    return this.run(auth, async (db, access) => {
      const r = await db.one<{ branch_id: string }>(
        'SELECT branch_id FROM invoices WHERE id = $1',
        [id],
      );
      if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invoice not found.' });
      this.require(access, r.branch_id);
      return this.view(db, id);
    });
  }

  list(auth: AuthContext, branchId: string, from?: string, to?: string) {
    return this.run(auth, async (db, access) => {
      this.require(access, branchId);
      const rows = await db.query<{
        id: string;
        invoice_number: string;
        issued_at: Date;
        total_minor: string;
        order_id: string;
        order_number: number;
        table_label: string | null;
        customer_phone: string | null;
      }>(
        `SELECT i.id, i.invoice_number, i.issued_at, i.total_minor, i.order_id, o.order_number,
                o.table_label, i.customer_phone
           FROM invoices i JOIN orders o ON o.id = i.order_id
          WHERE i.branch_id = $1
            AND ($2::date IS NULL OR i.issued_at >= $2::date)
            AND ($3::date IS NULL OR i.issued_at < $3::date + 1)
          ORDER BY i.issued_at DESC LIMIT 500`,
        [branchId, from ?? null, to ?? null],
      );
      return rows.map((r) => ({
        id: r.id,
        invoiceNumber: r.invoice_number,
        issuedAt: new Date(r.issued_at).toISOString(),
        totalMinor: Number(r.total_minor),
        orderId: r.order_id,
        orderNumber: String(r.order_number),
        tableLabel: r.table_label,
        customerPhone: r.customer_phone,
      }));
    });
  }

  /** The frozen snapshot for rendering (PDF / print), after the same access check. */
  snapshot(auth: AuthContext, id: string) {
    return this.run(auth, async (db, access) => {
      const r = await db.one<{ branch_id: string; snapshot: InvoiceSnapshot }>(
        'SELECT branch_id, snapshot FROM invoices WHERE id = $1',
        [id],
      );
      if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invoice not found.' });
      this.require(access, r.branch_id);
      return r.snapshot;
    });
  }

  private async view(db: Db, id: string) {
    const r = await db.one<{
      id: string;
      order_id: string;
      invoice_number: string;
      issued_at: Date;
      total_minor: string;
      snapshot: InvoiceSnapshot;
    }>(
      'SELECT id, order_id, invoice_number, issued_at, total_minor, snapshot FROM invoices WHERE id = $1',
      [id],
    );
    return {
      id: r!.id,
      orderId: r!.order_id,
      invoiceNumber: r!.invoice_number,
      issuedAt: new Date(r!.issued_at).toISOString(),
      totalMinor: Number(r!.total_minor),
      snapshot: r!.snapshot,
    };
  }

  private require(access: TenantAccess, branchId: string) {
    const inTenant = access.allBranches.some((b) => b.id === branchId);
    if (
      !inTenant ||
      !['order:read', 'pos:access'].some((p) => hasPermission(access, p, { branchId }))
    ) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'You cannot view this invoice.' });
    }
  }

  private run<T>(auth: AuthContext, work: (db: Db, access: TenantAccess) => Promise<T>) {
    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, async (db) =>
      work(db, await this.access.forRequest(db, auth)),
    );
  }
}
