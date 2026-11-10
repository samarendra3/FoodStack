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
  Put,
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
  branchQuery,
  invalid,
  iso,
  notFound,
  OpsBase,
  optText,
  restaurantQuery,
  type Scope,
  setClause,
} from './ops-base';

/*
 * Printers per branch, integration settings per restaurant, and in-app alerts with per-event
 * preferences. Alerts are computed live from the restaurant's data, never stored.
 */

const printerSchema = z.strictObject({
  branchId: z.uuid(),
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['receipt', 'kitchen', 'label']),
  connection: z.enum(['network', 'usb', 'bluetooth', 'browser']),
  address: optText(120),
  paperWidthMm: z.union([z.literal(58), z.literal(80)]),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
});
const printerUpdateSchema = printerSchema.omit({ branchId: true }).partial();

/** Integrations FoodStack knows; `fields` are the non-secret identifiers we store. */
export const INTEGRATIONS = {
  swiggy: { name: 'Swiggy', category: 'Delivery', fields: ['restaurantId'] },
  zomato: { name: 'Zomato', category: 'Delivery', fields: ['restaurantId'] },
  google_business: { name: 'Google Business Profile', category: 'Marketing', fields: ['placeId'] },
  whatsapp: { name: 'WhatsApp Business', category: 'Messaging', fields: ['phoneNumber'] },
  tally: { name: 'Tally', category: 'Accounting', fields: ['companyName', 'salesLedger'] },
} as const;
type Provider = keyof typeof INTEGRATIONS;
const integrationSchema = z.strictObject({
  restaurantId: z.uuid().optional(),
  status: z.enum(['connected', 'paused']).default('connected'),
  settings: z.record(z.string().max(40), z.string().trim().max(120)).default({}),
});

export const EVENTS = {
  low_stock: 'Stock below its low-stock level',
  cash_variance: 'Register closed with a cash difference',
  register_open_long: 'Register open for more than 14 hours',
  reservations_today: 'Reservations booked for today',
  po_overdue: 'Purchase orders past their expected date',
  refunds_today: 'Refunds issued today',
} as const;
type EventKey = keyof typeof EVENTS;
const prefsSchema = z.strictObject({
  restaurantId: z.uuid().optional(),
  prefs: z.partialRecord(z.enum(Object.keys(EVENTS) as [EventKey, ...EventKey[]]), z.boolean()),
});

@Injectable()
export class SetupService {
  constructor(private readonly ops: OpsBase) {}

  // ---------------------------------------------------------------- printers

  printers(auth: AuthContext, branchId?: string) {
    return this.ops.run(auth, async (s) => {
      const b = this.ops.branch(s.access, 'branch:read', branchId);
      const rows = await s.db.query<Record<string, unknown>>(
        `SELECT id, name, kind, connection, address, paper_width_mm, is_default, is_active
           FROM printers WHERE branch_id = $1 AND deleted_at IS NULL ORDER BY kind, is_default DESC, lower(name)`,
        [b.id],
      );
      return {
        branch: { id: b.id, name: b.name },
        branches: this.ops.branchList(s.access, 'branch:read'),
        canManage: this.ops.can(s.access, 'branch:manage', { branchId: b.id }),
        rows: rows.map((r) => ({
          id: r.id,
          name: r.name,
          kind: r.kind,
          connection: r.connection,
          address: r.address,
          paperWidthMm: Number(r.paper_width_mm),
          isDefault: r.is_default,
          isActive: r.is_active,
        })),
      };
    });
  }

