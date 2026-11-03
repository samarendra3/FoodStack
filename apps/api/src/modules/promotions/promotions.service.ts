import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type Db, DbContext } from '../../core/db/db-context';
import { hasPermission } from '../auth/access';
import { AccessService } from '../auth/access.service';
import type { AuthContext, RequestMeta, TenantAccess } from '../auth/auth.types';
import { writeAudit } from '../auth/user-tokens';
import { type CartLine, type Channel, type EnginePromotion, quote } from './discount-engine';
import {
  type CreatePromotionInput,
  type PromotionShape,
  promotionProblems,
  type QuoteInput,
  type UpdatePromotionInput,
} from './promotions.schemas';

export type PromotionState = 'active' | 'scheduled' | 'expired' | 'paused';

interface Row {
  id: string;
  restaurant_id: string;
  name: string;
  description: string | null;
  type: EnginePromotion['type'];
  scope: EnginePromotion['scope'];
  value: number;
  buy_quantity: number | null;
  get_quantity: number | null;
  coupon_code: string | null;
  min_order_minor: string | null;
  max_discount_minor: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  days_of_week: number[] | null;
  time_from: string | null;
  time_to: string | null;
  channels: Channel[];
  stackable: boolean;
  usage_limit_total: number | null;
  usage_limit_per_customer: number | null;
  status: 'active' | 'paused';
  updated_at: Date;
  item_ids: string[];
  category_ids: string[];
  branch_ids: string[];
}

const SELECT = `
  SELECT p.*,
    coalesce((SELECT array_agg(menu_item_id) FROM promotion_items x WHERE x.promotion_id = p.id), '{}') AS item_ids,
    coalesce((SELECT array_agg(category_id) FROM promotion_categories x WHERE x.promotion_id = p.id), '{}') AS category_ids,
    coalesce((SELECT array_agg(branch_id) FROM promotion_branches x WHERE x.promotion_id = p.id), '{}') AS branch_ids
  FROM promotions p`;

const forbidden = (message = 'You cannot manage promotions.') =>
  new ForbiddenException({ code: 'PROMOTION_FORBIDDEN', message });
const invalid = (message: string) =>
  new BadRequestException({ code: 'PROMOTION_INVALID', message });

/**
 * Promotions and the server-side discount quote. `quoteInTx` takes the caller's transaction so the
 * orders module can price an order with the same engine and data it commits.
 */
@Injectable()
export class PromotionsService {
  constructor(
    private readonly db: DbContext,
    private readonly access: AccessService,
  ) {}

  list(auth: AuthContext) {
    return this.run(auth, async (db, access) => {
      const restaurants = this.restaurants(access, 'promotion:read');
      const rows = await db.query<Row>(
        `${SELECT} WHERE p.restaurant_id = ANY($1::uuid[]) AND p.deleted_at IS NULL
          ORDER BY p.created_at DESC`,
        [restaurants],
      );
      return {
        promotions: rows.map(toDto),
        canManage: restaurants.some((r) =>
          hasPermission(access, 'promotion:manage', { restaurantId: r }),
        ),
      };
    });
  }

  get(auth: AuthContext, id: string) {
    return this.run(auth, async (db, access) => {
      const row = await this.load(db, id);
      if (!this.restaurants(access, 'promotion:read').includes(row.restaurant_id))
        throw forbidden();
      return {
        ...toDto(row),
        canManage: hasPermission(access, 'promotion:manage', { restaurantId: row.restaurant_id }),
      };
    });
  }

