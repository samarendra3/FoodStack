import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { requestMeta } from '../../common/http/request-meta';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { type Db, DbContext } from '../../core/db/db-context';
import { ACTIVE_TENANT_STATUSES } from '../auth/access.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { CurrentAuth, Public, RequirePermission } from '../auth/decorators';
import { createOrderSchema, paymentSchema } from './orders.schemas';
import {
  type Actor,
  OrdersService,
  openTableSession,
  SESSION_SQL,
  type SessionRow,
} from './orders.service';

/*
 * QR guests and table sessions.
 *
 * Guests: scanning a table's QR code joins (or opens) that table's sitting and gives the device a
 * random token, `<tenantId>.<secret>`. Only its SHA-256 hash is stored. Re-scanning on the same
 * device sends the token back and restores the same guest, orders and balance. Every guest order
 * goes through OrdersService.createInTx (same pricing, numbering, limits, KDS) with an
 * Idempotency-Key scoped to the guest, and runs in the tenant's row-level security scope.
 *
 * Staff: view a table's sitting grouped by guest, take a payment for one guest, the staff orders
 * or the whole table, and close the sitting once nothing is open.
 */

/** A guest idle for this long must re-scan (which restores them while the sitting is open). */
const IDLE_MS = 12 * 60 * 60 * 1000;
const hash = (token: string) => createHash('sha256').update(token).digest();
const TOKEN = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;

const joinSchema = z.strictObject({
  tenantId: z.uuid(),
  tableId: z.uuid(),
  name: z.string().trim().max(20).optional(),
});
const guestOrderSchema = createOrderSchema.pick({ lines: true, note: true });
const payScopeSchema = paymentSchema.extend({
  guestId: z.uuid().optional(),
  unassigned: z.boolean().optional(),
});
const openQuery = z.strictObject({ branchId: z.uuid() });
const sessionQuery = z
  .strictObject({ tableId: z.uuid().optional(), sessionId: z.uuid().optional() })
  .refine((q) => q.tableId || q.sessionId, 'Send tableId or sessionId');

interface GuestRow {
  id: string;
  session_id: string;
  display_name: string;
  guest_number: number;
  last_seen_at: Date;
}

@Injectable()
export class GuestSessionsService {
  constructor(
    private readonly db: DbContext,
    private readonly orders: OrdersService,
  ) {}