  createPrinter(auth: AuthContext, body: z.infer<typeof printerSchema>, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const b = this.ops.branch(s.access, 'branch:manage', body.branchId);
      this.checkAddress(body.connection, body.address ?? null);
      if (body.isDefault) await this.clearDefault(s, b.id, body.kind);
      const row = await s.db.one<{ id: string }>(
        `INSERT INTO printers (tenant_id, branch_id, name, kind, connection, address, paper_width_mm, is_default, is_active, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          s.auth.tenantId,
          b.id,
          body.name,
          body.kind,
          body.connection,
          body.address ?? null,
          body.paperWidthMm,
          body.isDefault,
          body.isActive,
          s.auth.userId,
        ],
      );
      await this.ops.audit(s, meta, 'printer.created', 'printer', row!.id, { name: body.name });
      return { id: row!.id };
    });
  }

  updatePrinter(
    auth: AuthContext,
    id: string,
    body: z.infer<typeof printerUpdateSchema>,
    meta: RequestMeta,
  ) {
    return this.ops.run(auth, async (s) => {
      const p = await s.db.one<{
        branch_id: string;
        kind: string;
        connection: string;
        address: string | null;
      }>(
        'SELECT branch_id, kind, connection, address FROM printers WHERE id = $1 AND deleted_at IS NULL',
        [id],
      );
      if (!p) throw notFound('Printer');
      this.ops.branch(s.access, 'branch:manage', p.branch_id);
      this.checkAddress(
        body.connection ?? p.connection,
        body.address === undefined ? p.address : body.address,
      );
      if (body.isDefault) await this.clearDefault(s, p.branch_id, body.kind ?? p.kind, id);
      const params: unknown[] = [id];
      const set = setClause(
        body,
        {
          name: 'name',
          kind: 'kind',
          connection: 'connection',
          address: 'address',
          paperWidthMm: 'paper_width_mm',
          isDefault: 'is_default',
          isActive: 'is_active',
        },
        params,
      );
      if (set) await s.db.query(`UPDATE printers SET ${set} WHERE id = $1`, params);
      await this.ops.audit(s, meta, 'printer.updated', 'printer', id, body);
    });
  }

  deletePrinter(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const p = await s.db.one<{ branch_id: string }>(
        'SELECT branch_id FROM printers WHERE id = $1 AND deleted_at IS NULL',
        [id],
      );
      if (!p) throw notFound('Printer');
      this.ops.branch(s.access, 'branch:manage', p.branch_id);
      await s.db.query('UPDATE printers SET deleted_at = now(), is_default = false WHERE id = $1', [
        id,
      ]);
      await this.ops.audit(s, meta, 'printer.deleted', 'printer', id);
    });
  }

  private checkAddress(connection: string, address: string | null) {
    if (connection === 'network') {
      if (!address || !/^[a-zA-Z0-9.-]+(:\d{2,5})?$/.test(address)) {
        throw invalid('Enter the printer IP address, e.g. 192.168.1.50:9100.');
      }
    }
  }

  private async clearDefault(s: Scope, branchId: string, kind: string, except?: string) {
    await s.db.query(
      `UPDATE printers SET is_default = false WHERE branch_id = $1 AND kind = $2 AND is_default AND ($3::uuid IS NULL OR id <> $3)`,
      [branchId, kind, except ?? null],
    );
  }

  // ---------------------------------------------------------------- integrations

  integrations(auth: AuthContext, restaurantId?: string) {
    return this.ops.run(auth, async (s) => {
      const rid = this.ops.readRestaurant(s.access, 'restaurant:read', restaurantId);
      const rows = await s.db.query<{
        provider: string;
        status: string;
        settings: Record<string, string>;
        updated_at: string;
      }>(
        'SELECT provider, status, settings, updated_at FROM integrations WHERE restaurant_id = $1',
        [rid],
      );
      const byProvider = new Map(rows.map((r) => [r.provider, r]));
      return {
        restaurantId: rid,
        canManage: this.ops.can(s.access, 'restaurant:manage', { restaurantId: rid }),
        rows: (Object.keys(INTEGRATIONS) as Provider[]).map((key) => {
          const r = byProvider.get(key);
          return {
            provider: key,
            ...INTEGRATIONS[key],
            status: (r?.status ?? 'not_connected') as 'connected' | 'paused' | 'not_connected',
            settings: r?.settings ?? {},
            updatedAt: r ? iso(r.updated_at) : null,
          };
        }),
      };
    });
  }

  saveIntegration(
    auth: AuthContext,
    provider: string,
    body: z.infer<typeof integrationSchema>,
    meta: RequestMeta,
  ) {
    return this.ops.run(auth, async (s) => {
      const def = INTEGRATIONS[provider as Provider];
      if (!def) throw notFound('Integration');
      const rid = this.ops.restaurant(s.access, 'restaurant:manage', body.restaurantId);
      const allowed = new Set<string>(def.fields);
      const settings: Record<string, string> = {};
      for (const [k, v] of Object.entries(body.settings)) {
        if (!allowed.has(k)) throw invalid(`Unknown setting "${k}".`);
        if (v) settings[k] = v;
      }
      for (const f of def.fields) if (!settings[f]) throw invalid(`Fill in ${f}.`);
      await s.db.query(
        `INSERT INTO integrations (tenant_id, restaurant_id, provider, status, settings, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, restaurant_id, provider) DO UPDATE SET status = EXCLUDED.status, settings = EXCLUDED.settings`,
        [s.auth.tenantId, rid, provider, body.status, settings, s.auth.userId],
      );
      await this.ops.audit(s, meta, 'integration.saved', 'integration', null, {
        provider,
        status: body.status,
      });
    });
  }

  disconnect(
    auth: AuthContext,
    provider: string,
    restaurantId: string | undefined,
    meta: RequestMeta,
  ) {
    return this.ops.run(auth, async (s) => {
      const rid = this.ops.restaurant(s.access, 'restaurant:manage', restaurantId);
      await s.db.query('DELETE FROM integrations WHERE restaurant_id = $1 AND provider = $2', [
        rid,
        provider,
      ]);
      await this.ops.audit(s, meta, 'integration.disconnected', 'integration', null, { provider });
    });
  }

  // ---------------------------------------------------------------- notifications

  notifications(auth: AuthContext, restaurantId?: string) {
    return this.ops.run(auth, async (s) => {
      const rid = this.ops.readRestaurant(s.access, 'restaurant:read', restaurantId);
      const prefRows = await s.db.query<{ event: string; in_app: boolean }>(
        'SELECT event, in_app FROM notification_preferences WHERE restaurant_id = $1',
        [rid],
      );
      const prefs = Object.fromEntries(
        (Object.keys(EVENTS) as EventKey[]).map((k) => [
          k,
          prefRows.find((p) => p.event === k)?.in_app ?? true,
        ]),
      ) as Record<EventKey, boolean>;
      const branchIds = s.access.allBranches.filter((b) => b.restaurantId === rid).map((b) => b.id);
      const currency = await this.ops.currency(s.db, rid);
      const alerts: {
        event: EventKey;
        level: 'info' | 'warning' | 'critical';
        title: string;
        detail: string;
        href: string;
        at: string | null;
      }[] = [];

      if (prefs.low_stock) {
        const low = await s.db.query<{
          name: string;
          branch: string;
          quantity: string;
          unit: string;
        }>(
          `SELECT i.name, b.name AS branch, s.quantity, i.unit FROM inventory_stock s
             JOIN inventory_items i ON i.id = s.item_id JOIN branches b ON b.id = s.branch_id
            WHERE s.branch_id = ANY($1::uuid[]) AND i.deleted_at IS NULL AND i.is_active
              AND s.quantity <= i.low_stock_threshold ORDER BY s.quantity LIMIT 20`,
          [branchIds],
        );
        for (const l of low) {
          alerts.push({
            event: 'low_stock',
            level: Number(l.quantity) <= 0 ? 'critical' : 'warning',
            title:
              Number(l.quantity) <= 0 ? `${l.name} is out of stock` : `${l.name} is running low`,
            detail: `${Number(l.quantity)} ${l.unit} left at ${l.branch}`,
            href: '/restaurant/inventory',
            at: null,
          });
        }
      }
      if (prefs.cash_variance) {
        const v = await s.db.query<{
          branch: string;
          closed_at: string;
          expected: string;
          counted: string;
        }>(
          `SELECT b.name AS branch, c.closed_at, c.expected_cash_minor AS expected, c.counted_cash_minor AS counted
             FROM cash_sessions c JOIN branches b ON b.id = c.branch_id
            WHERE c.branch_id = ANY($1::uuid[]) AND c.status = 'closed' AND c.closed_at > now() - interval '7 days'
              AND c.counted_cash_minor <> c.expected_cash_minor ORDER BY c.closed_at DESC LIMIT 10`,
          [branchIds],
        );
        for (const r of v) {
          const diff = Number(r.counted) - Number(r.expected);
          alerts.push({
            event: 'cash_variance',
            level: Math.abs(diff) >= 50_000 ? 'critical' : 'warning',
            title: `Cash ${diff < 0 ? 'short' : 'over'} by ${fmt(Math.abs(diff), currency)}`,
            detail: `Register closed at ${r.branch}`,
            href: '/restaurant/shift-closing',
            at: iso(r.closed_at),
          });
        }
      }
      if (prefs.register_open_long) {
        const open = await s.db.query<{ branch: string; opened_at: string }>(
          `SELECT b.name AS branch, c.opened_at FROM cash_sessions c JOIN branches b ON b.id = c.branch_id
            WHERE c.branch_id = ANY($1::uuid[]) AND c.status = 'open' AND c.opened_at < now() - interval '14 hours'`,
          [branchIds],
        );
        for (const r of open) {
          alerts.push({
            event: 'register_open_long',
            level: 'warning',
            title: `Register still open at ${r.branch}`,
            detail: 'Close the shift and count the cash.',
            href: '/restaurant/cash-register',
            at: iso(r.opened_at),
          });
        }
      }
      if (prefs.reservations_today) {
        const r = await s.db.one<{ n: string; guests: string | null }>(
          `SELECT count(*) AS n, sum(party_size) AS guests FROM reservations r JOIN branches b ON b.id = r.branch_id
            WHERE r.branch_id = ANY($1::uuid[]) AND r.status = 'booked'
              AND (r.reserved_at AT TIME ZONE b.timezone)::date = (now() AT TIME ZONE b.timezone)::date`,
          [branchIds],
        );
        if (Number(r?.n ?? 0) > 0) {
          alerts.push({
            event: 'reservations_today',
            level: 'info',
            title: `${r!.n} reservation${r!.n === '1' ? '' : 's'} today`,
            detail: `${r!.guests} guests expected`,
            href: '/restaurant/reservations',
            at: null,
          });
        }
      }
      if (prefs.po_overdue) {
        const po = await s.db.query<{ po_number: number; supplier: string; expected_on: string }>(
          `SELECT po.po_number, sp.name AS supplier, po.expected_on::text FROM purchase_orders po
             JOIN suppliers sp ON sp.id = po.supplier_id
            WHERE po.restaurant_id = $1 AND po.status = 'ordered' AND po.expected_on < current_date
            ORDER BY po.expected_on LIMIT 10`,
          [rid],
        );
        for (const p of po) {
          alerts.push({
            event: 'po_overdue',
            level: 'warning',
            title: `PO #${p.po_number} from ${p.supplier} is overdue`,
            detail: `Expected on ${p.expected_on}`,
            href: '/restaurant/purchase-orders',
            at: null,
          });
        }
      }
      if (prefs.refunds_today) {
        const rf = await s.db.one<{ n: string; total: string | null }>(
          `SELECT count(*) AS n, sum(rf.amount_minor) AS total FROM refunds rf JOIN payments p ON p.id = rf.payment_id
            WHERE p.branch_id = ANY($1::uuid[]) AND rf.created_at > now() - interval '24 hours'`,
          [branchIds],
        );
        if (Number(rf?.n ?? 0) > 0) {
          alerts.push({
            event: 'refunds_today',
            level: 'info',
            title: `${rf!.n} refund${rf!.n === '1' ? '' : 's'} in the last 24 hours`,
            detail: `${fmt(Number(rf!.total ?? 0), currency)} returned to customers`,
            href: '/restaurant/refunds',
            at: null,
          });
        }
      }
      const order = { critical: 0, warning: 1, info: 2 };
      alerts.sort((a, b) => order[a.level] - order[b.level]);
      return {
        restaurantId: rid,
        canManage: this.ops.can(s.access, 'restaurant:manage', { restaurantId: rid }),
        events: (Object.keys(EVENTS) as EventKey[]).map((k) => ({
          key: k,
          label: EVENTS[k],
          enabled: prefs[k],
        })),
        alerts,
      };
    });
  }

  savePrefs(auth: AuthContext, body: z.infer<typeof prefsSchema>, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const rid = this.ops.restaurant(s.access, 'restaurant:manage', body.restaurantId);
      for (const [event, on] of Object.entries(body.prefs)) {
        await s.db.query(
          `INSERT INTO notification_preferences (tenant_id, restaurant_id, event, in_app, created_by) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, restaurant_id, event) DO UPDATE SET in_app = EXCLUDED.in_app`,
          [s.auth.tenantId, rid, event, on, s.auth.userId],
        );
      }
      await this.ops.audit(s, meta, 'notifications.updated', 'restaurant', rid, body.prefs);
    });
  }
}

