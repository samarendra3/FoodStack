import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { toString } from 'qrcode';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { DbContext } from '../../core/db/db-context';
import { Public, RequirePermission } from '../auth/decorators';
import { notFound } from './ops-base';

const querySchema = z.strictObject({ branchId: z.uuid().optional() });

/**
 * The menu a guest sees after scanning a table QR code. No sign-in: the URL carries the tenant
 * and restaurant ids, the query runs inside that tenant's row-level security scope, and only
 * public menu fields (names, prices, descriptions, diet, photos, availability) are returned.
 */
@ApiTags('Public menu')
@Public()
@Controller('public/menu')
export class PublicMenuController {
  constructor(private readonly db: DbContext) {}

  @Get(':tenantId/:restaurantId')
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({ summary: 'Public menu for QR codes' })
  menu(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('restaurantId', ParseUUIDPipe) restaurantId: string,
    @Query(new ZodValidationPipe(querySchema)) q: z.infer<typeof querySchema>,
  ) {
    return this.db.run({ tenantId }, async (db) => {
      const r = await db.one<{
        name: string;
        currency_code: string;
        logo_url: string | null;
        tax_rate_bp: number;
      }>(
        `SELECT name, currency_code, logo_url, tax_rate_bp FROM restaurants WHERE id = $1 AND status = 'active'`,
        [restaurantId],
      );
      if (!r) throw notFound('Menu');
      const branch = q.branchId
        ? await db.one<{ name: string }>(
            'SELECT name FROM branches WHERE id = $1 AND restaurant_id = $2',
            [q.branchId, restaurantId],
          )
        : null;
      if (q.branchId && !branch) throw notFound('Menu');
      const categories = await db.query<{ id: string; name: string }>(
        `SELECT id, name FROM menu_categories
          WHERE restaurant_id = $1 AND is_active AND deleted_at IS NULL ORDER BY sort_order, lower(name)`,
        [restaurantId],
      );
      const items = await db.query<Record<string, unknown>>(
        `SELECT m.id, m.category_id, m.name, m.description, m.price_minor, m.diet, m.image_url, m.is_available,
                coalesce((SELECT json_agg(json_build_object('name', v.name, 'priceMinor', v.price_minor) ORDER BY v.sort_order)
                            FROM menu_item_variants v WHERE v.menu_item_id = m.id), '[]') AS variants
           FROM menu_items m
          WHERE m.restaurant_id = $1 AND m.deleted_at IS NULL
            AND ($2::uuid IS NULL OR NOT EXISTS (SELECT 1 FROM menu_item_branches mb WHERE mb.menu_item_id = m.id)
                 OR EXISTS (SELECT 1 FROM menu_item_branches mb WHERE mb.menu_item_id = m.id AND mb.branch_id = $2))
          ORDER BY m.sort_order, lower(m.name)`,
        [restaurantId, q.branchId ?? null],
      );
      return {
        restaurant: {
          name: r.name,
          currencyCode: r.currency_code.trim(),
          logoUrl: r.logo_url,
          taxRateBp: r.tax_rate_bp,
        },
        branch: branch ? { name: branch.name } : null,
        categories: categories
          .map((c) => ({
            id: c.id,
            name: c.name,
            items: items
              .filter((i) => i.category_id === c.id)
              .map((i) => ({
                id: i.id,
                name: i.name,
                description: i.description,
                priceMinor: Number(i.price_minor),
                diet: i.diet,
                imageUrl: i.image_url,
                isAvailable: i.is_available,
                variants: (i.variants as { name: string; priceMinor: string }[]).map((v) => ({
                  ...v,
                  priceMinor: Number(v.priceMinor),
                })),
              })),
          }))
          .filter((c) => c.items.length > 0),
      };
    });
  }
}

const codesSchema = z.strictObject({
  urls: z
    .array(z.url({ protocol: /^https?$/ }).max(500))
    .min(1)
    .max(200),
});

/** Renders QR codes (SVG) for the table cards on the QR Menu screen. */
@ApiTags('Public menu')
@Controller('qr-codes')
export class QrCodesController {
  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('menu:read')
  @ApiOperation({ summary: 'SVG QR codes for a list of URLs' })
  async codes(@Body(new ZodValidationPipe(codesSchema)) body: z.infer<typeof codesSchema>) {
    return {
      codes: await Promise.all(
        body.urls.map(async (url) => ({
          url,
          svg: await toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
        })),
      ),
    };
  }
}
