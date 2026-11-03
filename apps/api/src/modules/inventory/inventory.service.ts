import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type Db, DbContext } from '../../core/db/db-context';
import { accessibleBranches, hasPermission } from '../auth/access';
import { AccessService } from '../auth/access.service';
import type { AuthContext, BranchRef, RequestMeta, TenantAccess } from '../auth/auth.types';
import { writeAudit } from '../auth/user-tokens';
import type {
  CreateStockItemInput,
  MovementInput,
  UpdateStockItemInput,
} from './inventory.schemas';

const forbidden = (message = 'You cannot manage this stock.') =>
  new ForbiddenException({ code: 'INVENTORY_FORBIDDEN', message });
const notFound = (what: string) =>
  new NotFoundException({ code: 'INVENTORY_NOT_FOUND', message: `${what} not found.` });

/**
 * Stock items are shared by a restaurant; quantities live per branch. Viewing or moving stock
 * needs the permission for that branch; editing the item list needs it restaurant-wide.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly db: DbContext,
    private readonly access: AccessService,
  ) {}

  overview(auth: AuthContext, branchId?: string) {
    return this.run(auth, async (db, access) => {
      const branches = accessibleBranches(access).filter((b) =>
        hasPermission(access, 'inventory:read', { branchId: b.id }),
      );
      if (branches.length === 0) throw forbidden('You cannot view stock.');
      const branch = branchId ? branches.find((b) => b.id === branchId) : branches[0];
      if (!branch) throw forbidden('You cannot view stock for this branch.');

      const restaurant = await db.one<{ id: string; name: string; currency_code: string }>(
        'SELECT id, name, currency_code FROM restaurants WHERE id = $1',
        [branch.restaurantId],
      );
      const rows = await db.query<{
        id: string;
        name: string;
        category: string | null;
        unit: string;
        low_stock_threshold: string;
        cost_per_unit_minor: string | null;
        is_active: boolean;
        quantity: string | null;
        stock_updated_at: Date | null;
      }>(
        `SELECT i.id, i.name, i.category, i.unit, i.low_stock_threshold, i.cost_per_unit_minor,
                i.is_active, s.quantity, s.updated_at AS stock_updated_at
           FROM inventory_items i
           LEFT JOIN inventory_stock s ON s.item_id = i.id AND s.branch_id = $2
          WHERE i.restaurant_id = $1 AND i.deleted_at IS NULL
          ORDER BY lower(coalesce(i.category, '')), lower(i.name)`,
        [branch.restaurantId, branch.id],
      );
      return {
        restaurant: restaurant && {
          id: restaurant.id,
          name: restaurant.name,
          currencyCode: restaurant.currency_code.trim(),
        },
        branch: { id: branch.id, name: branch.name },
        branches: branches
          .filter((b) => b.restaurantId === branch.restaurantId)
          .map((b) => ({ id: b.id, name: b.name })),
        items: rows.map((r) => {
          const quantity = Number(r.quantity ?? 0);
          const threshold = Number(r.low_stock_threshold);
          return {
            id: r.id,
            name: r.name,
            category: r.category,
            unit: r.unit,
            lowStockThreshold: threshold,
            costPerUnitMinor: r.cost_per_unit_minor === null ? null : Number(r.cost_per_unit_minor),
            isActive: r.is_active,
            quantity,
            status: quantity <= 0 ? 'out' : quantity <= threshold ? 'low' : 'ok',
            stockUpdatedAt: r.stock_updated_at ? new Date(r.stock_updated_at).toISOString() : null,
          };
        }),
        canManageItems: hasPermission(access, 'inventory:manage', {
          restaurantId: branch.restaurantId,
        }),
        canRecordMovements: hasPermission(access, 'inventory:manage', { branchId: branch.id }),
      };
    });
  }

  createItem(auth: AuthContext, input: CreateStockItemInput, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      const restaurantId = this.restaurantForItems(access, input.restaurantId);
      const row = await this.unique(() =>
        db.one<{ id: string }>(
          `INSERT INTO inventory_items (tenant_id, restaurant_id, name, category, unit,
                                        low_stock_threshold, cost_per_unit_minor, currency_code,
                                        created_by, updated_by)
           SELECT $1, r.id, $3, $4, $5, $6, $7, r.currency_code, $8, $8
             FROM restaurants r WHERE r.id = $2
           RETURNING id`,
          [
            auth.tenantId,
            restaurantId,
            input.name,
            input.category || null,
            input.unit,
            input.lowStockThreshold ?? 0,
            input.costPerUnitMinor ?? null,
            auth.userId,
          ],
        ),
      );
      if (!row) throw notFound('Restaurant');
      await this.audit(db, auth, meta, 'inventory.item_created', row.id, { name: input.name });
      return { id: row.id };
    });
  }

  updateItem(auth: AuthContext, id: string, input: UpdateStockItemInput, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      await this.itemForManage(db, access, id);
      await this.unique(() =>
        db.query(
          `UPDATE inventory_items SET
              name = coalesce($2, name),
              category = CASE WHEN $3 THEN $4 ELSE category END,
              unit = coalesce($5, unit),
              low_stock_threshold = coalesce($6, low_stock_threshold),
              cost_per_unit_minor = CASE WHEN $7 THEN $8 ELSE cost_per_unit_minor END,
              is_active = coalesce($9, is_active),
              updated_by = $10, updated_at = now(), version = version + 1
            WHERE id = $1`,
          [
            id,
            input.name ?? null,
            'category' in input,
            input.category || null,
            input.unit ?? null,
            input.lowStockThreshold ?? null,
            'costPerUnitMinor' in input,
            input.costPerUnitMinor ?? null,
            input.isActive ?? null,
            auth.userId,
          ],
        ),
      );
      await this.audit(db, auth, meta, 'inventory.item_updated', id, input);
    });
  }

  deleteItem(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      const item = await this.itemForManage(db, access, id);
      await db.query(
        'UPDATE inventory_items SET deleted_at = now(), updated_by = $2 WHERE id = $1',
        [id, auth.userId],
      );
      await this.audit(db, auth, meta, 'inventory.item_deleted', id, { name: item.name });
    });
  }

  recordMovement(auth: AuthContext, itemId: string, input: MovementInput, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      const branch = access.allBranches.find((b) => b.id === input.branchId);
      if (!branch || !hasPermission(access, 'inventory:manage', { branchId: branch.id })) {
        throw forbidden();
      }
      const item = await db.one<{ id: string; name: string; restaurant_id: string }>(
        'SELECT id, name, restaurant_id FROM inventory_items WHERE id = $1 AND deleted_at IS NULL',
        [itemId],
      );
      if (!item) throw notFound('Stock item');
      if (item.restaurant_id !== branch.restaurantId) {
        throw new BadRequestException({
          code: 'ITEM_OTHER_RESTAURANT',
          message: 'This item belongs to another restaurant.',
        });
      }

      // Lock the stock row so concurrent movements serialize.
      await db.query(
        `INSERT INTO inventory_stock (tenant_id, branch_id, item_id) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [auth.tenantId, branch.id, itemId],
      );
      const stock = await db.one<{ quantity: string }>(
        `SELECT quantity FROM inventory_stock WHERE branch_id = $1 AND item_id = $2 FOR UPDATE`,
        [branch.id, itemId],
      );
      const before = Number(stock!.quantity);
      const delta =
        input.type === 'count'
          ? input.quantity - before
          : input.type === 'purchase'
            ? input.quantity
            : -input.quantity;
      const after = round3(before + delta);
      if (after < 0) {
        throw new ConflictException({
          code: 'INSUFFICIENT_STOCK',
          message: `Only ${before} in stock at ${branch.name}.`,
        });
      }

      await db.query(
        `UPDATE inventory_stock SET quantity = $3, updated_at = now()
          WHERE branch_id = $1 AND item_id = $2`,
        [branch.id, itemId, after],
      );
      const movement = await db.one<{ id: string }>(
        `INSERT INTO inventory_movements (tenant_id, branch_id, item_id, type, quantity_delta,
                                          quantity_after, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          auth.tenantId,
          branch.id,
          itemId,
          input.type,
          round3(delta),
          after,
          input.note || null,
          auth.userId,
        ],
      );
      await this.audit(db, auth, meta, `inventory.${input.type}`, itemId, {
        branchId: branch.id,
        delta: round3(delta),
        after,
      });
      return { id: movement!.id, quantity: after };
    });
  }

  history(auth: AuthContext, itemId: string, branchId: string) {
    return this.run(auth, async (db, access) => {
      if (!hasPermission(access, 'inventory:read', { branchId })) {
        throw forbidden('You cannot view stock for this branch.');
      }
      const rows = await db.query<{
        id: string;
        type: string;
        quantity_delta: string;
        quantity_after: string;
        note: string | null;
        created_at: Date;
        by_name: string | null;
      }>(
        `SELECT m.id, m.type, m.quantity_delta, m.quantity_after, m.note, m.created_at,
                u.full_name AS by_name
           FROM inventory_movements m LEFT JOIN users u ON u.id = m.created_by
          WHERE m.item_id = $1 AND m.branch_id = $2
          ORDER BY m.created_at DESC LIMIT 50`,
        [itemId, branchId],
      );
      return rows.map((r) => ({
        id: r.id,
        type: r.type,
        quantityDelta: Number(r.quantity_delta),
        quantityAfter: Number(r.quantity_after),
        note: r.note,
        createdAt: new Date(r.created_at).toISOString(),
        byName: r.by_name,
      }));
    });
  }

  // ---- helpers ----

  private run<T>(auth: AuthContext, work: (db: Db, access: TenantAccess) => Promise<T>) {
    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, async (db) =>
      work(db, await this.access.tenantAccess(db, auth.membershipId!)),
    );
  }

  private restaurantForItems(access: TenantAccess, restaurantId?: string): string {
    const allowed = restaurantsOf(access.allBranches).filter((id) =>
      hasPermission(access, 'inventory:manage', { restaurantId: id }),
    );
    if (allowed.length === 0) {
      throw forbidden('Only restaurant-wide managers can change the stock item list.');
    }
    if (!restaurantId) {
      if (allowed.length > 1) {
        throw new BadRequestException({
          code: 'RESTAURANT_REQUIRED',
          message: 'Choose a restaurant.',
        });
      }
      return allowed[0]!;
    }
    if (!allowed.includes(restaurantId)) throw forbidden();
    return restaurantId;
  }

  private async itemForManage(db: Db, access: TenantAccess, id: string) {
    const row = await db.one<{ id: string; name: string; restaurant_id: string }>(
      'SELECT id, name, restaurant_id FROM inventory_items WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    if (!row) throw notFound('Stock item');
    if (!hasPermission(access, 'inventory:manage', { restaurantId: row.restaurant_id })) {
      throw forbidden('Only restaurant-wide managers can change the stock item list.');
    }
    return row;
  }

  private async unique<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new ConflictException({
          code: 'STOCK_ITEM_EXISTS',
          message: 'A stock item with this name already exists.',
        });
      }
      throw e;
    }
  }

  private audit(
    db: Db,
    auth: AuthContext,
    meta: RequestMeta,
    action: string,
    entityId: string,
    metadata: object,
  ) {
    return writeAudit(db, {
      action,
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      actorSessionId: auth.sessionId,
      actorAudience: 'tenant',
      entityType: 'inventory_item',
      entityId,
      metadata: metadata as Record<string, unknown>,
      ...meta,
    });
  }
}

function restaurantsOf(branches: BranchRef[]): string[] {
  return [...new Set(branches.map((b) => b.restaurantId))];
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
