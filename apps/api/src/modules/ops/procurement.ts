import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { requestMeta } from '../../common/http/request-meta';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { CacheNs } from '../../shared/cache/cache.keys';
import { CacheService } from '../../shared/cache/cache.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import {
  branchQuery,
  dateStr,
  invalid,
  iso,
  money,
  notFound,
  OpsBase,
  optText,
  qty,
  restaurantQuery,
  type Scope,
  setClause,
} from './ops-base';

/*
 * Suppliers, purchase orders (receiving adds stock), stock transfers between branches and menu
 * recipes (ingredient cost per dish). Stock changes go through `moveStock`, which follows the
 * inventory module's rules: lock the stock row, never below zero, one movement row per change.
 */

const round3 = (n: number) => Math.round(n * 1000) / 1000;

const supplierSchema = z.strictObject({
  restaurantId: z.uuid().optional(),
  name: z.string().trim().min(1).max(120),
  contactName: optText(80),
  phone: optText(20),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .transform((v) => (v === '' ? null : v))
    .pipe(z.email().nullable())
    .nullable()
    .optional(),
  gstin: optText(15),
  address: optText(300),
  note: optText(300),
  isActive: z.boolean().optional(),
});
const supplierUpdateSchema = supplierSchema.omit({ restaurantId: true }).partial();

const lineSchema = z.strictObject({ itemId: z.uuid(), quantity: qty, unitCostMinor: money });
const poSchema = z.strictObject({
  branchId: z.uuid(),
  supplierId: z.uuid(),
  expectedOn: dateStr.nullable().optional(),
  note: optText(300),
  lines: z.array(lineSchema).min(1).max(100),
});
const poUpdateSchema = poSchema.omit({ branchId: true }).partial();
const receiveSchema = z.strictObject({
  lines: z
    .array(
      z.strictObject({
        lineId: z.uuid(),
        receivedQuantity: z.coerce.number().min(0).max(1_000_000),
      }),
    )
    .min(1),
});
const poListSchema = z.strictObject({
  branchId: z.uuid().optional(),
  status: z.enum(['draft', 'ordered', 'received', 'cancelled']).optional(),
});

const transferSchema = z.strictObject({
  fromBranchId: z.uuid(),
  toBranchId: z.uuid(),
  note: optText(300),
  lines: z
    .array(z.strictObject({ itemId: z.uuid(), quantity: qty }))
    .min(1)
    .max(100),
});

const recipeSchema = z.strictObject({
  lines: z.array(z.strictObject({ itemId: z.uuid(), quantity: qty })).max(50),
});

@Injectable()
export class ProcurementService {
  constructor(
    private readonly ops: OpsBase,
    private readonly cache: CacheService,
  ) {}

  // ---------------------------------------------------------------- suppliers

  suppliers(auth: AuthContext, restaurantId?: string) {
    return this.ops.run(auth, async (s) => {
      const rid = this.ops.readRestaurant(s.access, 'inventory:read', restaurantId);
      const rows = await s.db.query<Record<string, unknown>>(
        `SELECT sp.id, sp.name, sp.contact_name, sp.phone, sp.email, sp.gstin, sp.address, sp.note, sp.is_active,
                (SELECT count(*) FROM purchase_orders po WHERE po.supplier_id = sp.id AND po.status <> 'cancelled') AS orders,
                (SELECT coalesce(sum(total_minor), 0) FROM purchase_orders po WHERE po.supplier_id = sp.id AND po.status = 'received') AS spent,
                (SELECT max(received_at) FROM purchase_orders po WHERE po.supplier_id = sp.id) AS last_received
           FROM suppliers sp
          WHERE sp.restaurant_id = $1 AND sp.deleted_at IS NULL
          ORDER BY sp.is_active DESC, lower(sp.name)`,
        [rid],
      );
      return {
        restaurantId: rid,
        currencyCode: await this.ops.currency(s.db, rid),
        canManage: this.ops.can(s.access, 'inventory:manage', { restaurantId: rid }),
        rows: rows.map((r) => ({
          id: r.id,
          name: r.name,
          contactName: r.contact_name,
          phone: r.phone,
          email: r.email,
          gstin: r.gstin,
          address: r.address,
          note: r.note,
          isActive: r.is_active,
          orders: Number(r.orders),
          spentMinor: Number(r.spent),
          lastReceivedAt: iso(r.last_received as string | null),
        })),
      };
    });
  }

