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
import type {
  CreateCategoryInput,
  CreateItemInput,
  ImportInput,
  UpdateCategoryInput,
  UpdateItemInput,
} from './menu.schemas';

export interface MenuCategory {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  itemCount: number;
}

export interface MenuItem {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  priceMinor: number;
  currencyCode: string;
  diet: 'veg' | 'non_veg' | 'egg';
  imageUrl: string | null;
  isAvailable: boolean;
  sortOrder: number;
  updatedAt: string;
}

export interface MenuVariant {
  id: string;
  name: string;
  priceMinor: number;
}

interface Restaurant {
  id: string;
  name: string;
  currency_code: string;
}

type Perm = 'menu:read' | 'menu:manage';

const forbidden = () =>
  new ForbiddenException({ code: 'MENU_FORBIDDEN', message: 'You cannot change this menu.' });
const notFound = (what: string) =>
  new NotFoundException({ code: 'MENU_NOT_FOUND', message: `${what} not found.` });

/**
 * Restaurant menus. Runs in the caller's tenant RLS context. A permission granted for one
 * branch counts for its restaurant's menu, since every branch sells that restaurant's menu.
 */
@Injectable()
export class MenuService {
  constructor(
    private readonly db: DbContext,
    private readonly access: AccessService,
  ) {}

  get(auth: AuthContext, restaurantId?: string) {
    return this.run(auth, async (db, access) => {
      const restaurant = await this.restaurant(db, access, 'menu:read', restaurantId);
      const categories = await db.query<{
        id: string;
        name: string;
        sort_order: number;
        is_active: boolean;
        item_count: string;
      }>(
        `SELECT c.id, c.name, c.sort_order, c.is_active,
                (SELECT count(*) FROM menu_items i
                  WHERE i.category_id = c.id AND i.deleted_at IS NULL) AS item_count
           FROM menu_categories c
          WHERE c.restaurant_id = $1 AND c.deleted_at IS NULL
          ORDER BY c.sort_order, lower(c.name)`,
        [restaurant.id],
      );
      const items = await db.query<ItemRow>(
        `${ITEM_SELECT} WHERE restaurant_id = $1 AND deleted_at IS NULL
          ORDER BY sort_order, lower(name)`,
        [restaurant.id],
      );
      const variantRows = await db.query<{
        id: string;
        menu_item_id: string;
        name: string;
        price_minor: string;
      }>(
        `SELECT v.id, v.menu_item_id, v.name, v.price_minor FROM menu_item_variants v
           JOIN menu_items i ON i.id = v.menu_item_id
          WHERE i.restaurant_id = $1 AND v.deleted_at IS NULL
          ORDER BY v.sort_order, v.created_at`,
        [restaurant.id],
      );
      const byItem = new Map<string, MenuVariant[]>();
      for (const v of variantRows) {
        const list = byItem.get(v.menu_item_id) ?? [];
        list.push({ id: v.id, name: v.name, priceMinor: Number(v.price_minor) });
        byItem.set(v.menu_item_id, list);
      }
      return {
        restaurant: {
          id: restaurant.id,
          name: restaurant.name,
          currencyCode: restaurant.currency_code.trim(),
        },
        categories: categories.map((c): MenuCategory => ({
          id: c.id,
          name: c.name,
          sortOrder: c.sort_order,
          isActive: c.is_active,
          itemCount: Number(c.item_count),
        })),
        items: items.map((i) => ({ ...toItem(i), variants: byItem.get(i.id) ?? [] })),
        canManage: canUse(access, 'menu:manage', restaurant.id),
      };
    });
  }