  /** First scan, re-scan or recovery. Returns the device token and the guest's bill. */
  join(input: z.infer<typeof joinSchema>, token: string | undefined) {
    return this.db.run({ tenantId: input.tenantId }, async (db) => {
      const table = await db.one<{
        id: string;
        branch_id: string;
        restaurant_id: string;
        tenant_status: string;
      }>(
        `SELECT t.id, t.branch_id, b.restaurant_id, tn.status AS tenant_status
           FROM dining_tables t
           JOIN branches b ON b.id = t.branch_id
           JOIN restaurants r ON r.id = b.restaurant_id AND r.status = 'active'
           JOIN tenants tn ON tn.id = t.tenant_id
          WHERE t.id = $1 AND t.deleted_at IS NULL`,
        [input.tableId],
      );
      // Same answer for "no such table" and "another tenant's table": nothing leaks.
      if (!table)
        throw new NotFoundException({
          code: 'TABLE_NOT_FOUND',
          message: 'This table QR code is not valid.',
        });
      if (!ACTIVE_TENANT_STATUSES.includes(table.tenant_status)) {
        throw new ConflictException({
          code: 'ORDERING_UNAVAILABLE',
          message: 'Ordering is not available right now.',
        });
      }

      // Re-scan on the same device: same guest while the sitting at this table is open.
      const m = token ? TOKEN.exec(token) : null;
      if (m && m[1] === input.tenantId) {
        const g = await db.one<GuestRow & { status: string; table_id: string }>(
          `SELECT g.id, g.session_id, g.display_name, g.guest_number, g.last_seen_at, s.status, s.table_id
             FROM table_guests g JOIN table_sessions s ON s.id = g.session_id WHERE g.token_hash = $1`,
          [hash(token!)],
        );
        if (g && g.status === 'open' && g.table_id === table.id) {
          await db.query('UPDATE table_guests SET last_seen_at = now() WHERE id = $1', [g.id]);
          return { token: token!, restored: true, ...(await this.view(db, g.session_id, g.id)) };
        }
      }

      // New guest (first scan, a closed sitting, or another table): join or open the sitting.
      const sessionId = await openTableSession(db, input.tenantId, table.branch_id, table.id, 'qr');
      // openTableSession holds the per-table lock, so guest numbers cannot collide.
      const next = await db.one<{ n: number }>(
        'SELECT coalesce(max(guest_number), 0) + 1 AS n FROM table_guests WHERE session_id = $1',
        [sessionId],
      );
      const fresh = `${input.tenantId}.${randomBytes(32).toString('base64url')}`;
      const g = await db.one<{ id: string }>(
        `INSERT INTO table_guests (tenant_id, session_id, token_hash, display_name, guest_number)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [input.tenantId, sessionId, hash(fresh), input.name || `Guest ${next!.n}`, next!.n],
      );
      return { token: fresh, restored: false, ...(await this.view(db, sessionId, g!.id)) };
    });
  }

  /** The guest's own bill: their orders, kitchen status, paid and outstanding. */
  me(token: string | undefined) {
    return this.asGuest(token, async (db, g) => this.view(db, g.session_id, g.id));
  }

  /** Places one more order for this guest at this sitting. */
  async order(
    token: string | undefined,
    input: z.infer<typeof guestOrderSchema>,
    key: string | null,
    meta: RequestMeta,
  ) {
    if (!key) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Send an Idempotency-Key header.',
      });
    }
    let created: { tenantId: string; branchId: string } | null = null;
    const result = await this.asGuest(token, async (db, g, tenantId) => {
      // Shares the row with closeSession (FOR UPDATE): a sitting cannot close mid-order.
      const s = await db.one<SessionRow>(`${SESSION_SQL} WHERE s.id = $1 FOR SHARE OF s`, [
        g.session_id,
      ]);
      if (!s || s.status !== 'open') throw sessionClosed();
      const actor: Actor = { tenantId, userId: null, sessionId: null, audience: 'system' };
      const order = await this.orders.createInTx(
        db,
        actor,
        {
          branchId: s.branch_id,
          channel: 'qr',
          tableLabel: s.table_label,
          billLabel: g.display_name,
          note: input.note ?? null,
          couponCode: null,
          customer: null,
          lines: input.lines,
        },
        `guest:${g.id}:${key}`,
        meta,
        { sessionId: s.id, guestId: g.id, billLabel: g.display_name },
      );
      created = { tenantId, branchId: s.branch_id };
      return { order, ...(await this.view(db, s.id, g.id)) };
    });
    // After commit, same event as staff orders: the branch's kitchens ring for QR orders too.
    const c = created as { tenantId: string; branchId: string } | null;
    if (c) await this.orders.publishCreated(c.tenantId, c.branchId, result.order.id);
    return result;
  }

  private async view(db: Db, sessionId: string, guestId: string) {
    const s = await db.one<SessionRow>(`${SESSION_SQL} WHERE s.id = $1`, [sessionId]);
    const v = await this.orders.sessionView(db, s!, guestId);
    const r = await db.one<{ restaurant_id: string; name: string }>(
      `SELECT r.id AS restaurant_id, r.name FROM branches b JOIN restaurants r ON r.id = b.restaurant_id WHERE b.id = $1`,
      [s!.branch_id],
    );
    return {
      restaurant: { id: r!.restaurant_id, name: r!.name },
      session: v.session,
      guest: v.guests[0] ?? null,
    };
  }

  /** Resolves the token inside its tenant's RLS scope; expired or closed sittings must re-scan. */
  private asGuest<T>(
    token: string | undefined,
    work: (db: Db, g: GuestRow, tenantId: string) => Promise<T>,
  ) {
    const m = token ? TOKEN.exec(token) : null;
    if (!m) throw invalidGuest();
    const tenantId = m[1]!;
    return this.db.run({ tenantId }, async (db) => {
      const g = await db.one<GuestRow & { status: string }>(
        `SELECT g.id, g.session_id, g.display_name, g.guest_number, g.last_seen_at, s.status
           FROM table_guests g JOIN table_sessions s ON s.id = g.session_id WHERE g.token_hash = $1`,
        [hash(token!)],
      );
      if (!g) throw invalidGuest();
      if (g.status !== 'open') throw sessionClosed();
      if (Date.now() - new Date(g.last_seen_at).getTime() > IDLE_MS) {
        throw new UnauthorizedException({
          code: 'GUEST_SESSION_EXPIRED',
          message: 'Scan the table QR code again to continue.',
        });
      }
      await db.query('UPDATE table_guests SET last_seen_at = now() WHERE id = $1', [g.id]);
      return work(db, g, tenantId);
    });
  }
}

const invalidGuest = () =>
  new UnauthorizedException({
    code: 'GUEST_TOKEN_INVALID',
    message: 'Scan the table QR code to start ordering.',
  });
const sessionClosed = () =>
  new ConflictException({
    code: 'SESSION_CLOSED',
    message: 'This table has been closed. Scan the QR code again to start a new bill.',
  });
const idempotencyKey = (v: string | undefined) => (v && /^[A-Za-z0-9_-]{8,80}$/.test(v) ? v : null);

@ApiTags('QR guests')
@Public()
@Controller('public/guest')
export class GuestSessionsController {
  constructor(private readonly guests: GuestSessionsService) {}

  @Post('join')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Join (or re-join) a table from its QR code; returns the guest token' })
  join(
    @Body(new ZodValidationPipe(joinSchema)) body: z.infer<typeof joinSchema>,
    @Headers('x-guest-token') token: string | undefined,
  ) {
    return this.guests.join(body, token);
  }

  @Get()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: "The guest's orders, kitchen status and balance" })
  me(@Headers('x-guest-token') token: string | undefined) {
    return this.guests.me(token);
  }

  @Post('orders')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Place another order as this guest (send Idempotency-Key)' })
  order(
    @Headers('x-guest-token') token: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodValidationPipe(guestOrderSchema)) body: z.infer<typeof guestOrderSchema>,
    @Req() req: Request,
  ) {
    return this.guests.order(token, body, idempotencyKey(key), requestMeta(req));
  }
}

@ApiTags('Table sessions')
@Controller('table-sessions')
export class TableSessionsController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @RequirePermission('menu:read')
  @ApiOperation({ summary: "A table's current (or a given) sitting, grouped by guest" })
  get(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(sessionQuery)) q: z.infer<typeof sessionQuery>,
  ) {
    return this.orders.tableSession(auth, q);
  }

  @Get('open')
  @RequirePermission('menu:read')
  @ApiOperation({ summary: 'Open sittings at a branch with balances' })
  open(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(openQuery)) q: z.infer<typeof openQuery>,
  ) {
    return this.orders.openSessions(auth, q.branchId);
  }

  @Post(':id/payments')
  @RequirePermission('pos:access')
  @ApiOperation({ summary: 'Pay a guest balance, the staff orders, or the whole table' })
  pay(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(payScopeSchema)) body: z.infer<typeof payScopeSchema>,
    @Req() req: Request,
  ) {
    const { guestId, unassigned, ...payment } = body;
    return this.orders.paySession(auth, id, { guestId, unassigned }, payment, requestMeta(req));
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('menu:read')
  @ApiOperation({ summary: 'Close the sitting (all bills settled)' })
  async close(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    await this.orders.closeSession(auth, id, requestMeta(req));
  }
}