  createSupplier(auth: AuthContext, body: z.infer<typeof supplierSchema>, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const rid = this.ops.restaurant(s.access, 'inventory:manage', body.restaurantId);
      await this.uniqueSupplier(s, rid, body.name);
      const row = await s.db.one<{ id: string }>(
        `INSERT INTO suppliers (tenant_id, restaurant_id, name, contact_name, phone, email, gstin, address, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          s.auth.tenantId,
          rid,
          body.name,
          body.contactName ?? null,
          body.phone ?? null,
          body.email ?? null,
          body.gstin ?? null,
          body.address ?? null,
          body.note ?? null,
          s.auth.userId,
        ],
      );
      await this.ops.audit(s, meta, 'supplier.created', 'supplier', row!.id, { name: body.name });
      return { id: row!.id };
    });
  }

  updateSupplier(
    auth: AuthContext,
    id: string,
    body: z.infer<typeof supplierUpdateSchema>,
    meta: RequestMeta,
  ) {
    return this.ops.run(auth, async (s) => {
      const sp = await this.supplier(s, id);
      this.ops.restaurant(s.access, 'inventory:manage', sp.restaurant_id);
      if (body.name) await this.uniqueSupplier(s, sp.restaurant_id, body.name, id);
      const params: unknown[] = [id];
      const set = setClause(
        body,
        {
          name: 'name',
          contactName: 'contact_name',
          phone: 'phone',
          email: 'email',
          gstin: 'gstin',
          address: 'address',
          note: 'note',
          isActive: 'is_active',
        },
        params,
      );
      if (!set) return;
      await s.db.query(`UPDATE suppliers SET ${set} WHERE id = $1`, params);
      await this.ops.audit(s, meta, 'supplier.updated', 'supplier', id, body);
    });
  }

  deleteSupplier(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const sp = await this.supplier(s, id);
      this.ops.restaurant(s.access, 'inventory:manage', sp.restaurant_id);
      const open = await s.db.one(
        `SELECT 1 FROM purchase_orders WHERE supplier_id = $1 AND status IN ('draft', 'ordered')`,
        [id],
      );
      if (open)
        throw invalid('This supplier has open purchase orders. Receive or cancel them first.');
      await s.db.query('UPDATE suppliers SET deleted_at = now() WHERE id = $1', [id]);
      await this.ops.audit(s, meta, 'supplier.deleted', 'supplier', id);
    });
  }

  private async supplier(s: Scope, id: string) {
    const sp = await s.db.one<{ restaurant_id: string; is_active: boolean }>(
      'SELECT restaurant_id, is_active FROM suppliers WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    if (!sp) throw notFound('Supplier');
    return sp;
  }

  private async uniqueSupplier(s: Scope, rid: string, name: string, except?: string) {
    const dup = await s.db.one(
      `SELECT 1 FROM suppliers WHERE restaurant_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL
         AND ($3::uuid IS NULL OR id <> $3)`,
      [rid, name, except ?? null],
    );
    if (dup)
      throw new ConflictException({
        code: 'SUPPLIER_EXISTS',
        message: 'A supplier with this name already exists.',
      });
  }

  // ---------------------------------------------------------------- purchase orders

  purchaseOrders(auth: AuthContext, q: z.infer<typeof poListSchema>) {
    return this.ops.run(auth, async (s) => {
      const branches = this.ops.branchList(s.access, 'inventory:read');
      if (branches.length === 0) throw invalid('You cannot view purchase orders.', 'OPS_FORBIDDEN');
      const ids = q.branchId
        ? [this.ops.branch(s.access, 'inventory:read', q.branchId).id]
        : branches.map((b) => b.id);
      const params: unknown[] = [ids];
      let extra = '';
      if (q.status) {
        params.push(q.status);
        extra = ` AND po.status = $${params.length}`;
      }
      const rows = await s.db.query<Record<string, unknown>>(
        `SELECT po.id, po.po_number, po.status, po.expected_on::text, po.note, po.total_minor, po.created_at,
                po.ordered_at, po.received_at, po.branch_id, b.name AS branch_name, po.supplier_id,
                sp.name AS supplier_name, (SELECT count(*) FROM purchase_order_lines l WHERE l.purchase_order_id = po.id) AS line_count
           FROM purchase_orders po
           JOIN branches b ON b.id = po.branch_id
           JOIN suppliers sp ON sp.id = po.supplier_id
          WHERE po.branch_id = ANY($1::uuid[])${extra}
          ORDER BY po.created_at DESC LIMIT 500`,
        params,
      );
      return {
        currencyCode: await this.ops.currency(s.db, branches[0]!.restaurantId),
        branches,
        canManage: this.ops.branchesWith(s.access, 'inventory:manage').length > 0,
        rows: rows.map((r) => ({
          id: r.id,
          number: Number(r.po_number),
          status: r.status,
          expectedOn: r.expected_on,
          note: r.note,
          totalMinor: Number(r.total_minor),
          createdAt: iso(r.created_at as string),
          orderedAt: iso(r.ordered_at as string | null),
          receivedAt: iso(r.received_at as string | null),
          branchId: r.branch_id,
          branchName: r.branch_name,
          supplierId: r.supplier_id,
          supplierName: r.supplier_name,
          lineCount: Number(r.line_count),
        })),
      };
    });
  }

  purchaseOrder(auth: AuthContext, id: string) {
    return this.ops.run(auth, async (s) => {
      const po = await this.po(s, id);
      this.ops.branch(s.access, 'inventory:read', po.branch_id);
      const lines = await s.db.query<Record<string, unknown>>(
        `SELECT l.id, l.item_id, i.name, i.unit, l.quantity, l.unit_cost_minor, l.received_quantity
           FROM purchase_order_lines l JOIN inventory_items i ON i.id = l.item_id
          WHERE l.purchase_order_id = $1 ORDER BY l.created_at`,
        [id],
      );
      return {
        ...po,
        lines: lines.map((l) => ({
          id: l.id,
          itemId: l.item_id,
          name: l.name,
          unit: l.unit,
          quantity: Number(l.quantity),
          unitCostMinor: Number(l.unit_cost_minor),
          receivedQuantity: l.received_quantity === null ? null : Number(l.received_quantity),
        })),
      };
    });
  }

  createPurchaseOrder(auth: AuthContext, body: z.infer<typeof poSchema>, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const b = this.ops.branch(s.access, 'inventory:manage', body.branchId);
      const sp = await this.supplier(s, body.supplierId);
      if (sp.restaurant_id !== b.restaurantId)
        throw invalid('This supplier belongs to another restaurant.');
      if (!sp.is_active) throw invalid('This supplier is inactive.');
      await this.checkItems(
        s,
        b.restaurantId,
        body.lines.map((l) => l.itemId),
      );
      // Serialize numbering per restaurant.
      await s.db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`po:${b.restaurantId}`]);
      const next = await s.db.one<{ n: number }>(
        'SELECT coalesce(max(po_number), 0) + 1 AS n FROM purchase_orders WHERE restaurant_id = $1',
        [b.restaurantId],
      );
      const total = body.lines.reduce((t, l) => t + Math.round(l.quantity * l.unitCostMinor), 0);
      const po = await s.db.one<{ id: string }>(
        `INSERT INTO purchase_orders (tenant_id, restaurant_id, branch_id, supplier_id, po_number, expected_on, note, total_minor, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          s.auth.tenantId,
          b.restaurantId,
          b.id,
          body.supplierId,
          next!.n,
          body.expectedOn ?? null,
          body.note ?? null,
          total,
          s.auth.userId,
        ],
      );
      await this.insertLines(s, po!.id, body.lines);
      await this.ops.audit(s, meta, 'purchase_order.created', 'purchase_order', po!.id, {
        number: next!.n,
        totalMinor: total,
      });
      return { id: po!.id, number: next!.n };
    });
  }

  updatePurchaseOrder(
    auth: AuthContext,
    id: string,
    body: z.infer<typeof poUpdateSchema>,
    meta: RequestMeta,
  ) {
    return this.ops.run(auth, async (s) => {
      const po = await this.po(s, id);
      const b = this.ops.branch(s.access, 'inventory:manage', po.branchId);
      if (po.status !== 'draft') throw invalid('Only draft purchase orders can be edited.');
      if (body.supplierId) {
        const sp = await this.supplier(s, body.supplierId);
        if (sp.restaurant_id !== b.restaurantId)
          throw invalid('This supplier belongs to another restaurant.');
      }
      const params: unknown[] = [id];
      const set = setClause(
        body,
        { supplierId: 'supplier_id', expectedOn: 'expected_on', note: 'note' },
        params,
      );
      if (set) await s.db.query(`UPDATE purchase_orders SET ${set} WHERE id = $1`, params);
      if (body.lines) {
        await this.checkItems(
          s,
          b.restaurantId,
          body.lines.map((l) => l.itemId),
        );
        await s.db.query('DELETE FROM purchase_order_lines WHERE purchase_order_id = $1', [id]);
        await this.insertLines(s, id, body.lines);
        const total = body.lines.reduce((t, l) => t + Math.round(l.quantity * l.unitCostMinor), 0);
        await s.db.query('UPDATE purchase_orders SET total_minor = $2 WHERE id = $1', [id, total]);
      }
      await this.ops.audit(s, meta, 'purchase_order.updated', 'purchase_order', id);
    });
  }

  /** draft → ordered (sent to supplier) or → cancelled; ordered → cancelled. */
  setStatus(auth: AuthContext, id: string, to: 'ordered' | 'cancelled', meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const po = await this.po(s, id);
      this.ops.branch(s.access, 'inventory:manage', po.branchId);
      const allowed =
        to === 'ordered' ? po.status === 'draft' : po.status === 'draft' || po.status === 'ordered';
      if (!allowed) throw invalid(`A ${po.status} purchase order cannot be marked ${to}.`);
      await s.db.query(
        `UPDATE purchase_orders SET status = $2, ordered_at = CASE WHEN $2 = 'ordered' THEN now() ELSE ordered_at END WHERE id = $1`,
        [id, to],
      );
      await this.ops.audit(s, meta, `purchase_order.${to}`, 'purchase_order', id);
    });
  }

  /** Records what arrived, adds it to the branch's stock and closes the order. */
  receive(auth: AuthContext, id: string, body: z.infer<typeof receiveSchema>, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const po = await this.po(s, id, true);
      const b = this.ops.branch(s.access, 'inventory:manage', po.branchId);
      if (po.status !== 'ordered' && po.status !== 'draft')
        throw invalid(`A ${po.status} purchase order cannot be received.`);
      const lines = await s.db.query<{ id: string; item_id: string; unit_cost_minor: string }>(
        'SELECT id, item_id, unit_cost_minor FROM purchase_order_lines WHERE purchase_order_id = $1',
        [id],
      );
      const got = new Map(body.lines.map((l) => [l.lineId, l.receivedQuantity]));
      let total = 0;
      for (const l of lines) {
        const q = round3(got.get(l.id) ?? 0);
        await s.db.query('UPDATE purchase_order_lines SET received_quantity = $2 WHERE id = $1', [
          l.id,
          q,
        ]);
        total += Math.round(q * Number(l.unit_cost_minor));
        if (q > 0) {
          await this.moveStock(
            s,
            b.id,
            l.item_id,
            'purchase',
            q,
            `PO #${po.number} from ${po.supplierName}`,
          );
          // Latest purchase price becomes the item's cost.
          await s.db.query('UPDATE inventory_items SET cost_per_unit_minor = $2 WHERE id = $1', [
            l.item_id,
            Number(l.unit_cost_minor),
          ]);
        }
      }
      await s.db.query(
        `UPDATE purchase_orders SET status = 'received', received_at = now(), received_by = $2, total_minor = $3 WHERE id = $1`,
        [id, s.auth.userId, total],
      );
      this.cache.invalidateAfterCommit(s.db, CacheNs.inventory(s.auth.tenantId!, b.restaurantId));
      await this.ops.audit(s, meta, 'purchase_order.received', 'purchase_order', id, {
        totalMinor: total,
      });
    });
  }

  private async po(s: Scope, id: string, lock = false) {
    const r = await s.db.one<Record<string, unknown>>(
      `SELECT po.id, po.po_number, po.status, po.branch_id, b.name AS branch_name, po.supplier_id, sp.name AS supplier_name,
              po.expected_on::text, po.note, po.total_minor, po.created_at, po.ordered_at, po.received_at
         FROM purchase_orders po JOIN branches b ON b.id = po.branch_id JOIN suppliers sp ON sp.id = po.supplier_id
        WHERE po.id = $1 ${lock ? 'FOR UPDATE OF po' : ''}`,
      [id],
    );
    if (!r) throw notFound('Purchase order');
    return {
      id: r.id as string,
      number: Number(r.po_number),
      status: r.status as string,
      branchId: r.branch_id as string,
      branch_id: r.branch_id as string,
      branchName: r.branch_name as string,
      supplierId: r.supplier_id as string,
      supplierName: r.supplier_name as string,
      expectedOn: r.expected_on as string | null,
      note: r.note as string | null,
      totalMinor: Number(r.total_minor),
      createdAt: iso(r.created_at as string),
      orderedAt: iso(r.ordered_at as string | null),
      receivedAt: iso(r.received_at as string | null),
    };
  }

  private async insertLines(s: Scope, poId: string, lines: z.infer<typeof lineSchema>[]) {
    for (const l of lines) {
      await s.db.query(
        `INSERT INTO purchase_order_lines (tenant_id, purchase_order_id, item_id, quantity, unit_cost_minor, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [s.auth.tenantId, poId, l.itemId, round3(l.quantity), l.unitCostMinor, s.auth.userId],
      );
    }
  }

  private async checkItems(s: Scope, restaurantId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    if (unique.length !== ids.length) throw invalid('Each stock item can appear only once.');
    const found = await s.db.query<{ id: string }>(
      `SELECT id FROM inventory_items WHERE id = ANY($1::uuid[]) AND restaurant_id = $2 AND deleted_at IS NULL`,
      [unique, restaurantId],
    );
    if (found.length !== unique.length) throw invalid('One or more stock items were not found.');
  }

  /** Applies a stock change at a branch with the inventory module's locking and floor-at-zero rule. */
  private async moveStock(
    s: Scope,
    branchId: string,
    itemId: string,
    type: 'purchase' | 'transfer_in' | 'transfer_out',
    quantity: number,
    note: string,
  ) {
    await s.db.query(
      `INSERT INTO inventory_stock (tenant_id, branch_id, item_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [s.auth.tenantId, branchId, itemId],
    );
    const stock = await s.db.one<{ quantity: string }>(
      'SELECT quantity FROM inventory_stock WHERE branch_id = $1 AND item_id = $2 FOR UPDATE',
      [branchId, itemId],
    );
    const before = Number(stock!.quantity);
    const delta = type === 'transfer_out' ? -quantity : quantity;
    const after = round3(before + delta);
    if (after < 0) {
      const item = await s.db.one<{ name: string }>(
        'SELECT name FROM inventory_items WHERE id = $1',
        [itemId],
      );
      throw new ConflictException({
        code: 'INSUFFICIENT_STOCK',
        message: `Only ${before} of ${item?.name ?? 'this item'} in stock.`,
      });
    }
    await s.db.query(
      'UPDATE inventory_stock SET quantity = $3, updated_at = now() WHERE branch_id = $1 AND item_id = $2',
      [branchId, itemId, after],
    );
    await s.db.query(
      `INSERT INTO inventory_movements (tenant_id, branch_id, item_id, type, quantity_delta, quantity_after, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        s.auth.tenantId,
        branchId,
        itemId,
        type,
        round3(delta),
        after,
        note.slice(0, 200),
        s.auth.userId,
      ],
    );
  }

  // ---------------------------------------------------------------- transfers

  transfers(auth: AuthContext, branchId?: string) {
    return this.ops.run(auth, async (s) => {
      const branches = this.ops.branchList(s.access, 'inventory:read');
      if (branches.length === 0) throw invalid('You cannot view transfers.', 'OPS_FORBIDDEN');
      const ids = branchId
        ? [this.ops.branch(s.access, 'inventory:read', branchId).id]
        : branches.map((b) => b.id);
      const rows = await s.db.query<Record<string, unknown>>(
        `SELECT t.id, t.created_at, t.note, fb.name AS from_name, tb.name AS to_name, u.full_name AS by_name,
                coalesce(json_agg(json_build_object('name', i.name, 'unit', i.unit, 'quantity', l.quantity)
                         ORDER BY i.name) FILTER (WHERE l.id IS NOT NULL), '[]') AS lines
           FROM stock_transfers t
           JOIN branches fb ON fb.id = t.from_branch_id
           JOIN branches tb ON tb.id = t.to_branch_id
           LEFT JOIN users u ON u.id = t.created_by
           LEFT JOIN stock_transfer_lines l ON l.transfer_id = t.id
           LEFT JOIN inventory_items i ON i.id = l.item_id
          WHERE t.from_branch_id = ANY($1::uuid[]) OR t.to_branch_id = ANY($1::uuid[])
          GROUP BY t.id, fb.name, tb.name, u.full_name
          ORDER BY t.created_at DESC LIMIT 300`,
        [ids],
      );
      return {
        branches,
        canManage: this.ops.branchesWith(s.access, 'inventory:manage').length > 1,
        rows: rows.map((r) => ({
          id: r.id,
          createdAt: iso(r.created_at as string),
          note: r.note,
          fromName: r.from_name,
          toName: r.to_name,
          byName: r.by_name,
          lines: (r.lines as { name: string; unit: string; quantity: string }[]).map((l) => ({
            ...l,
            quantity: Number(l.quantity),
          })),
        })),
      };
    });
  }

  /** Moves stock between two branches of the same restaurant, all lines or none. */
  transfer(auth: AuthContext, body: z.infer<typeof transferSchema>, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      if (body.fromBranchId === body.toBranchId) throw invalid('Pick two different branches.');
      const from = this.ops.branch(s.access, 'inventory:manage', body.fromBranchId);
      const to = this.ops.branch(s.access, 'inventory:manage', body.toBranchId);
      if (from.restaurantId !== to.restaurantId)
        throw invalid('Both branches must belong to the same restaurant.');
      await this.checkItems(
        s,
        from.restaurantId,
        body.lines.map((l) => l.itemId),
      );
      const t = await s.db.one<{ id: string }>(
        `INSERT INTO stock_transfers (tenant_id, restaurant_id, from_branch_id, to_branch_id, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [s.auth.tenantId, from.restaurantId, from.id, to.id, body.note ?? null, s.auth.userId],
      );
      for (const l of body.lines) {
        const q = round3(l.quantity);
        await s.db.query(
          `INSERT INTO stock_transfer_lines (tenant_id, transfer_id, item_id, quantity, created_by) VALUES ($1, $2, $3, $4, $5)`,
          [s.auth.tenantId, t!.id, l.itemId, q, s.auth.userId],
        );
        await this.moveStock(s, from.id, l.itemId, 'transfer_out', q, `Transfer to ${to.name}`);
        await this.moveStock(s, to.id, l.itemId, 'transfer_in', q, `Transfer from ${from.name}`);
      }
      this.cache.invalidateAfterCommit(
        s.db,
        CacheNs.inventory(s.auth.tenantId!, from.restaurantId),
      );
      await this.ops.audit(s, meta, 'stock.transferred', 'stock_transfer', t!.id, {
        from: from.id,
        to: to.id,
        lines: body.lines.length,
      });
      return { id: t!.id };
    });
  }

  // ---------------------------------------------------------------- recipes

  /** Every menu item with its ingredient lines, food cost and margin. */
  recipes(auth: AuthContext, restaurantId?: string) {
    return this.ops.run(auth, async (s) => {
      const rid = this.ops.readRestaurant(s.access, 'menu:read', restaurantId);
      const items = await s.db.query<Record<string, unknown>>(
        `SELECT m.id, m.name, m.price_minor, c.name AS category,
                coalesce(json_agg(json_build_object('itemId', i.id, 'name', i.name, 'unit', i.unit,
                         'quantity', r.quantity, 'costPerUnitMinor', coalesce(i.cost_per_unit_minor, 0))
                         ORDER BY i.name) FILTER (WHERE r.id IS NOT NULL), '[]') AS lines
           FROM menu_items m
           LEFT JOIN menu_categories c ON c.id = m.category_id
           LEFT JOIN recipe_lines r ON r.menu_item_id = m.id
           LEFT JOIN inventory_items i ON i.id = r.item_id
          WHERE m.restaurant_id = $1 AND m.deleted_at IS NULL
          GROUP BY m.id, c.name
          ORDER BY lower(c.name), lower(m.name)`,
        [rid],
      );
      const stock = await s.db.query<{
        id: string;
        name: string;
        unit: string;
        cost: string | null;
      }>(
        `SELECT id, name, unit, cost_per_unit_minor AS cost FROM inventory_items
          WHERE restaurant_id = $1 AND deleted_at IS NULL ORDER BY lower(name)`,
        [rid],
      );
      return {
        restaurantId: rid,
        currencyCode: await this.ops.currency(s.db, rid),
        canManage: this.ops.can(s.access, 'menu:manage', { restaurantId: rid }),
        stockItems: stock.map((i) => ({
          id: i.id,
          name: i.name,
          unit: i.unit,
          costPerUnitMinor: Number(i.cost ?? 0),
        })),
        rows: items.map((m) => {
          const lines = (
            m.lines as {
              itemId: string;
              name: string;
              unit: string;
              quantity: string;
              costPerUnitMinor: string;
            }[]
          ).map((l) => ({
            ...l,
            quantity: Number(l.quantity),
            costPerUnitMinor: Number(l.costPerUnitMinor),
          }));
          const cost = Math.round(lines.reduce((t, l) => t + l.quantity * l.costPerUnitMinor, 0));
          const price = Number(m.price_minor);
          return {
            menuItemId: m.id,
            name: m.name,
            category: m.category,
            priceMinor: price,
            costMinor: cost,
            foodCostPct: price > 0 && lines.length ? Math.round((cost / price) * 1000) / 10 : null,
            lines,
          };
        }),
      };
    });
  }

  setRecipe(
    auth: AuthContext,
    menuItemId: string,
    body: z.infer<typeof recipeSchema>,
    meta: RequestMeta,
  ) {
    return this.ops.run(auth, async (s) => {
      const m = await s.db.one<{ restaurant_id: string }>(
        'SELECT restaurant_id FROM menu_items WHERE id = $1 AND deleted_at IS NULL',
        [menuItemId],
      );
      if (!m) throw notFound('Menu item');
      this.ops.restaurant(s.access, 'menu:manage', m.restaurant_id);
      await this.checkItems(
        s,
        m.restaurant_id,
        body.lines.map((l) => l.itemId),
      );
      await s.db.query('DELETE FROM recipe_lines WHERE menu_item_id = $1', [menuItemId]);
      for (const l of body.lines) {
        await s.db.query(
          `INSERT INTO recipe_lines (tenant_id, restaurant_id, menu_item_id, item_id, quantity, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            s.auth.tenantId,
            m.restaurant_id,
            menuItemId,
            l.itemId,
            round3(l.quantity),
            s.auth.userId,
          ],
        );
      }
      await this.ops.audit(s, meta, 'recipe.updated', 'menu_item', menuItemId, {
        lines: body.lines.length,
      });
    });
  }
}

@ApiTags('Procurement')
@Controller()
export class ProcurementController {
  constructor(private readonly p: ProcurementService) {}

  @Get('suppliers')
  @RequirePermission('inventory:read')
  suppliers(
    @CurrentAuth() a: AuthContext,
    @Query(new ZodValidationPipe(restaurantQuery)) q: z.infer<typeof restaurantQuery>,
  ) {
    return this.p.suppliers(a, q.restaurantId);
  }

  @Post('suppliers')
  @RequirePermission('inventory:manage')
  createSupplier(
    @CurrentAuth() a: AuthContext,
    @Body(new ZodValidationPipe(supplierSchema)) b: z.infer<typeof supplierSchema>,
    @Req() r: Request,
  ) {
    return this.p.createSupplier(a, b, requestMeta(r));
  }

  @Patch('suppliers/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('inventory:manage')
  async updateSupplier(
    @CurrentAuth() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(supplierUpdateSchema)) b: z.infer<typeof supplierUpdateSchema>,
    @Req() r: Request,
  ) {
    await this.p.updateSupplier(a, id, b, requestMeta(r));
  }

  @Delete('suppliers/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('inventory:manage')
  async deleteSupplier(
    @CurrentAuth() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() r: Request,
  ) {
    await this.p.deleteSupplier(a, id, requestMeta(r));
  }

  @Get('purchase-orders')
  @RequirePermission('inventory:read')
  purchaseOrders(
    @CurrentAuth() a: AuthContext,
    @Query(new ZodValidationPipe(poListSchema)) q: z.infer<typeof poListSchema>,
  ) {
    return this.p.purchaseOrders(a, q);
  }

  @Get('purchase-orders/:id')
  @RequirePermission('inventory:read')
  purchaseOrder(@CurrentAuth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.p.purchaseOrder(a, id);
  }

  @Post('purchase-orders')
  @RequirePermission('inventory:manage')
  createPurchaseOrder(
    @CurrentAuth() a: AuthContext,
    @Body(new ZodValidationPipe(poSchema)) b: z.infer<typeof poSchema>,
    @Req() r: Request,
  ) {
    return this.p.createPurchaseOrder(a, b, requestMeta(r));
  }

  @Patch('purchase-orders/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('inventory:manage')
  async updatePurchaseOrder(
    @CurrentAuth() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(poUpdateSchema)) b: z.infer<typeof poUpdateSchema>,
    @Req() r: Request,
  ) {
    await this.p.updatePurchaseOrder(a, id, b, requestMeta(r));
  }

  @Post('purchase-orders/:id/order')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('inventory:manage')
  async markOrdered(
    @CurrentAuth() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() r: Request,
  ) {
    await this.p.setStatus(a, id, 'ordered', requestMeta(r));
  }

  @Post('purchase-orders/:id/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('inventory:manage')
  async cancel(
    @CurrentAuth() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() r: Request,
  ) {
    await this.p.setStatus(a, id, 'cancelled', requestMeta(r));
  }

  @Post('purchase-orders/:id/receive')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('inventory:manage')
  async receive(
    @CurrentAuth() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(receiveSchema)) b: z.infer<typeof receiveSchema>,
    @Req() r: Request,
  ) {
    await this.p.receive(a, id, b, requestMeta(r));
  }

  @Get('stock-transfers')
  @RequirePermission('inventory:read')
  transfers(
    @CurrentAuth() a: AuthContext,
    @Query(new ZodValidationPipe(branchQuery)) q: z.infer<typeof branchQuery>,
  ) {
    return this.p.transfers(a, q.branchId);
  }

  @Post('stock-transfers')
  @RequirePermission('inventory:manage')
  transfer(
    @CurrentAuth() a: AuthContext,
    @Body(new ZodValidationPipe(transferSchema)) b: z.infer<typeof transferSchema>,
    @Req() r: Request,
  ) {
    return this.p.transfer(a, b, requestMeta(r));
  }

  @Get('recipes')
  @RequirePermission('menu:read')
  recipes(
    @CurrentAuth() a: AuthContext,
    @Query(new ZodValidationPipe(restaurantQuery)) q: z.infer<typeof restaurantQuery>,
  ) {
    return this.p.recipes(a, q.restaurantId);
  }

  @Put('recipes/:menuItemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('menu:manage')
  async setRecipe(
    @CurrentAuth() a: AuthContext,
    @Param('menuItemId', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(recipeSchema)) b: z.infer<typeof recipeSchema>,
    @Req() r: Request,
  ) {
    await this.p.setRecipe(a, id, b, requestMeta(r));
  }
}
