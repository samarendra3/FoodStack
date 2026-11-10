import {
  Body,
  ConflictException,
  Controller,
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
  dateStr,
  invalid,
  iso,
  notFound,
  OpsBase,
  optText,
  type Scope,
  setClause,
} from './ops-base';

/*
 * Reservations (per branch, double-booking of a table is refused) and the loyalty programme.
 * Loyalty points are earned from completed bills (computed from orders, so they never drift) and
 * spent or corrected through the ledger.
 */

const STATUSES = ['booked', 'seated', 'completed', 'cancelled', 'no_show'] as const;
const phone = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^\+?[0-9]{6,15}$/, 'Enter a valid phone number'));

const reservationSchema = z.strictObject({
  branchId: z.uuid(),
  customerName: z.string().trim().min(1).max(80),
  phone,
  partySize: z.coerce.number().int().min(1).max(100),
  reservedAt: z.iso.datetime({ offset: true }),
  durationMinutes: z.coerce.number().int().min(15).max(600).default(90),
  tableId: z.uuid().nullable().optional(),
  note: optText(300),
});
const reservationUpdateSchema = reservationSchema
  .omit({ branchId: true })
  .partial()
  .extend({ status: z.enum(STATUSES).optional() });
const reservationListSchema = z.strictObject({
  branchId: z.uuid().optional(),
  date: dateStr.optional(),
});

const programSchema = z.strictObject({
  restaurantId: z.uuid().optional(),
  isEnabled: z.boolean(),
  pointsPer100: z.coerce.number().int().min(0).max(1000),
  pointValueMinor: z.coerce.number().int().min(1).max(100000),
  minRedeemPoints: z.coerce.number().int().min(0).max(1_000_000),
});
const pointsSchema = z.strictObject({
  restaurantId: z.uuid().optional(),
  kind: z.enum(['redeem', 'adjust']),
  points: z.coerce
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((v) => v !== 0, 'Enter points'),
  reason: z.string().trim().min(2).max(200),
});
const loyaltyListSchema = z.strictObject({
  restaurantId: z.uuid().optional(),
  search: z.string().trim().max(80).optional(),
});

@Injectable()
export class FloorService {
  constructor(private readonly ops: OpsBase) {}

  // ---------------------------------------------------------------- reservations

  reservations(auth: AuthContext, q: z.infer<typeof reservationListSchema>) {
    return this.ops.run(auth, async (s) => {
      const b = this.ops.branch(s.access, 'reservation:read', q.branchId);
      const tz = await s.db.one<{ timezone: string; today: string }>(
        `SELECT timezone, (now() AT TIME ZONE timezone)::date::text AS today FROM branches WHERE id = $1`,
        [b.id],
      );
      const day = q.date ?? tz!.today;
      const rows = await s.db.query<Record<string, unknown>>(
        `SELECT r.id, r.customer_name, r.phone, r.party_size, r.reserved_at, r.duration_minutes, r.table_id,
                t.label AS table_label, r.status, r.note
           FROM reservations r LEFT JOIN dining_tables t ON t.id = r.table_id
          WHERE r.branch_id = $1
            AND r.reserved_at >= ($2::date::timestamp AT TIME ZONE $3)
            AND r.reserved_at < (($2::date + 1)::timestamp AT TIME ZONE $3)
          ORDER BY r.reserved_at`,
        [b.id, day, tz!.timezone],
      );
      const tables = await s.db.query<{ id: string; label: string; seats: number; area: string }>(
        `SELECT id, label, seats, area FROM dining_tables WHERE branch_id = $1 AND deleted_at IS NULL ORDER BY area, sort_order, label`,
        [b.id],
      );
      return {
        branch: { id: b.id, name: b.name },
        branches: this.ops.branchList(s.access, 'reservation:read'),
        date: day,
        timezone: tz!.timezone,
        canManage: this.ops.can(s.access, 'reservation:manage', { branchId: b.id }),
        tables,
        rows: rows.map((r) => ({
          id: r.id,
          customerName: r.customer_name,
          phone: r.phone,
          partySize: Number(r.party_size),
          reservedAt: iso(r.reserved_at as string),
          durationMinutes: Number(r.duration_minutes),
          tableId: r.table_id,
          tableLabel: r.table_label,
          status: r.status,
          note: r.note,
        })),
      };
    });
  }