  create(auth: AuthContext, input: CreatePromotionInput, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      const options = this.restaurants(access, 'promotion:manage');
      if (options.length === 0) throw forbidden();
      const restaurantId = input.restaurantId ?? (options.length === 1 ? options[0] : undefined);
      if (!restaurantId) throw invalid('Choose a restaurant.');
      if (!options.includes(restaurantId)) throw forbidden();
      await this.checkLinks(db, restaurantId, input);

      const row = await this.unique(() =>
        db.one<{ id: string }>(
          `INSERT INTO promotions (tenant_id, restaurant_id, name, description, type, scope, value,
             buy_quantity, get_quantity, coupon_code, min_order_minor, max_discount_minor, starts_at,
             ends_at, days_of_week, time_from, time_to, channels, stackable, usage_limit_total,
             usage_limit_per_customer, status, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$23)
           RETURNING id`,
          [auth.tenantId, restaurantId, ...columns(input), auth.userId],
        ),
      );
      await this.replaceLinks(db, auth.tenantId!, row!.id, input);
      await this.audit(db, auth, meta, 'promotion.created', row!.id, {
        name: input.name,
        type: input.type,
      });
      return { id: row!.id };
    });
  }

  update(auth: AuthContext, id: string, input: UpdatePromotionInput, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      const current = await this.load(db, id, true);
      if (!hasPermission(access, 'promotion:manage', { restaurantId: current.restaurant_id }))
        throw forbidden();
      const merged: PromotionShape = { ...shapeOf(current), ...input };
      const problem = promotionProblems(merged);
      if (problem) throw invalid(problem);
      await this.checkLinks(db, current.restaurant_id, merged);

      await this.unique(() =>
        db.query(
          `UPDATE promotions SET name=$2, description=$3, type=$4, scope=$5, value=$6,
             buy_quantity=$7, get_quantity=$8, coupon_code=$9, min_order_minor=$10,
             max_discount_minor=$11, starts_at=$12, ends_at=$13, days_of_week=$14, time_from=$15,
             time_to=$16, channels=$17, stackable=$18, usage_limit_total=$19,
             usage_limit_per_customer=$20, status=$21, updated_by=$22, updated_at=now(),
             version=version+1
           WHERE id=$1`,
          [id, ...columns(merged), auth.userId],
        ),
      );
      if ('itemIds' in input || 'categoryIds' in input || 'branchIds' in input) {
        await this.replaceLinks(db, auth.tenantId!, id, merged);
      }
      await this.audit(db, auth, meta, 'promotion.updated', id, input);
    });
  }

  remove(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      const current = await this.load(db, id);
      if (!hasPermission(access, 'promotion:manage', { restaurantId: current.restaurant_id }))
        throw forbidden();
      await db.query('UPDATE promotions SET deleted_at = now(), updated_by = $2 WHERE id = $1', [
        id,
        auth.userId,
      ]);
      await this.audit(db, auth, meta, 'promotion.deleted', id, { name: current.name });
    });
  }

  /** POS price check: discounts for a cart at a branch, computed from database prices. */
  quote(auth: AuthContext, input: QuoteInput) {
    return this.run(auth, async (db, access) => {
      const allowed =
        hasPermission(access, 'pos:access', { branchId: input.branchId }) ||
        hasPermission(access, 'waiter:access', { branchId: input.branchId }) ||
        hasPermission(access, 'promotion:read', { branchId: input.branchId });
      if (!allowed || !access.allBranches.some((b) => b.id === input.branchId)) {
        throw forbidden('You cannot take orders at this branch.');
      }
      return this.quoteInTx(db, input);
    });
  }

  /** Prices a cart inside an existing transaction (also used by orders). */
  async quoteInTx(db: Db, input: QuoteInput) {
    const branch = await db.one<{ restaurant_id: string; dow: number; local_time: string }>(
      `SELECT restaurant_id, extract(dow FROM now() AT TIME ZONE timezone)::int AS dow,
              to_char(now() AT TIME ZONE timezone, 'HH24:MI:SS') AS local_time
         FROM branches WHERE id = $1`,
      [input.branchId],
    );
    if (!branch)
      throw new NotFoundException({ code: 'BRANCH_NOT_FOUND', message: 'Branch not found.' });

    const ids = [...new Set(input.lines.map((l) => l.menuItemId))];
    const items = await db.query<{
      id: string;
      category_id: string;
      price_minor: string;
      is_available: boolean;
    }>(
      `SELECT i.id, i.category_id, i.price_minor, i.is_available
         FROM menu_items i JOIN menu_categories c ON c.id = i.category_id
        WHERE i.id = ANY($1::uuid[]) AND i.restaurant_id = $2
          AND i.deleted_at IS NULL AND c.deleted_at IS NULL AND c.is_active`,
      [ids, branch.restaurant_id],
    );
    const byId = new Map(items.map((i) => [i.id, i]));
    const missing = ids.filter((id) => !byId.get(id));
    if (missing.length)
      throw invalid('Some items are no longer on the menu. Refresh and try again.');
    if (items.some((i) => !i.is_available)) throw invalid('Some items are sold out.');

    const lines: CartLine[] = input.lines.map((l) => {
      const i = byId.get(l.menuItemId)!;
      return {
        menuItemId: i.id,
        categoryId: i.category_id,
        unitPriceMinor: Number(i.price_minor),
        quantity: l.quantity,
      };
    });
    const promotions = (
      await db.query<Row>(`${SELECT} WHERE p.restaurant_id = $1 AND p.deleted_at IS NULL`, [
        branch.restaurant_id,
      ])
    ).map(toEngine);

    return quote(lines, promotions, {
      now: new Date(),
      localDay: branch.dow,
      localTime: branch.local_time,
      branchId: input.branchId,
      channel: input.channel,
      couponCode: input.couponCode ?? null,
    });
  }

  // ---- helpers ----

  private run<T>(auth: AuthContext, work: (db: Db, access: TenantAccess) => Promise<T>) {
    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, async (db) =>
      work(db, await this.access.tenantAccess(db, auth.membershipId!)),
    );
  }

  /** Restaurants where the caller holds `perm`; a branch grant counts for reading only. */
  private restaurants(access: TenantAccess, perm: 'promotion:read' | 'promotion:manage'): string[] {
    return [...new Set(access.allBranches.map((b) => b.restaurantId))].filter(
      (r) =>
        hasPermission(access, perm, { restaurantId: r }) ||
        (perm === 'promotion:read' &&
          access.allBranches.some(
            (b) => b.restaurantId === r && access.byBranch[b.id]?.includes(perm),
          )),
    );
  }

  private async load(db: Db, id: string, lock = false): Promise<Row> {
    const row = await db.one<Row>(
      `${SELECT} WHERE p.id = $1 AND p.deleted_at IS NULL${lock ? ' FOR UPDATE OF p' : ''}`,
      [id],
    );
    if (!row)
      throw new NotFoundException({ code: 'PROMOTION_NOT_FOUND', message: 'Promotion not found.' });
    return row;
  }

  /** Linked items, categories and branches must belong to the promotion's restaurant. */
  private async checkLinks(
    db: Db,
    restaurantId: string,
    p: Pick<PromotionShape, 'itemIds' | 'categoryIds' | 'branchIds'>,
  ) {
    const count = async (table: string, ids: string[], extra = 'AND deleted_at IS NULL') => {
      if (ids.length === 0) return 0;
      const r = await db.one<{ n: string }>(
        `SELECT count(*) AS n FROM ${table} WHERE id = ANY($1::uuid[]) AND restaurant_id = $2 ${extra}`,
        [ids, restaurantId],
      );
      return Number(r?.n ?? 0);
    };
    const uniq = (a: string[]) => [...new Set(a)];
    if ((await count('menu_items', uniq(p.itemIds))) !== uniq(p.itemIds).length)
      throw invalid('Some selected items do not exist.');
    if ((await count('menu_categories', uniq(p.categoryIds))) !== uniq(p.categoryIds).length)
      throw invalid('Some selected categories do not exist.');
    if ((await count('branches', uniq(p.branchIds), '')) !== uniq(p.branchIds).length)
      throw invalid('Some selected branches do not exist.');
  }

  private async replaceLinks(
    db: Db,
    tenantId: string,
    id: string,
    p: Pick<PromotionShape, 'itemIds' | 'categoryIds' | 'branchIds'>,
  ) {
    const sets: [string, string, string[]][] = [
      ['promotion_items', 'menu_item_id', p.itemIds],
      ['promotion_categories', 'category_id', p.categoryIds],
      ['promotion_branches', 'branch_id', p.branchIds],
    ];
    for (const [table, column, ids] of sets) {
      await db.query(`DELETE FROM ${table} WHERE promotion_id = $1`, [id]);
      if (ids.length) {
        await db.query(
          `INSERT INTO ${table} (tenant_id, promotion_id, ${column})
           SELECT $1, $2, unnest($3::uuid[]) ON CONFLICT DO NOTHING`,
          [tenantId, id, [...new Set(ids)]],
        );
      }
    }
  }

  private async unique<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new ConflictException({
          code: 'COUPON_EXISTS',
          message: 'Another promotion already uses this coupon code.',
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
    id: string,
    metadata: object,
  ) {
    return writeAudit(db, {
      action,
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      actorSessionId: auth.sessionId,
      actorAudience: 'tenant',
      entityType: 'promotion',
      entityId: id,
      metadata: metadata as Record<string, unknown>,
      ...meta,
    });
  }
}

