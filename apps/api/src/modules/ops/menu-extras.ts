import {
  Body,
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
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { requestMeta } from '../../common/http/request-meta';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import {
  invalid,
  money,
  notFound,
  OpsBase,
  optText,
  restaurantQuery,
  type Scope,
  setClause,
} from './ops-base';

/*
 * Add-on groups (e.g. "Extra toppings": choose 0–3, each with a price) attached to menu items,
 * and combos (a fixed set of menu items sold together at one price).
 */

const optionSchema = z.strictObject({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(60),
  priceMinor: money,
  isAvailable: z.boolean().default(true),
});
const groupBase = z.strictObject({
  restaurantId: z.uuid().optional(),
  name: z.string().trim().min(1).max(60),
  minSelect: z.coerce.number().int().min(0).max(20),
  maxSelect: z.coerce.number().int().min(1).max(20),
  isActive: z.boolean().default(true),
  options: z.array(optionSchema).min(1).max(30),
  menuItemIds: z.array(z.uuid()).max(500).default([]),
});
const groupSchema = groupBase.refine((g) => g.minSelect <= g.maxSelect, {
  message: 'Minimum cannot be more than maximum',
  path: ['minSelect'],
});
const groupUpdateSchema = groupBase.omit({ restaurantId: true }).partial();

const comboBase = z.strictObject({
  restaurantId: z.uuid().optional(),
  name: z.string().trim().min(1).max(80),
  description: optText(300),
  priceMinor: money.refine((v) => v > 0, 'Enter a price'),
  isActive: z.boolean().default(true),
  items: z
    .array(
      z.strictObject({ menuItemId: z.uuid(), quantity: z.coerce.number().int().min(1).max(50) }),
    )
    .min(2, 'A combo needs at least two dishes')
    .max(20),
});
const comboUpdateSchema = comboBase.omit({ restaurantId: true }).partial();

@Injectable()
export class MenuExtrasService {
  constructor(private readonly ops: OpsBase) {}

  // ---------------------------------------------------------------- add-ons

  addons(auth: AuthContext, restaurantId?: string) {
    return this.ops.run(auth, async (s) => {
      const rid = this.ops.readRestaurant(s.access, 'menu:read', restaurantId);
      const groups = await s.db.query<Record<string, unknown>>(
        `SELECT g.id, g.name, g.min_select, g.max_select, g.is_active,
                coalesce((SELECT json_agg(json_build_object('id', o.id, 'name', o.name, 'priceMinor', o.price_minor,
                          'isAvailable', o.is_available) ORDER BY o.sort_order, o.name)
                          FROM addon_options o WHERE o.group_id = g.id), '[]') AS options,
                coalesce((SELECT json_agg(m.menu_item_id) FROM menu_item_addon_groups m WHERE m.group_id = g.id), '[]') AS items
           FROM addon_groups g
          WHERE g.restaurant_id = $1 AND g.deleted_at IS NULL
          ORDER BY lower(g.name)`,
        [rid],
      );
      return {
        restaurantId: rid,
        currencyCode: await this.ops.currency(s.db, rid),
        canManage: this.ops.can(s.access, 'menu:manage', { restaurantId: rid }),
        menuItems: await this.menuItems(s, rid),
        groups: groups.map((g) => ({
          id: g.id,
          name: g.name,
          minSelect: Number(g.min_select),
          maxSelect: Number(g.max_select),
          isActive: g.is_active,
          options: (
            g.options as { id: string; name: string; priceMinor: string; isAvailable: boolean }[]
          ).map((o) => ({
            ...o,
            priceMinor: Number(o.priceMinor),
          })),
          menuItemIds: g.items as string[],
        })),
      };
    });
  }

  createGroup(auth: AuthContext, body: z.infer<typeof groupSchema>, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const rid = this.ops.restaurant(s.access, 'menu:manage', body.restaurantId);
      if (body.maxSelect > body.options.length)
        throw invalid('Maximum choices cannot exceed the number of options.');
      const g = await s.db.one<{ id: string }>(
        `INSERT INTO addon_groups (tenant_id, restaurant_id, name, min_select, max_select, is_active, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          s.auth.tenantId,
          rid,
          body.name,
          body.minSelect,
          body.maxSelect,
          body.isActive,
          s.auth.userId,
        ],
      );
      await this.writeOptions(s, g!.id, body.options);
      await this.writeLinks(s, rid, g!.id, body.menuItemIds);
      await this.ops.audit(s, meta, 'addon_group.created', 'addon_group', g!.id, {
        name: body.name,
      });
      return { id: g!.id };
    });
  }

  updateGroup(
    auth: AuthContext,
    id: string,
    body: z.infer<typeof groupUpdateSchema>,
    meta: RequestMeta,
  ) {
    return this.ops.run(auth, async (s) => {
      const g = await s.db.one<{ restaurant_id: string; min_select: number; max_select: number }>(
        'SELECT restaurant_id, min_select, max_select FROM addon_groups WHERE id = $1 AND deleted_at IS NULL',
        [id],
      );
      if (!g) throw notFound('Add-on group');
      this.ops.restaurant(s.access, 'menu:manage', g.restaurant_id);
      const min = body.minSelect ?? g.min_select;
      const max = body.maxSelect ?? g.max_select;
      if (min > max) throw invalid('Minimum cannot be more than maximum.');
      const params: unknown[] = [id];
      const set = setClause(
        body,
        { name: 'name', minSelect: 'min_select', maxSelect: 'max_select', isActive: 'is_active' },
        params,
      );
      if (set) await s.db.query(`UPDATE addon_groups SET ${set} WHERE id = $1`, params);
      if (body.options) {
        if (max > body.options.length)
          throw invalid('Maximum choices cannot exceed the number of options.');
        await s.db.query('DELETE FROM addon_options WHERE group_id = $1', [id]);
        await this.writeOptions(s, id, body.options);
      }
      if (body.menuItemIds) {
        await s.db.query('DELETE FROM menu_item_addon_groups WHERE group_id = $1', [id]);
        await this.writeLinks(s, g.restaurant_id, id, body.menuItemIds);
      }
      await this.ops.audit(s, meta, 'addon_group.updated', 'addon_group', id);
    });
  }

  deleteGroup(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const g = await s.db.one<{ restaurant_id: string }>(
        'SELECT restaurant_id FROM addon_groups WHERE id = $1 AND deleted_at IS NULL',
        [id],
      );
      if (!g) throw notFound('Add-on group');
      this.ops.restaurant(s.access, 'menu:manage', g.restaurant_id);
      await s.db.query('DELETE FROM menu_item_addon_groups WHERE group_id = $1', [id]);
      await s.db.query('UPDATE addon_groups SET deleted_at = now() WHERE id = $1', [id]);
      await this.ops.audit(s, meta, 'addon_group.deleted', 'addon_group', id);
    });
  }

  private async writeOptions(s: Scope, groupId: string, options: z.infer<typeof optionSchema>[]) {
    let i = 0;
    for (const o of options) {
      await s.db.query(
        `INSERT INTO addon_options (tenant_id, group_id, name, price_minor, is_available, sort_order, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [s.auth.tenantId, groupId, o.name, o.priceMinor, o.isAvailable, i++, s.auth.userId],
      );
    }
  }

  private async writeLinks(s: Scope, rid: string, groupId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;
    const ok = await s.db.query<{ id: string }>(
      'SELECT id FROM menu_items WHERE id = ANY($1::uuid[]) AND restaurant_id = $2 AND deleted_at IS NULL',
      [unique, rid],
    );
    if (ok.length !== unique.length) throw invalid('One or more dishes were not found.');
    for (const id of unique) {
      await s.db.query(
        'INSERT INTO menu_item_addon_groups (tenant_id, menu_item_id, group_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [s.auth.tenantId, id, groupId],
      );
    }
  }

  private async menuItems(s: Scope, rid: string) {
    const rows = await s.db.query<{
      id: string;
      name: string;
      price_minor: string;
      category: string | null;
      is_available: boolean;
    }>(
      `SELECT m.id, m.name, m.price_minor, c.name AS category, m.is_available
         FROM menu_items m LEFT JOIN menu_categories c ON c.id = m.category_id
        WHERE m.restaurant_id = $1 AND m.deleted_at IS NULL ORDER BY lower(c.name), lower(m.name)`,
      [rid],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      priceMinor: Number(r.price_minor),
      category: r.category,
      isAvailable: r.is_available,
    }));
  }

  // ---------------------------------------------------------------- combos

  combos(auth: AuthContext, restaurantId?: string) {
    return this.ops.run(auth, async (s) => {
      const rid = this.ops.readRestaurant(s.access, 'menu:read', restaurantId);
      const rows = await s.db.query<Record<string, unknown>>(
        `SELECT c.id, c.name, c.description, c.price_minor, c.is_active,
                coalesce(json_agg(json_build_object('menuItemId', ci.menu_item_id, 'name', m.name, 'quantity', ci.quantity,
                         'unitPriceMinor', m.price_minor, 'isAvailable', m.is_available AND m.deleted_at IS NULL)
                         ORDER BY m.name) FILTER (WHERE ci.id IS NOT NULL), '[]') AS items
           FROM combos c
           LEFT JOIN combo_items ci ON ci.combo_id = c.id
           LEFT JOIN menu_items m ON m.id = ci.menu_item_id
          WHERE c.restaurant_id = $1 AND c.deleted_at IS NULL
          GROUP BY c.id ORDER BY lower(c.name)`,
        [rid],
      );
      return {
        restaurantId: rid,
        currencyCode: await this.ops.currency(s.db, rid),
        canManage: this.ops.can(s.access, 'menu:manage', { restaurantId: rid }),
        menuItems: await this.menuItems(s, rid),
        rows: rows.map((c) => {
          const items = (
            c.items as {
              menuItemId: string;
              name: string;
              quantity: number;
              unitPriceMinor: string;
              isAvailable: boolean;
            }[]
          ).map((i) => ({ ...i, unitPriceMinor: Number(i.unitPriceMinor) }));
          const regular = items.reduce((t, i) => t + i.unitPriceMinor * i.quantity, 0);
          const price = Number(c.price_minor);
          return {
            id: c.id,
            name: c.name,
            description: c.description,
            priceMinor: price,
            isActive: c.is_active,
            items,
            regularPriceMinor: regular,
            savingsMinor: Math.max(0, regular - price),
            savingsPct: regular > 0 ? Math.round(((regular - price) / regular) * 1000) / 10 : null,
            // Sellable only while every dish in it is available.
            isSellable: Boolean(c.is_active) && items.every((i) => i.isAvailable),
          };
        }),
      };
    });
  }

  createCombo(auth: AuthContext, body: z.infer<typeof comboBase>, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const rid = this.ops.restaurant(s.access, 'menu:manage', body.restaurantId);
      await this.checkComboItems(s, rid, body.items, body.priceMinor);
      const c = await s.db.one<{ id: string }>(
        `INSERT INTO combos (tenant_id, restaurant_id, name, description, price_minor, is_active, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          s.auth.tenantId,
          rid,
          body.name,
          body.description ?? null,
          body.priceMinor,
          body.isActive,
          s.auth.userId,
        ],
      );
      await this.writeComboItems(s, c!.id, body.items);
      await this.ops.audit(s, meta, 'combo.created', 'combo', c!.id, { name: body.name });
      return { id: c!.id };
    });
  }

  updateCombo(
    auth: AuthContext,
    id: string,
    body: z.infer<typeof comboUpdateSchema>,
    meta: RequestMeta,
  ) {
    return this.ops.run(auth, async (s) => {
      const c = await s.db.one<{ restaurant_id: string; price_minor: string }>(
        'SELECT restaurant_id, price_minor FROM combos WHERE id = $1 AND deleted_at IS NULL',
        [id],
      );
      if (!c) throw notFound('Combo');
      this.ops.restaurant(s.access, 'menu:manage', c.restaurant_id);
      if (body.items) {
        await this.checkComboItems(
          s,
          c.restaurant_id,
          body.items,
          body.priceMinor ?? Number(c.price_minor),
        );
        await s.db.query('DELETE FROM combo_items WHERE combo_id = $1', [id]);
        await this.writeComboItems(s, id, body.items);
      }
      const params: unknown[] = [id];
      const set = setClause(
        body,
        {
          name: 'name',
          description: 'description',
          priceMinor: 'price_minor',
          isActive: 'is_active',
        },
        params,
      );
      if (set) await s.db.query(`UPDATE combos SET ${set} WHERE id = $1`, params);
      await this.ops.audit(s, meta, 'combo.updated', 'combo', id);
    });
  }

  deleteCombo(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const c = await s.db.one<{ restaurant_id: string }>(
        'SELECT restaurant_id FROM combos WHERE id = $1 AND deleted_at IS NULL',
        [id],
      );
      if (!c) throw notFound('Combo');
      this.ops.restaurant(s.access, 'menu:manage', c.restaurant_id);
      await s.db.query('UPDATE combos SET deleted_at = now() WHERE id = $1', [id]);
      await this.ops.audit(s, meta, 'combo.deleted', 'combo', id);
    });
  }

  private async checkComboItems(
    s: Scope,
    rid: string,
    items: { menuItemId: string }[],
    price: number,
  ) {
    const ids = [...new Set(items.map((i) => i.menuItemId))];
    if (ids.length !== items.length)
      throw invalid('Each dish can appear only once; raise its quantity instead.');
    const rows = await s.db.query<{ id: string }>(
      'SELECT id FROM menu_items WHERE id = ANY($1::uuid[]) AND restaurant_id = $2 AND deleted_at IS NULL',
      [ids, rid],
    );
    if (rows.length !== ids.length) throw invalid('One or more dishes were not found.');
    if (price <= 0) throw invalid('Enter a combo price.');
  }

  private async writeComboItems(
    s: Scope,
    comboId: string,
    items: { menuItemId: string; quantity: number }[],
  ) {
    for (const i of items) {
      await s.db.query(
        'INSERT INTO combo_items (tenant_id, combo_id, menu_item_id, quantity, created_by) VALUES ($1, $2, $3, $4, $5)',
        [s.auth.tenantId, comboId, i.menuItemId, i.quantity, s.auth.userId],
      );
    }
  }
}

@ApiTags('Menu extras')
@Controller()
export class MenuExtrasController {
  constructor(private readonly m: MenuExtrasService) {}

  @Get('addon-groups')
  @RequirePermission('menu:read')
  addons(
    @CurrentAuth() a: AuthContext,
    @Query(new ZodValidationPipe(restaurantQuery)) q: z.infer<typeof restaurantQuery>,
  ) {
    return this.m.addons(a, q.restaurantId);
  }

  @Post('addon-groups')
  @RequirePermission('menu:manage')
  createGroup(
    @CurrentAuth() a: AuthContext,
    @Body(new ZodValidationPipe(groupSchema)) b: z.infer<typeof groupSchema>,
    @Req() r: Request,
  ) {
    return this.m.createGroup(a, b, requestMeta(r));
  }

  @Patch('addon-groups/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('menu:manage')
  async updateGroup(
    @CurrentAuth() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(groupUpdateSchema)) b: z.infer<typeof groupUpdateSchema>,
    @Req() r: Request,
  ) {
    await this.m.updateGroup(a, id, b, requestMeta(r));
  }

  @Delete('addon-groups/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('menu:manage')
  async deleteGroup(
    @CurrentAuth() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() r: Request,
  ) {
    await this.m.deleteGroup(a, id, requestMeta(r));
  }

  @Get('combos')
  @RequirePermission('menu:read')
  combos(
    @CurrentAuth() a: AuthContext,
    @Query(new ZodValidationPipe(restaurantQuery)) q: z.infer<typeof restaurantQuery>,
  ) {
    return this.m.combos(a, q.restaurantId);
  }

  @Post('combos')
  @RequirePermission('menu:manage')
  createCombo(
    @CurrentAuth() a: AuthContext,
    @Body(new ZodValidationPipe(comboBase)) b: z.infer<typeof comboBase>,
    @Req() r: Request,
  ) {
    return this.m.createCombo(a, b, requestMeta(r));
  }

  @Patch('combos/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('menu:manage')
  async updateCombo(
    @CurrentAuth() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(comboUpdateSchema)) b: z.infer<typeof comboUpdateSchema>,
    @Req() r: Request,
  ) {
    await this.m.updateCombo(a, id, b, requestMeta(r));
  }

  @Delete('combos/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('menu:manage')
  async deleteCombo(
    @CurrentAuth() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() r: Request,
  ) {
    await this.m.deleteCombo(a, id, requestMeta(r));
  }
}