  createReservation(auth: AuthContext, body: z.infer<typeof reservationSchema>, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const b = this.ops.branch(s.access, 'reservation:manage', body.branchId);
      if (new Date(body.reservedAt).getTime() < Date.now() - 60 * 60_000) {
        throw invalid('The reservation time is in the past.');
      }
      await this.checkTable(
        s,
        b.id,
        body.tableId ?? null,
        body.reservedAt,
        body.durationMinutes,
        body.partySize,
      );
      const row = await s.db.one<{ id: string }>(
        `INSERT INTO reservations (tenant_id, branch_id, customer_name, phone, party_size, reserved_at, duration_minutes, table_id, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          s.auth.tenantId,
          b.id,
          body.customerName,
          body.phone,
          body.partySize,
          body.reservedAt,
          body.durationMinutes,
          body.tableId ?? null,
          body.note ?? null,
          s.auth.userId,
        ],
      );
      await this.ops.audit(s, meta, 'reservation.created', 'reservation', row!.id, {
        reservedAt: body.reservedAt,
        partySize: body.partySize,
      });
      return { id: row!.id };
    });
  }

  updateReservation(
    auth: AuthContext,
    id: string,
    body: z.infer<typeof reservationUpdateSchema>,
    meta: RequestMeta,
  ) {
    return this.ops.run(auth, async (s) => {
      const r = await s.db.one<{
        branch_id: string;
        reserved_at: string;
        duration_minutes: number;
        table_id: string | null;
        party_size: number;
        status: string;
      }>(
        'SELECT branch_id, reserved_at, duration_minutes, table_id, party_size, status FROM reservations WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!r) throw notFound('Reservation');
      this.ops.branch(s.access, 'reservation:manage', r.branch_id);
      const nextStatus = body.status ?? r.status;
      if (['booked', 'seated'].includes(nextStatus)) {
        await this.checkTable(
          s,
          r.branch_id,
          body.tableId === undefined ? r.table_id : body.tableId,
          body.reservedAt ?? new Date(r.reserved_at).toISOString(),
          body.durationMinutes ?? r.duration_minutes,
          body.partySize ?? r.party_size,
          id,
        );
      }
      const params: unknown[] = [id];
      const set = setClause(
        body,
        {
          customerName: 'customer_name',
          phone: 'phone',
          partySize: 'party_size',
          reservedAt: 'reserved_at',
          durationMinutes: 'duration_minutes',
          tableId: 'table_id',
          note: 'note',
          status: 'status',
        },
        params,
      );
      if (!set) return;
      await s.db.query(`UPDATE reservations SET ${set} WHERE id = $1`, params);
      await this.ops.audit(
        s,
        meta,
        body.status ? `reservation.${body.status}` : 'reservation.updated',
        'reservation',
        id,
        body,
      );
    });
  }

  /** The table must be at the branch, seat the party and be free for the slot. */
  private async checkTable(
    s: Scope,
    branchId: string,
    tableId: string | null,
    at: string,
    minutes: number,
    party: number,
    except?: string,
  ) {
    if (!tableId) return;
    const t = await s.db.one<{ seats: number; label: string }>(
      'SELECT seats, label FROM dining_tables WHERE id = $1 AND branch_id = $2 AND deleted_at IS NULL',
      [tableId, branchId],
    );
    if (!t) throw invalid('That table is not at this branch.');
    if (party > t.seats * 2)
      throw invalid(`Table ${t.label} seats ${t.seats}; pick a larger table.`);
    const clash = await s.db.one<{ customer_name: string; reserved_at: string }>(
      `SELECT customer_name, reserved_at FROM reservations
        WHERE table_id = $1 AND status IN ('booked', 'seated') AND ($4::uuid IS NULL OR id <> $4)
          AND reserved_at < ($2::timestamptz + make_interval(mins => $3))
          AND reserved_at + make_interval(mins => duration_minutes) > $2::timestamptz
        LIMIT 1`,
      [tableId, at, minutes, except ?? null],
    );
    if (clash) {
      throw new ConflictException({
        code: 'TABLE_BOOKED',
        message: `Table ${t.label} is already booked for ${clash.customer_name} at that time.`,
      });
    }
  }

  // ---------------------------------------------------------------- loyalty

  loyalty(auth: AuthContext, q: z.infer<typeof loyaltyListSchema>) {
    return this.ops.run(auth, async (s) => {
      const rid = this.ops.readRestaurant(s.access, 'order:read', q.restaurantId);
      const program = await this.program(s, rid);
      const params: unknown[] = [rid, program.pointsPer100];
      let filter = '';
      if (q.search) {
        params.push(`%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        filter = `AND (c.name ILIKE $${params.length} OR c.phone ILIKE $${params.length})`;
      }
      const rows = await s.db.query<Record<string, string | null>>(
        `WITH spend AS (
           SELECT customer_id, sum(total_minor) AS spent, count(*) AS visits, max(completed_at) AS last_visit
             FROM orders WHERE restaurant_id = $1 AND status = 'completed' AND customer_id IS NOT NULL
            GROUP BY customer_id),
         ledger AS (
           SELECT customer_id, sum(points) AS pts, sum(-points) FILTER (WHERE kind = 'redeem') AS redeemed
             FROM loyalty_ledger WHERE restaurant_id = $1 GROUP BY customer_id)
         SELECT c.id, c.name, c.phone, sp.spent, sp.visits, sp.last_visit,
                floor(sp.spent / 10000.0 * $2)::bigint AS earned,
                coalesce(l.pts, 0) AS ledger, coalesce(l.redeemed, 0) AS redeemed
           FROM spend sp JOIN customers c ON c.id = sp.customer_id
           LEFT JOIN ledger l ON l.customer_id = sp.customer_id
          WHERE true ${filter}
          ORDER BY sp.spent DESC LIMIT 300`,
        params,
      );
      const customers = rows.map((r) => {
        const earned = Number(r.earned ?? 0);
        const balance = Math.max(0, earned + Number(r.ledger ?? 0));
        return {
          id: r.id,
          name: r.name,
          phone: r.phone,
          spentMinor: Number(r.spent ?? 0),
          visits: Number(r.visits ?? 0),
          lastVisit: iso(r.last_visit ?? null),
          earned,
          redeemed: Number(r.redeemed ?? 0),
          balance,
          balanceValueMinor: balance * program.pointValueMinor,
          tier: tierFor(Number(r.spent ?? 0)),
        };
      });
      return {
        restaurantId: rid,
        currencyCode: await this.ops.currency(s.db, rid),
        canManage: this.ops.can(s.access, 'loyalty:manage', { restaurantId: rid }),
        program,
        totals: {
          members: customers.length,
          outstandingPoints: customers.reduce((t, c) => t + c.balance, 0),
          outstandingValueMinor: customers.reduce((t, c) => t + c.balanceValueMinor, 0),
        },
        customers,
      };
    });
  }

  setProgram(auth: AuthContext, body: z.infer<typeof programSchema>, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const rid = this.ops.restaurant(s.access, 'loyalty:manage', body.restaurantId);
      await s.db.query(
        `INSERT INTO loyalty_programs (tenant_id, restaurant_id, is_enabled, points_per_100, point_value_minor, min_redeem_points, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, restaurant_id) DO UPDATE SET is_enabled = EXCLUDED.is_enabled,
           points_per_100 = EXCLUDED.points_per_100, point_value_minor = EXCLUDED.point_value_minor,
           min_redeem_points = EXCLUDED.min_redeem_points`,
        [
          s.auth.tenantId,
          rid,
          body.isEnabled,
          body.pointsPer100,
          body.pointValueMinor,
          body.minRedeemPoints,
          s.auth.userId,
        ],
      );
      await this.ops.audit(s, meta, 'loyalty.program_updated', 'restaurant', rid, body);
    });
  }

  points(
    auth: AuthContext,
    customerId: string,
    body: z.infer<typeof pointsSchema>,
    meta: RequestMeta,
  ) {
    return this.ops.run(auth, async (s) => {
      const rid = this.ops.restaurant(s.access, 'loyalty:manage', body.restaurantId);
      const program = await this.program(s, rid);
      if (!program.isEnabled) throw invalid('Turn the loyalty programme on first.');
      // Serialize point changes per customer so two redemptions cannot overspend.
      await s.db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `loyalty:${rid}:${customerId}`,
      ]);
      const bal = await s.db.one<{ earned: string | null; ledger: string | null; exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM customers WHERE id = $2) AS exists,
                (SELECT floor(sum(total_minor) / 10000.0 * $3)::bigint FROM orders
                  WHERE restaurant_id = $1 AND customer_id = $2 AND status = 'completed') AS earned,
                (SELECT sum(points) FROM loyalty_ledger WHERE restaurant_id = $1 AND customer_id = $2) AS ledger`,
        [rid, customerId, program.pointsPer100],
      );
      if (!bal?.exists) throw notFound('Customer');
      const balance = Number(bal.earned ?? 0) + Number(bal.ledger ?? 0);
      const delta = body.kind === 'redeem' ? -Math.abs(body.points) : body.points;
      if (body.kind === 'redeem' && Math.abs(body.points) < program.minRedeemPoints) {
        throw invalid(`At least ${program.minRedeemPoints} points must be redeemed at a time.`);
      }
      if (balance + delta < 0)
        throw invalid(`The customer has only ${Math.max(0, balance)} points.`);
      await s.db.query(
        `INSERT INTO loyalty_ledger (tenant_id, restaurant_id, customer_id, points, kind, reason, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [s.auth.tenantId, rid, customerId, delta, body.kind, body.reason, s.auth.userId],
      );
      await this.ops.audit(s, meta, `loyalty.${body.kind}`, 'customer', customerId, {
        points: delta,
      });
      return { balance: balance + delta, valueMinor: Math.abs(delta) * program.pointValueMinor };
    });
  }

  private async program(s: Scope, rid: string) {
    const p = await s.db.one<{
      is_enabled: boolean;
      points_per_100: number;
      point_value_minor: number;
      min_redeem_points: number;
    }>(
      'SELECT is_enabled, points_per_100, point_value_minor, min_redeem_points FROM loyalty_programs WHERE restaurant_id = $1',
      [rid],
    );
    return {
      isEnabled: p?.is_enabled ?? false,
      pointsPer100: p?.points_per_100 ?? 1,
      pointValueMinor: p?.point_value_minor ?? 100,
      minRedeemPoints: p?.min_redeem_points ?? 100,
    };
  }
}