// ---- mapping ----

function columns(p: PromotionShape) {
  return [
    p.name,
    p.description || null,
    p.type,
    p.scope,
    p.value,
    p.type === 'bogo' ? p.buyQuantity : null,
    p.type === 'bogo' ? p.getQuantity : null,
    p.couponCode ? p.couponCode.toUpperCase() : null,
    p.minOrderMinor,
    p.maxDiscountMinor,
    p.startsAt,
    p.endsAt,
    p.daysOfWeek?.length ? [...new Set(p.daysOfWeek)].sort() : null,
    p.timeFrom,
    p.timeTo,
    [...new Set(p.channels)],
    p.stackable,
    p.usageLimitTotal,
    p.usageLimitPerCustomer,
    p.status,
  ];
}

const num = (v: string | null) => (v === null ? null : Number(v));
const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);

function shapeOf(r: Row): PromotionShape {
  return {
    name: r.name,
    description: r.description,
    type: r.type,
    scope: r.scope,
    value: r.value,
    buyQuantity: r.buy_quantity,
    getQuantity: r.get_quantity,
    couponCode: r.coupon_code,
    minOrderMinor: num(r.min_order_minor),
    maxDiscountMinor: num(r.max_discount_minor),
    startsAt: r.starts_at ? new Date(r.starts_at).toISOString() : null,
    endsAt: r.ends_at ? new Date(r.ends_at).toISOString() : null,
    daysOfWeek: r.days_of_week,
    timeFrom: hhmm(r.time_from),
    timeTo: hhmm(r.time_to),
    channels: r.channels,
    branchIds: r.branch_ids,
    itemIds: r.item_ids,
    categoryIds: r.category_ids,
    stackable: r.stackable,
    usageLimitTotal: r.usage_limit_total,
    usageLimitPerCustomer: r.usage_limit_per_customer,
    status: r.status,
  };
}

