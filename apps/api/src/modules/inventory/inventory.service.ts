import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { likeTerm, runPaged } from '../../common/pagination/paged';
import { type Db, DbContext } from '../../core/db/db-context';
import { accessibleBranches, hasPermission } from '../auth/access';
import { CacheEntry, CacheNs } from '../../shared/cache/cache.keys';
import { CacheService } from '../../shared/cache/cache.service';
import { AccessService } from '../auth/access.service';
import type { AuthContext, BranchRef, RequestMeta, TenantAccess } from '../auth/auth.types';
import { writeAudit } from '../auth/user-tokens';
import type {
  CreateStockItemInput,
  ListMovementsQuery,
  ListStockQuery,
  MovementInput,
  UpdateStockItemInput,
} from './inventory.schemas';
import { dayFrom, dayTo } from '../orders/orders.service';

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
    private readonly cache: CacheService,
  ) {}

  /** Header data for the inventory screen: branch, permissions and stock counts (no rows). */
  summary(auth: AuthContext, branchId?: string) {
    return this.run(auth, async (db, access) => {
      const { branch, branches } = this.readableBranch(access, branchId);
      // Branch access is checked above; the aggregate for that branch is cached, the caller's
      // branch list and permissions are not.
      const data = await this.cache.getOrLoad(
        CacheNs.inventory(auth.tenantId!, branch.restaurantId),
        CacheEntry.inventorySummary(branch.id),
        this.cache.ttl('inventorySummary'),
        () => this.loadSummary(db, branch),
      );
      return {
        restaurant: data.restaurant,
        branch: { id: branch.id, name: branch.name },
        branches: branches
          .filter((b) => b.restaurantId === branch.restaurantId)
          .map((b) => ({ id: b.id, name: b.name })),
        counts: data.counts,
        stockValueMinor: data.stockValueMinor,
        categories: data.categories,
        canManageItems: hasPermission(access, 'inventory:manage', {
          restaurantId: branch.restaurantId,
        }),
        canRecordMovements: hasPermission(access, 'inventory:manage', { branchId: branch.id }),
      };
    });
  }

  private async loadSummary(db: Db, branch: BranchRef) {
    const restaurant = await db.one<{ id: string; name: string; currency_code: string }>(
      'SELECT id, name, currency_code FROM restaurants WHERE id = $1',
      [branch.restaurantId],
    );
    const c = await db.one<{
      total: string;
      low: string;
      out: string;
      value: string | null;
      categories: string[] | null;
    }>(
      `SELECT count(*) AS total,
                count(*) FILTER (WHERE coalesce(s.quantity, 0) > 0 AND coalesce(s.quantity, 0) <= i.low_stock_threshold) AS low,
                count(*) FILTER (WHERE coalesce(s.quantity, 0) <= 0) AS out,
                sum(coalesce(s.quantity, 0) * i.cost_per_unit_minor) AS value,
                array_agg(DISTINCT i.category) FILTER (WHERE i.category IS NOT NULL) AS categories
           FROM inventory_items i
           LEFT JOIN inventory_stock s ON s.item_id = i.id AND s.branch_id = $2
          WHERE i.restaurant_id = $1 AND i.deleted_at IS NULL`,
      [branch.restaurantId, branch.id],
    );
    return {
      restaurant: restaurant && {
        id: restaurant.id,
        name: restaurant.name,
        currencyCode: restaurant.currency_code.trim(),
      },
      counts: {
        total: Number(c?.total ?? 0),
        low: Number(c?.low ?? 0),
        out: Number(c?.out ?? 0),
      },
      stockValueMinor: Math.round(Number(c?.value ?? 0)),
      categories: (c?.categories ?? []).sort(),
    };
  }

  /** Paged stock items with quantities at one branch. */
  listStock(auth: AuthContext, query: ListStockQuery) {
    return this.run(auth, async (db, access) => {
      const { branch } = this.readableBranch(access, query.branchId);
      const qty = 'coalesce(s.quantity, 0)';
      const where = ['i.restaurant_id = $1', 'i.deleted_at IS NULL'];
      const params: unknown[] = [branch.restaurantId, branch.id];
      const add = (sql: string, v: unknown) => {
        params.push(v);
        where.push(sql.split('?').join('$' + params.length));
      };
      if (query.status === 'out') where.push(`${qty} <= 0`);
      if (query.status === 'low') where.push(`${qty} > 0 AND ${qty} <= i.low_stock_threshold`);
      if (query.status === 'ok') where.push(`${qty} > i.low_stock_threshold`);
      if (query.category) add('i.category = ?', query.category);
      if (query.search) add('(i.name ILIKE ? OR i.category ILIKE ?)', likeTerm(query.search));
      return runPaged<StockRow, unknown>(db, {
        select: `i.id, i.name, i.category, i.unit, i.low_stock_threshold, i.cost_per_unit_minor,
                 i.is_active, s.quantity, s.updated_at AS stock_updated_at`,
        from: 'inventory_items i LEFT JOIN inventory_stock s ON s.item_id = i.id AND s.branch_id = $2',
        where,
        params,
        sortColumns: {
          name: 'lower(i.name)',
          quantity: qty,
          category: "lower(coalesce(i.category, ''))",
          value: `${qty} * coalesce(i.cost_per_unit_minor, 0)`,
        },
        tiebreak: 'i.id',
        query,
        map: stockDto,
      });
    });
  }

  /** Paged stock movement log (stock adjustments) for one branch. */
  listMovements(auth: AuthContext, query: ListMovementsQuery) {
    return this.run(auth, async (db, access) => {
      const { branch } = this.readableBranch(access, query.branchId);
      const where = ['m.branch_id = $1'];
      const params: unknown[] = [branch.id];
      const add = (sql: string, v: unknown) => {
        params.push(v);
        where.push(sql.split('?').join('$' + params.length));
      };
      if (query.type) add('m.type = ?', query.type);
      if (query.itemId) add('m.item_id = ?', query.itemId);
      // Local-day bounds in the branch time zone, compared to the raw timestamp so the
      // (tenant_id, branch_id, created_at) index serves the range (see orders dayFrom / dayTo).
      if (query.from) add(dayFrom('m.created_at', '$1'), query.from);
      if (query.to) add(dayTo('m.created_at', '$1'), query.to);
      if (query.search) add('(i.name ILIKE ? OR m.note ILIKE ?)', likeTerm(query.search));
      return runPaged<MovementRow, unknown>(db, {
        select: `m.id, m.item_id, i.name AS item_name, i.unit, m.type, m.quantity_delta, m.quantity_after,
                 m.note, m.created_at, u.full_name AS by_name`,
        from: `inventory_movements m JOIN inventory_items i ON i.id = m.item_id
               JOIN branches b ON b.id = m.branch_id LEFT JOIN users u ON u.id = m.created_by`,
        where,
        params,
        sortColumns: { createdAt: 'm.created_at', quantity: 'abs(m.quantity_delta)' },
        tiebreak: 'm.id',
        cursor: { types: { createdAt: 'timestamptz', quantity: 'numeric' }, tiebreakType: 'uuid' },
        query,
        map: (r) => ({
          id: r.id,
          itemId: r.item_id,
          itemName: r.item_name,
          unit: r.unit,
          type: r.type,
          quantityDelta: Number(r.quantity_delta),
          quantityAfter: Number(r.quantity_after),
          note: r.note,
          byName: r.by_name,
          createdAt: new Date(r.created_at).toISOString(),
        }),
      });
    });
  }

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
      this.inventoryChanged(db, restaurantId);
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
      this.inventoryChanged(db, item.restaurant_id);
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

  private readableBranch(access: TenantAccess, branchId?: string) {
    const branches = accessibleBranches(access).filter((b) =>
      hasPermission(access, 'inventory:read', { branchId: b.id }),
    );
    if (branches.length === 0) throw forbidden('You cannot view stock.');
    const branch = branchId ? branches.find((b) => b.id === branchId) : branches[0];
    if (!branch) throw forbidden('You cannot view stock for this branch.');
    return { branch, branches };
  }

  private run<T>(auth: AuthContext, work: (db: Db, access: TenantAccess) => Promise<T>) {
    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, async (db) =>
      work(db, await this.access.forRequest(db, auth)),
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
    this.inventoryChanged(db, row.restaurant_id);
    return row;
  }

  /** Invalidates the restaurant's inventory aggregates once the write commits (not on rollback). */
  private inventoryChanged(db: Db, restaurantId: string): void {
    this.cache.invalidateAfterCommit(db, CacheNs.inventory(db.tenantId(), restaurantId));
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

interface StockRow {
  id: string;
  name: string;
  category: string | null;
  unit: string;
  low_stock_threshold: string;
  cost_per_unit_minor: string | null;
  is_active: boolean;
  quantity: string | null;
  stock_updated_at: Date | null;
}

interface MovementRow {
  id: string;
  item_id: string;
  item_name: string;
  unit: string;
  type: string;
  quantity_delta: string;
  quantity_after: string;
  note: string | null;
  created_at: Date;
  by_name: string | null;
}

function stockDto(r: StockRow) {
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
}