/** Spend tiers (minor units): Bronze, Silver from ₹5,000, Gold from ₹20,000. */
function tierFor(spentMinor: number): 'bronze' | 'silver' | 'gold' {
  if (spentMinor >= 2_000_000) return 'gold';
  if (spentMinor >= 500_000) return 'silver';
  return 'bronze';
}

@ApiTags('Floor')
@Controller()
export class FloorController {
  constructor(private readonly f: FloorService) {}

  @Get('reservations')
  @RequirePermission('reservation:read')
  reservations(
    @CurrentAuth() a: AuthContext,
    @Query(new ZodValidationPipe(reservationListSchema)) q: z.infer<typeof reservationListSchema>,
  ) {
    return this.f.reservations(a, q);
  }

  @Post('reservations')
  @RequirePermission('reservation:manage')
  create(
    @CurrentAuth() a: AuthContext,
    @Body(new ZodValidationPipe(reservationSchema)) b: z.infer<typeof reservationSchema>,
    @Req() r: Request,
  ) {
    return this.f.createReservation(a, b, requestMeta(r));
  }

  @Patch('reservations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('reservation:manage')
  async update(
    @CurrentAuth() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(reservationUpdateSchema))
    b: z.infer<typeof reservationUpdateSchema>,
    @Req() r: Request,
  ) {
    await this.f.updateReservation(a, id, b, requestMeta(r));
  }

  @Get('loyalty')
  @RequirePermission('order:read')
  loyalty(
    @CurrentAuth() a: AuthContext,
    @Query(new ZodValidationPipe(loyaltyListSchema)) q: z.infer<typeof loyaltyListSchema>,
  ) {
    return this.f.loyalty(a, q);
  }

  @Put('loyalty/program')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('loyalty:manage')
  async setProgram(
    @CurrentAuth() a: AuthContext,
    @Body(new ZodValidationPipe(programSchema)) b: z.infer<typeof programSchema>,
    @Req() r: Request,
  ) {
    await this.f.setProgram(a, b, requestMeta(r));
  }

  @Post('loyalty/customers/:id/points')
  @RequirePermission('loyalty:manage')
  points(
    @CurrentAuth() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(pointsSchema)) b: z.infer<typeof pointsSchema>,
    @Req() r: Request,
  ) {
    return this.f.points(a, id, b, requestMeta(r));
  }
}