const fmt = (minor: number, currency: string) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(minor / 100);

@ApiTags('Setup')
@Controller()
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Get('printers')
  @RequirePermission('branch:read')
  printers(
    @CurrentAuth() a: AuthContext,
    @Query(new ZodValidationPipe(branchQuery)) q: z.infer<typeof branchQuery>,
  ) {
    return this.setup.printers(a, q.branchId);
  }

  @Post('printers')
  @RequirePermission('branch:manage')
  createPrinter(
    @CurrentAuth() a: AuthContext,
    @Body(new ZodValidationPipe(printerSchema)) b: z.infer<typeof printerSchema>,
    @Req() r: Request,
  ) {
    return this.setup.createPrinter(a, b, requestMeta(r));
  }

  @Patch('printers/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('branch:manage')
  async updatePrinter(
    @CurrentAuth() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(printerUpdateSchema)) b: z.infer<typeof printerUpdateSchema>,
    @Req() r: Request,
  ) {
    await this.setup.updatePrinter(a, id, b, requestMeta(r));
  }

  @Delete('printers/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('branch:manage')
  async deletePrinter(
    @CurrentAuth() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() r: Request,
  ) {
    await this.setup.deletePrinter(a, id, requestMeta(r));
  }

  @Get('integrations')
  @RequirePermission('restaurant:read')
  integrations(
    @CurrentAuth() a: AuthContext,
    @Query(new ZodValidationPipe(restaurantQuery)) q: z.infer<typeof restaurantQuery>,
  ) {
    return this.setup.integrations(a, q.restaurantId);
  }

  @Put('integrations/:provider')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('restaurant:manage')
  async save(
    @CurrentAuth() a: AuthContext,
    @Param('provider') provider: string,
    @Body(new ZodValidationPipe(integrationSchema)) b: z.infer<typeof integrationSchema>,
    @Req() r: Request,
  ) {
    await this.setup.saveIntegration(a, provider, b, requestMeta(r));
  }

  @Delete('integrations/:provider')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('restaurant:manage')
  async disconnect(
    @CurrentAuth() a: AuthContext,
    @Param('provider') provider: string,
    @Query(new ZodValidationPipe(restaurantQuery)) q: z.infer<typeof restaurantQuery>,
    @Req() r: Request,
  ) {
    await this.setup.disconnect(a, provider, q.restaurantId, requestMeta(r));
  }

  @Get('notifications')
  @RequirePermission('restaurant:read')
  notifications(
    @CurrentAuth() a: AuthContext,
    @Query(new ZodValidationPipe(restaurantQuery)) q: z.infer<typeof restaurantQuery>,
  ) {
    return this.setup.notifications(a, q.restaurantId);
  }

  @Put('notifications/preferences')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('restaurant:manage')
  async savePrefs(
    @CurrentAuth() a: AuthContext,
    @Body(new ZodValidationPipe(prefsSchema)) b: z.infer<typeof prefsSchema>,
    @Req() r: Request,
  ) {
    await this.setup.savePrefs(a, b, requestMeta(r));
  }
}