  createCategory(auth: AuthContext, input: CreateCategoryInput, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      const restaurant = await this.restaurant(db, access, 'menu:manage', input.restaurantId);
      const row = await this.unique(() =>
        db.one<{ id: string }>(
          `INSERT INTO menu_categories (tenant_id, restaurant_id, name, sort_order, created_by, updated_by)
           VALUES ($1, $2, $3,
                   coalesce($4, (SELECT coalesce(max(sort_order) + 1, 0) FROM menu_categories
                                  WHERE restaurant_id = $2 AND deleted_at IS NULL)),
                   $5, $5)
           RETURNING id`,
          [auth.tenantId, restaurant.id, input.name, input.sortOrder ?? null, auth.userId],
        ),
      );
      await this.audit(db, auth, meta, 'menu.category_created', 'menu_category', row!.id, {
        name: input.name,
      });
      return { id: row!.id };
    });
  }

  updateCategory(auth: AuthContext, id: string, input: UpdateCategoryInput, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      const current = await this.categoryForManage(db, access, id);
      await this.unique(() =>
        db.query(
          `UPDATE menu_categories
              SET name = coalesce($2, name), sort_order = coalesce($3, sort_order),
                  is_active = coalesce($4, is_active), updated_by = $5,
                  updated_at = now(), version = version + 1
            WHERE id = $1`,
          [
            current.id,
            input.name ?? null,
            input.sortOrder ?? null,
            input.isActive ?? null,
            auth.userId,
          ],
        ),
      );
      await this.audit(db, auth, meta, 'menu.category_updated', 'menu_category', id, input);
    });
  }

  deleteCategory(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      const current = await this.categoryForManage(db, access, id);
      const used = await db.one<{ count: string }>(
        'SELECT count(*) FROM menu_items WHERE category_id = $1 AND deleted_at IS NULL',
        [id],
      );
      if (Number(used?.count ?? 0) > 0) {
        throw new ConflictException({
          code: 'CATEGORY_NOT_EMPTY',
          message: 'Move or delete the items in this category first.',
        });
      }
      await db.query(
        'UPDATE menu_categories SET deleted_at = now(), updated_by = $2 WHERE id = $1',
        [current.id, auth.userId],
      );
      await this.audit(db, auth, meta, 'menu.category_deleted', 'menu_category', id, {
        name: current.name,
      });
    });
  }

  createItem(auth: AuthContext, input: CreateItemInput, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      const category = await this.categoryForManage(db, access, input.categoryId);
      const row = await db.one<{ id: string }>(
        `INSERT INTO menu_items (tenant_id, restaurant_id, category_id, name, description,
                                 price_minor, currency_code, diet, image_url, is_available,
                                 sort_order, created_by, updated_by)
         SELECT $1, c.restaurant_id, c.id, $3, $4, $5, r.currency_code, $6, $7, $8,
                coalesce($9, (SELECT coalesce(max(sort_order) + 1, 0) FROM menu_items
                               WHERE category_id = c.id AND deleted_at IS NULL)),
                $10, $10
           FROM menu_categories c JOIN restaurants r ON r.id = c.restaurant_id
          WHERE c.id = $2
         RETURNING id`,
        [
          auth.tenantId,
          category.id,
          input.name,
          input.description || null,
          input.variants?.[0]?.priceMinor ?? input.priceMinor,
          input.diet,
          input.imageUrl || null,
          input.isAvailable ?? true,
          input.sortOrder ?? null,
          auth.userId,
        ],
      );
      if (input.variants?.length) await syncVariants(db, auth.tenantId!, row!.id, input.variants);
      await this.audit(db, auth, meta, 'menu.item_created', 'menu_item', row!.id, {
        name: input.name,
        priceMinor: input.priceMinor,
      });
      return { id: row!.id };
    });
  }

  updateItem(auth: AuthContext, id: string, input: UpdateItemInput, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      const item = await this.itemForManage(db, access, id);
      if (input.categoryId && input.categoryId !== item.category_id) {
        const target = await this.categoryForManage(db, access, input.categoryId);
        if (target.restaurant_id !== item.restaurant_id) {
          throw new BadRequestException({
            code: 'CATEGORY_OTHER_RESTAURANT',
            message: 'That category belongs to another restaurant.',
          });
        }
      }
      // Explicit nulls clear description/image; absent keys leave them unchanged.
      await db.query(
        `UPDATE menu_items SET
            category_id = coalesce($2, category_id),
            name = coalesce($3, name),
            description = CASE WHEN $4 THEN $5 ELSE description END,
            price_minor = coalesce($6, price_minor),
            diet = coalesce($7, diet),
            image_url = CASE WHEN $8 THEN $9 ELSE image_url END,
            is_available = coalesce($10, is_available),
            sort_order = coalesce($11, sort_order),
            updated_by = $12, updated_at = now(), version = version + 1
          WHERE id = $1`,
        [
          id,
          input.categoryId ?? null,
          input.name ?? null,
          'description' in input,
          input.description || null,
          input.priceMinor ?? null,
          input.diet ?? null,
          'imageUrl' in input,
          input.imageUrl || null,
          input.isAvailable ?? null,
          input.sortOrder ?? null,
          auth.userId,
        ],
      );
      if (input.variants) await syncVariants(db, auth.tenantId!, id, input.variants);
      await this.audit(db, auth, meta, 'menu.item_updated', 'menu_item', id, input);
    });
  }

  deleteItem(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      const item = await this.itemForManage(db, access, id);
      await db.query('UPDATE menu_items SET deleted_at = now(), updated_by = $2 WHERE id = $1', [
        id,
        auth.userId,
      ]);
      await this.audit(db, auth, meta, 'menu.item_deleted', 'menu_item', id, { name: item.name });
    });
  }

  /**
   * Bulk import: creates missing categories (matched by name, case-insensitive) and items, in one
   * transaction. Items whose name already exists in the category are skipped or updated.
   */
  importItems(auth: AuthContext, input: ImportInput, meta: RequestMeta) {
    return this.run(auth, async (db, access) => {
      const restaurant = await this.restaurant(db, access, 'menu:manage', input.restaurantId);

      const seen = new Set<string>();
      const duplicates: number[] = [];
      input.rows.forEach((r, i) => {
        const key = `${r.category.toLowerCase()}\u0000${r.name.toLowerCase()}`;
        if (seen.has(key)) duplicates.push(i + 1);
        seen.add(key);
      });
      if (duplicates.length > 0) {
        throw new BadRequestException({
          code: 'IMPORT_DUPLICATE_ROWS',
          message: `The same item appears more than once in the file (rows ${duplicates.slice(0, 10).join(', ')}).`,
        });
      }

      const categories = new Map(
        (
          await db.query<{ id: string; name: string }>(
            `SELECT id, name FROM menu_categories WHERE restaurant_id = $1 AND deleted_at IS NULL`,
            [restaurant.id],
          )
        ).map((c) => [c.name.toLowerCase(), c.id]),
      );
      let categoriesCreated = 0;
      for (const name of new Set(input.rows.map((r) => r.category))) {
        if (categories.has(name.toLowerCase())) continue;
        const row = await db.one<{ id: string }>(
          `INSERT INTO menu_categories (tenant_id, restaurant_id, name, sort_order, created_by, updated_by)
           VALUES ($1, $2, $3, (SELECT coalesce(max(sort_order) + 1, 0) FROM menu_categories
                                 WHERE restaurant_id = $2 AND deleted_at IS NULL), $4, $4)
           RETURNING id`,
          [auth.tenantId, restaurant.id, name, auth.userId],
        );
        categories.set(name.toLowerCase(), row!.id);
        categoriesCreated++;
      }

      const existing = new Map(
        (
          await db.query<{ id: string; category_id: string; name: string }>(
            `SELECT id, category_id, name FROM menu_items
              WHERE restaurant_id = $1 AND deleted_at IS NULL FOR UPDATE`,
            [restaurant.id],
          )
        ).map((i) => [`${i.category_id}\u0000${i.name.toLowerCase()}`, i.id]),
      );

      let created = 0;
      let updated = 0;
      let skipped = 0;
      for (const r of input.rows) {
        const categoryId = categories.get(r.category.toLowerCase())!;
        const match = existing.get(`${categoryId}\u0000${r.name.toLowerCase()}`);
        if (match) {
          if (input.onDuplicate === 'skip') {
            skipped++;
            continue;
          }
          await db.query(
            `UPDATE menu_items SET price_minor = $2, diet = $3, description = $4, image_url = $5,
                    is_available = $6, updated_by = $7, updated_at = now(), version = version + 1
              WHERE id = $1`,
            [
              match,
              r.priceMinor,
              r.diet,
              r.description || null,
              r.imageUrl || null,
              r.isAvailable ?? true,
              auth.userId,
            ],
          );
          await syncVariants(db, auth.tenantId!, match, halfAndFull(r));
          updated++;
          continue;
        }
        const inserted = await db.one<{ id: string }>(
          `INSERT INTO menu_items (tenant_id, restaurant_id, category_id, name, description,
                                   price_minor, currency_code, diet, image_url, is_available,
                                   sort_order, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                   (SELECT coalesce(max(sort_order) + 1, 0) FROM menu_items
                     WHERE category_id = $3 AND deleted_at IS NULL), $11, $11)
           RETURNING id`,
          [
            auth.tenantId,
            restaurant.id,
            categoryId,
            r.name,
            r.description || null,
            r.priceMinor,
            restaurant.currency_code,
            r.diet,
            r.imageUrl || null,
            r.isAvailable ?? true,
            auth.userId,
          ],
        );
        const portions = halfAndFull(r);
        if (portions.length) await syncVariants(db, auth.tenantId!, inserted!.id, portions);
        created++;
      }

      const result = { categoriesCreated, created, updated, skipped };
      await this.audit(db, auth, meta, 'menu.imported', 'restaurant', restaurant.id, {
        rows: input.rows.length,
        onDuplicate: input.onDuplicate,
        ...result,
      });
      return result;
    });
  }

  // ---- helpers ----

  private run<T>(auth: AuthContext, work: (db: Db, access: TenantAccess) => Promise<T>) {
    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, async (db) =>
      work(db, await this.access.tenantAccess(db, auth.membershipId!)),
    );
  }

  /** The requested restaurant, or the caller's only one when none is given. */
  private async restaurant(
    db: Db,
    access: TenantAccess,
    perm: Perm,
    restaurantId?: string,
  ): Promise<Restaurant> {
    const allowed = [...new Set(access.allBranches.map((b) => b.restaurantId))].filter((id) =>
      canUse(access, perm, id),
    );
    if (allowed.length === 0) throw forbidden();
    let id = restaurantId;
    if (!id) {
      if (allowed.length > 1) {
        throw new BadRequestException({
          code: 'RESTAURANT_REQUIRED',
          message: 'Choose which restaurant’s menu to open.',
        });
      }
      id = allowed[0];
    }
    if (!allowed.includes(id!)) throw forbidden();
    const row = await db.one<Restaurant>(
      'SELECT id, name, currency_code FROM restaurants WHERE id = $1',
      [id],
    );
    if (!row) throw notFound('Restaurant');
    return row;
  }

  private async categoryForManage(db: Db, access: TenantAccess, id: string) {
    const row = await db.one<{ id: string; name: string; restaurant_id: string }>(
      'SELECT id, name, restaurant_id FROM menu_categories WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    if (!row) throw notFound('Category');
    if (!canUse(access, 'menu:manage', row.restaurant_id)) throw forbidden();
    return row;
  }

  private async itemForManage(db: Db, access: TenantAccess, id: string) {
    const row = await db.one<{
      id: string;
      name: string;
      restaurant_id: string;
      category_id: string;
    }>(
      `SELECT id, name, restaurant_id, category_id FROM menu_items
        WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [id],
    );
    if (!row) throw notFound('Item');
    if (!canUse(access, 'menu:manage', row.restaurant_id)) throw forbidden();
    return row;
  }

  private async unique<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new ConflictException({
          code: 'CATEGORY_EXISTS',
          message: 'A category with this name already exists.',
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
    entityType: string,
    entityId: string,
    metadata: object,
  ) {
    return writeAudit(db, {
      action,
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      actorSessionId: auth.sessionId,
      actorAudience: 'tenant',
      entityType,
      entityId,
      metadata: metadata as Record<string, unknown>,
      ...meta,
    });
  }
}

/** Tenant- or restaurant-wide grants, or a grant on any branch of the restaurant. */
export function canUse(access: TenantAccess, perm: Perm, restaurantId: string): boolean {
  return (
    hasPermission(access, perm, { restaurantId }) ||
    access.allBranches.some(
      (b) => b.restaurantId === restaurantId && access.byBranch[b.id]?.includes(perm),
    )
  );
}

/** Import rows with a half price become Full + Half portions; otherwise no portions. */
function halfAndFull(r: { priceMinor: number; halfPriceMinor?: number | null }) {
  return r.halfPriceMinor != null
    ? [
        { name: 'Full', priceMinor: r.priceMinor },
        { name: 'Half', priceMinor: r.halfPriceMinor },
      ]
    : [];
}

/**
 * Replaces an item's portions: keeps (and updates) ids that are listed, soft-deletes the rest,
 * inserts new ones, and mirrors the first portion's price onto the item.
 */
export async function syncVariants(
  db: Db,
  tenantId: string,
  itemId: string,
  variants: { id?: string; name: string; priceMinor: number }[],
) {
  const keep = variants.filter((v) => v.id).map((v) => v.id!);
  const owned = await db.query<{ id: string }>(
    'SELECT id FROM menu_item_variants WHERE menu_item_id = $1 AND deleted_at IS NULL',
    [itemId],
  );
  const ownedIds = new Set(owned.map((o) => o.id));
  if (keep.some((id) => !ownedIds.has(id))) {
    throw new BadRequestException({
      code: 'VARIANT_NOT_FOUND',
      message: 'A portion no longer exists. Refresh and try again.',
    });
  }
  // Free the names first so renames/reorders don't trip the unique index.
  await db.query(
    `UPDATE menu_item_variants SET deleted_at = now(), updated_at = now()
      WHERE menu_item_id = $1 AND deleted_at IS NULL AND NOT (id = ANY($2::uuid[]))`,
    [itemId, keep],
  );
  await db.query(
    `UPDATE menu_item_variants SET name = id::text, updated_at = now() WHERE id = ANY($1::uuid[])`,
    [keep],
  );
  for (const [i, v] of variants.entries()) {
    if (v.id) {
      await db.query(
        'UPDATE menu_item_variants SET name = $2, price_minor = $3, sort_order = $4, updated_at = now() WHERE id = $1',
        [v.id, v.name, v.priceMinor, i],
      );
    } else {
      await db.query(
        `INSERT INTO menu_item_variants (tenant_id, menu_item_id, name, price_minor, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, itemId, v.name, v.priceMinor, i],
      );
    }
  }
  if (variants[0]) {
    await db.query('UPDATE menu_items SET price_minor = $2 WHERE id = $1', [
      itemId,
      variants[0].priceMinor,
    ]);
  }
}

interface ItemRow {
  id: string;
  category_id: string;
  name: string;
  description: string | null;
  price_minor: string;
  currency_code: string;
  diet: MenuItem['diet'];
  image_url: string | null;
  is_available: boolean;
  sort_order: number;
  updated_at: Date;
}

const ITEM_SELECT = `SELECT id, category_id, name, description, price_minor, currency_code, diet,
                            image_url, is_available, sort_order, updated_at FROM menu_items`;

function toItem(r: ItemRow): MenuItem {
  return {
    id: r.id,
    categoryId: r.category_id,
    name: r.name,
    description: r.description,
    priceMinor: Number(r.price_minor),
    currencyCode: r.currency_code.trim(),
    diet: r.diet,
    imageUrl: r.image_url,
    isAvailable: r.is_available,
    sortOrder: r.sort_order,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