export function stateOf(
  r: { status: string; starts_at: Date | null; ends_at: Date | null },
  now = new Date(),
): PromotionState {
  if (r.status === 'paused') return 'paused';
  if (r.ends_at && now >= new Date(r.ends_at)) return 'expired';
  if (r.starts_at && now < new Date(r.starts_at)) return 'scheduled';
  return 'active';
}

function toDto(r: Row) {
  return {
    id: r.id,
    restaurantId: r.restaurant_id,
    ...shapeOf(r),
    state: stateOf(r),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

function toEngine(r: Row): EnginePromotion {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    scope: r.scope,
    value: r.value,
    buyQuantity: r.buy_quantity,
    getQuantity: r.get_quantity,
    couponCode: r.coupon_code,
    minOrderMinor: num(r.min_order_minor),
    maxDiscountMinor: num(r.max_discount_minor),
    startsAt: r.starts_at ? new Date(r.starts_at) : null,
    endsAt: r.ends_at ? new Date(r.ends_at) : null,
    daysOfWeek: r.days_of_week,
    timeFrom: r.time_from,
    timeTo: r.time_to,
    channels: r.channels,
    branchIds: r.branch_ids,
    itemIds: r.item_ids,
    categoryIds: r.category_ids,
    stackable: r.stackable,
    status: r.status,
  };
}
