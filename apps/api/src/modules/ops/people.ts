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
  forbidden,
  invalid,
  iso,
  notFound,
  OpsBase,
  optText,
  type Scope,
} from './ops-base';

/*
 * Attendance (staff clock themselves in and out; managers review and fix), the shift rota,
 * staff performance from orders each person took, and custom roles.
 */

const clockInSchema = z.strictObject({ branchId: z.uuid() });
const clockOutSchema = z.strictObject({ note: optText(200) });
const rangeSchema = z.strictObject({
  branchId: z.uuid().optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
});
const fixSchema = z.strictObject({
  clockOut: z.iso.datetime({ offset: true }),
  note: optText(200),
});
const shiftSchema = z
  .strictObject({
    branchId: z.uuid(),
    userId: z.uuid(),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    roleLabel: optText(40),
  })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), {
    message: 'End must be after start',
    path: ['endsAt'],
  });
const shiftListSchema = z.strictObject({
  branchId: z.uuid().optional(),
  weekStart: dateStr.optional(),
});
const roleSchema = z.strictObject({
  name: z.string().trim().min(2).max(80),
  description: optText(200),
  permissions: z.array(z.string().max(64)).min(1).max(200),
});
const roleUpdateSchema = roleSchema.partial();

/** Never grantable through a custom role. */
const RESERVED = new Set(['role:manage', 'tenant:manage', 'billing:manage']);

@Injectable()
export class PeopleService {
  constructor(private readonly ops: OpsBase) {}

  // ---------------------------------------------------------------- attendance

  me(auth: AuthContext) {
    return this.ops.run(auth, async (s) => {
      const open = await s.db.one<{
        id: string;
        clock_in: string;
        branch_id: string;
        branch_name: string;
      }>(
        `SELECT a.id, a.clock_in, a.branch_id, b.name AS branch_name FROM attendance_entries a
           JOIN branches b ON b.id = a.branch_id WHERE a.user_id = $1 AND a.clock_out IS NULL`,
        [s.auth.userId],
      );
      const week = await s.db.one<{ minutes: string | null }>(
        `SELECT sum(extract(epoch FROM (coalesce(clock_out, now()) - clock_in)) / 60) AS minutes
           FROM attendance_entries WHERE user_id = $1 AND clock_in >= date_trunc('week', now())`,
        [s.auth.userId],
      );
      return {
        branches: this.ops.branchList(s.access, 'attendance:self'),
        open: open
          ? {
              id: open.id,
              clockIn: iso(open.clock_in),
              branchId: open.branch_id,
              branchName: open.branch_name,
            }
          : null,
        weekMinutes: Math.round(Number(week?.minutes ?? 0)),
      };
    });
  }

  clockIn(auth: AuthContext, body: z.infer<typeof clockInSchema>, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const b = this.ops.branch(s.access, 'attendance:self', body.branchId);
      const open = await s.db.one(
        'SELECT 1 FROM attendance_entries WHERE user_id = $1 AND clock_out IS NULL',
        [s.auth.userId],
      );
      if (open)
        throw new ConflictException({
          code: 'ALREADY_CLOCKED_IN',
          message: 'You are already clocked in.',
        });
      const row = await s.db.one<{ id: string }>(
        `INSERT INTO attendance_entries (tenant_id, branch_id, user_id, created_by) VALUES ($1, $2, $3, $3) RETURNING id`,
        [s.auth.tenantId, b.id, s.auth.userId],
      );
      await this.ops.audit(s, meta, 'attendance.clock_in', 'attendance', row!.id, {
        branchId: b.id,
      });
      return { id: row!.id };
    });
  }

  clockOut(auth: AuthContext, body: z.infer<typeof clockOutSchema>, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const open = await s.db.one<{ id: string }>(
        'SELECT id FROM attendance_entries WHERE user_id = $1 AND clock_out IS NULL FOR UPDATE',
        [s.auth.userId],
      );
      if (!open) throw invalid('You are not clocked in.', 'NOT_CLOCKED_IN');
      await s.db.query(
        `UPDATE attendance_entries SET clock_out = greatest(now(), clock_in + interval '1 second'), note = coalesce($2, note) WHERE id = $1`,
        [open.id, body.note ?? null],
      );
      await this.ops.audit(s, meta, 'attendance.clock_out', 'attendance', open.id);
    });
  }

  attendance(auth: AuthContext, q: z.infer<typeof rangeSchema>) {
    return this.ops.run(auth, async (s) => {
      const branches = this.ops.branchList(s.access, 'member:read');
      if (branches.length === 0) throw forbidden('You cannot view attendance.');
      const ids = q.branchId
        ? [this.ops.branch(s.access, 'member:read', q.branchId).id]
        : branches.map((b) => b.id);
      const { from, to } = range(q.from, q.to, 7);
      const rows = await s.db.query<Record<string, unknown>>(
        `SELECT a.id, a.user_id, u.full_name, a.branch_id, b.name AS branch_name, a.clock_in, a.clock_out, a.note,
                extract(epoch FROM (coalesce(a.clock_out, now()) - a.clock_in)) / 60 AS minutes
           FROM attendance_entries a JOIN users u ON u.id = a.user_id JOIN branches b ON b.id = a.branch_id
          WHERE a.branch_id = ANY($1::uuid[])
            AND a.clock_in >= ($2::date::timestamp AT TIME ZONE b.timezone)
            AND a.clock_in < (($3::date + 1)::timestamp AT TIME ZONE b.timezone)
          ORDER BY a.clock_in DESC LIMIT 2000`,
        [ids, from, to],
      );
      const entries = rows.map((r) => ({
        id: r.id as string,
        userId: r.user_id as string,
        name: r.full_name as string,
        branchId: r.branch_id as string,
        branchName: r.branch_name as string,
        clockIn: iso(r.clock_in as string),
        clockOut: iso(r.clock_out as string | null),
        note: r.note as string | null,
        minutes: Math.round(Number(r.minutes)),
      }));
      const byPerson = new Map<
        string,
        { userId: string; name: string; minutes: number; days: Set<string>; open: boolean }
      >();
      for (const e of entries) {
        const p = byPerson.get(e.userId) ?? {
          userId: e.userId,
          name: e.name,
          minutes: 0,
          days: new Set(),
          open: false,
        };
        p.minutes += e.minutes;
        p.days.add(e.clockIn!.slice(0, 10));
        p.open ||= e.clockOut === null;
        byPerson.set(e.userId, p);
      }
      return {
        branches,
        from,
        to,
        canManage: this.ops.branchesWith(s.access, 'member:manage').length > 0,
        entries,
        people: [...byPerson.values()]
          .map((p) => ({
            userId: p.userId,
            name: p.name,
            minutes: p.minutes,
            days: p.days.size,
            onShift: p.open,
          }))
          .sort((a, b) => b.minutes - a.minutes),
      };
    });
  }

  /** A manager closes an entry someone forgot to clock out of. */
  fix(auth: AuthContext, id: string, body: z.infer<typeof fixSchema>, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const e = await s.db.one<{ branch_id: string; clock_in: string }>(
        'SELECT branch_id, clock_in FROM attendance_entries WHERE id = $1',
        [id],
      );
      if (!e) throw notFound('Attendance entry');
      this.ops.branch(s.access, 'member:manage', e.branch_id);
      if (new Date(body.clockOut) <= new Date(e.clock_in))
        throw invalid('Clock-out must be after clock-in.');
      if (new Date(body.clockOut).getTime() > Date.now())
        throw invalid('Clock-out cannot be in the future.');
      await s.db.query(
        'UPDATE attendance_entries SET clock_out = $2, note = coalesce($3, note) WHERE id = $1',
        [id, body.clockOut, body.note ?? null],
      );
      await this.ops.audit(s, meta, 'attendance.corrected', 'attendance', id, {
        clockOut: body.clockOut,
      });
    });
  }

  // ---------------------------------------------------------------- shifts

  shifts(auth: AuthContext, q: z.infer<typeof shiftListSchema>) {
    return this.ops.run(auth, async (s) => {
      const b = this.ops.branch(s.access, 'member:read', q.branchId);
      const tz = await s.db.one<{ timezone: string; monday: string }>(
        `SELECT timezone, date_trunc('week', (now() AT TIME ZONE timezone))::date::text AS monday FROM branches WHERE id = $1`,
        [b.id],
      );
      const week = q.weekStart ?? tz!.monday;
      const rows = await s.db.query<Record<string, unknown>>(
        `SELECT sh.id, sh.user_id, u.full_name, sh.starts_at, sh.ends_at, sh.role_label
           FROM staff_shifts sh JOIN users u ON u.id = sh.user_id
          WHERE sh.branch_id = $1
            AND sh.starts_at >= ($2::date::timestamp AT TIME ZONE $3)
            AND sh.starts_at < (($2::date + 7)::timestamp AT TIME ZONE $3)
          ORDER BY sh.starts_at`,
        [b.id, week, tz!.timezone],
      );
      return {
        branch: { id: b.id, name: b.name },
        branches: this.ops.branchList(s.access, 'member:read'),
        weekStart: week,
        timezone: tz!.timezone,
        canManage: this.ops.can(s.access, 'member:manage', { branchId: b.id }),
        staff: await this.staffAt(s, b.id),
        shifts: rows.map((r) => ({
          id: r.id,
          userId: r.user_id,
          name: r.full_name,
          startsAt: iso(r.starts_at as string),
          endsAt: iso(r.ends_at as string),
          roleLabel: r.role_label,
        })),
      };
    });
  }

  createShift(auth: AuthContext, body: z.infer<typeof shiftSchema>, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const b = this.ops.branch(s.access, 'member:manage', body.branchId);
      if ((new Date(body.endsAt).getTime() - new Date(body.startsAt).getTime()) / 3_600_000 > 24) {
        throw invalid('A shift can be at most 24 hours.');
      }
      const staff = await this.staffAt(s, b.id);
      if (!staff.some((m) => m.userId === body.userId))
        throw invalid('This person does not work at this branch.');
      const clash = await s.db.one(
        `SELECT 1 FROM staff_shifts WHERE user_id = $1 AND starts_at < $3 AND ends_at > $2`,
        [body.userId, body.startsAt, body.endsAt],
      );
      if (clash)
        throw new ConflictException({
          code: 'SHIFT_OVERLAP',
          message: 'This person already has a shift at that time.',
        });
      const row = await s.db.one<{ id: string }>(
        `INSERT INTO staff_shifts (tenant_id, branch_id, user_id, starts_at, ends_at, role_label, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          s.auth.tenantId,
          b.id,
          body.userId,
          body.startsAt,
          body.endsAt,
          body.roleLabel ?? null,
          s.auth.userId,
        ],
      );
      await this.ops.audit(s, meta, 'shift.created', 'staff_shift', row!.id, {
        userId: body.userId,
      });
      return { id: row!.id };
    });
  }

  deleteShift(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const sh = await s.db.one<{ branch_id: string }>(
        'SELECT branch_id FROM staff_shifts WHERE id = $1',
        [id],
      );
      if (!sh) throw notFound('Shift');
      this.ops.branch(s.access, 'member:manage', sh.branch_id);
      await s.db.query('DELETE FROM staff_shifts WHERE id = $1', [id]);
      await this.ops.audit(s, meta, 'shift.deleted', 'staff_shift', id);
    });
  }

  /** Active members who can work at a branch: tenant-wide, its restaurant, or the branch itself. */
  private async staffAt(s: Scope, branchId: string) {
    const rows = await s.db.query<{ user_id: string; full_name: string; roles: string[] }>(
      `SELECT m.user_id, u.full_name, array_agg(DISTINCT r.name) AS roles
         FROM tenant_memberships m
         JOIN users u ON u.id = m.user_id
         JOIN user_role_assignments a ON a.membership_id = m.id
         JOIN roles r ON r.id = a.role_id
         JOIN branches b ON b.id = $1
        WHERE m.status = 'active'
          AND (a.scope_type = 'tenant'
               OR (a.scope_type = 'restaurant' AND a.scope_id = b.restaurant_id)
               OR (a.scope_type = 'branch' AND a.scope_id = b.id))
        GROUP BY m.user_id, u.full_name ORDER BY u.full_name`,
      [branchId],
    );
    return rows.map((r) => ({ userId: r.user_id, name: r.full_name, roles: r.roles }));
  }

  // ---------------------------------------------------------------- staff performance

  performance(auth: AuthContext, q: z.infer<typeof rangeSchema>) {
    return this.ops.run(auth, async (s) => {
      const branches = this.ops.branchList(s.access, 'report:view');
      if (branches.length === 0) throw forbidden('You cannot view reports.');
      const ids = q.branchId
        ? [this.ops.branch(s.access, 'report:view', q.branchId).id]
        : branches.map((b) => b.id);
      const { from, to } = range(q.from, q.to, 30);
      const rows = await s.db.query<Record<string, string | null>>(
        `WITH o AS (
           SELECT o.created_by, o.status, o.total_minor, o.completed_at, o.created_at
             FROM orders o JOIN branches b ON b.id = o.branch_id
            WHERE o.branch_id = ANY($1::uuid[]) AND o.created_by IS NOT NULL
              AND o.created_at >= ($2::date::timestamp AT TIME ZONE b.timezone)
              AND o.created_at < (($3::date + 1)::timestamp AT TIME ZONE b.timezone)),
         att AS (
           SELECT a.user_id, sum(extract(epoch FROM (coalesce(a.clock_out, now()) - a.clock_in)) / 3600) AS hours
             FROM attendance_entries a JOIN branches b ON b.id = a.branch_id
            WHERE a.branch_id = ANY($1::uuid[])
              AND a.clock_in >= ($2::date::timestamp AT TIME ZONE b.timezone)
              AND a.clock_in < (($3::date + 1)::timestamp AT TIME ZONE b.timezone)
            GROUP BY a.user_id)
         SELECT u.id, u.full_name,
                count(o.*) AS orders,
                count(o.*) FILTER (WHERE o.status = 'completed') AS completed,
                count(o.*) FILTER (WHERE o.status = 'cancelled') AS cancelled,
                coalesce(sum(o.total_minor) FILTER (WHERE o.status = 'completed'), 0) AS sales,
                avg(extract(epoch FROM (o.completed_at - o.created_at)) / 60) FILTER (WHERE o.status = 'completed') AS avg_minutes,
                max(att.hours) AS hours
           FROM o JOIN users u ON u.id = o.created_by
           LEFT JOIN att ON att.user_id = u.id
          GROUP BY u.id, u.full_name
          ORDER BY sales DESC`,
        [ids, from, to],
      );
      return {
        branches,
        from,
        to,
        currencyCode: await this.ops.currency(s.db, branches[0]!.restaurantId),
        rows: rows.map((r) => {
          const completed = Number(r.completed ?? 0);
          const sales = Number(r.sales ?? 0);
          const hours = r.hours === null ? null : Math.round(Number(r.hours) * 10) / 10;
          return {
            userId: r.id,
            name: r.full_name,
            orders: Number(r.orders ?? 0),
            completed,
            cancelled: Number(r.cancelled ?? 0),
            salesMinor: sales,
            averageOrderMinor: completed ? Math.round(sales / completed) : null,
            averageMinutesToClose:
              r.avg_minutes === null ? null : Math.round(Number(r.avg_minutes)),
            hours,
            salesPerHourMinor: hours ? Math.round(sales / hours) : null,
          };
        }),
      };
    });
  }

  // ---------------------------------------------------------------- roles

  roles(auth: AuthContext) {
    return this.ops.run(auth, async (s) => {
      const roles = await s.db.query<Record<string, unknown>>(
        `SELECT r.id, r.code, r.name, r.description, r.is_system,
                coalesce(array_agg(p.code ORDER BY p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions,
                (SELECT count(DISTINCT a.membership_id) FROM user_role_assignments a
                   JOIN tenant_memberships m ON m.id = a.membership_id
                  WHERE a.role_id = r.id AND m.status <> 'suspended') AS members
           FROM roles r
           LEFT JOIN role_permissions rp ON rp.role_id = r.id
           LEFT JOIN permissions p ON p.id = rp.permission_id
          WHERE r.audience = 'tenant'
          GROUP BY r.id
          ORDER BY r.is_system DESC, CASE r.code WHEN 'owner' THEN 0 WHEN 'restaurant_admin' THEN 1
                   WHEN 'branch_manager' THEN 2 WHEN 'accountant' THEN 3 WHEN 'cashier' THEN 4 WHEN 'waiter' THEN 5
                   WHEN 'kitchen_manager' THEN 6 WHEN 'kitchen_staff' THEN 7 ELSE 8 END, r.name`,
      );
      const catalog = await s.db.query<{ code: string; description: string | null }>(
        `SELECT code, description FROM permissions WHERE audience = 'tenant' ORDER BY code`,
      );
      const mine = new Set(s.access.tenant);
      const canManage = mine.has('role:manage');
      return {
        canManage,
        roles: roles.map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          description: r.description,
          isSystem: r.is_system,
          permissions: r.permissions,
          members: Number(r.members),
        })),
        permissions: catalog.map((p) => ({
          code: p.code,
          description: p.description,
          grantable: canManage && mine.has(p.code) && !RESERVED.has(p.code),
        })),
      };
    });
  }

  createRole(auth: AuthContext, body: z.infer<typeof roleSchema>, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      const ids = await this.grantable(s, body.permissions);
      const code = `custom_${slug(body.name)}`.slice(0, 48);
      const dup = await s.db.one(
        'SELECT 1 FROM roles WHERE tenant_id = $1 AND (code = $2 OR lower(name) = lower($3))',
        [s.auth.tenantId, code, body.name],
      );
      if (dup)
        throw new ConflictException({
          code: 'ROLE_EXISTS',
          message: 'A role with this name already exists.',
        });
      const role = await s.db.one<{ id: string }>(
        `INSERT INTO roles (tenant_id, code, name, description, audience, is_system) VALUES ($1, $2, $3, $4, 'tenant', false) RETURNING id`,
        [s.auth.tenantId, code, body.name, body.description ?? null],
      );
      await this.setPermissions(s, role!.id, ids);
      await this.ops.audit(s, meta, 'role.created', 'role', role!.id, {
        name: body.name,
        permissions: body.permissions,
      });
      return { id: role!.id, code };
    });
  }

  updateRole(
    auth: AuthContext,
    id: string,
    body: z.infer<typeof roleUpdateSchema>,
    meta: RequestMeta,
  ) {
    return this.ops.run(auth, async (s) => {
      const role = await this.customRole(s, id);
      if (body.name || body.description !== undefined) {
        await s.db.query(
          'UPDATE roles SET name = coalesce($2, name), description = CASE WHEN $4 THEN $3 ELSE description END WHERE id = $1',
          [id, body.name ?? null, body.description ?? null, body.description !== undefined],
        );
      }
      if (body.permissions) {
        const ids = await this.grantable(s, body.permissions);
        await s.db.query('DELETE FROM role_permissions WHERE role_id = $1', [id]);
        await this.setPermissions(s, id, ids);
        // Members holding this role pick up the change on their next request.
        await s.db.query(
          `UPDATE tenant_memberships SET permission_version = permission_version + 1
            WHERE id IN (SELECT membership_id FROM user_role_assignments WHERE role_id = $1)`,
          [id],
        );
      }
      await this.ops.audit(s, meta, 'role.updated', 'role', id, { name: role.name, ...body });
    });
  }

  deleteRole(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.ops.run(auth, async (s) => {
      await this.customRole(s, id);
      const used = await s.db.one(
        'SELECT 1 FROM user_role_assignments WHERE role_id = $1 LIMIT 1',
        [id],
      );
      if (used)
        throw invalid('People still have this role. Give them another role first.', 'ROLE_IN_USE');
      await s.db.query('DELETE FROM roles WHERE id = $1', [id]);
      await this.ops.audit(s, meta, 'role.deleted', 'role', id);
    });
  }

  private async customRole(s: Scope, id: string) {
    if (!s.access.tenant.includes('role:manage'))
      throw forbidden('Only the owner can manage roles.');
    const r = await s.db.one<{ name: string; is_system: boolean; tenant_id: string | null }>(
      'SELECT name, is_system, tenant_id FROM roles WHERE id = $1',
      [id],
    );
    if (!r) throw notFound('Role');
    if (r.is_system || !r.tenant_id)
      throw invalid(
        'Built-in roles cannot be changed. Create a custom role instead.',
        'ROLE_SYSTEM',
      );
    return r;
  }

  /** Permission ids for codes the caller holds tenant-wide; never escalates beyond the caller. */
  private async grantable(s: Scope, codes: string[]) {
    if (!s.access.tenant.includes('role:manage'))
      throw forbidden('Only the owner can manage roles.');
    const unique = [...new Set(codes)];
    for (const c of unique) {
      if (RESERVED.has(c)) throw invalid(`"${c}" cannot be given through a custom role.`);
      if (!s.access.tenant.includes(c)) throw forbidden(`You cannot grant "${c}".`);
    }
    const rows = await s.db.query<{ id: string }>(
      `SELECT id FROM permissions WHERE code = ANY($1::text[]) AND audience = 'tenant'`,
      [unique],
    );
    if (rows.length !== unique.length) throw invalid('Unknown permission in the list.');
    return rows.map((r) => r.id);
  }

  private async setPermissions(s: Scope, roleId: string, ids: string[]) {
    for (const pid of ids) {
      await s.db.query(
        'INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [roleId, pid],
      );
    }
  }
}

function slug(v: string) {
  return (
    v
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '') || 'role'
  );
}

/** Inclusive date range, defaulting to the last `days` days. */
function range(from: string | undefined, to: string | undefined, days: number) {
  const end = to ?? new Date().toISOString().slice(0, 10);
  const start = from ?? new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  if (start > end) throw invalid('"From" must be before "to".');
  return { from: start, to: end };
}

@ApiTags('People')
@Controller()
export class PeopleController {
  constructor(private readonly p: PeopleService) {}

  @Get('attendance/me')
  @RequirePermission('attendance:self')
  me(@CurrentAuth() a: AuthContext) {
    return this.p.me(a);
  }

  @Post('attendance/clock-in')
  @RequirePermission('attendance:self')
  clockIn(
    @CurrentAuth() a: AuthContext,
    @Body(new ZodValidationPipe(clockInSchema)) b: z.infer<typeof clockInSchema>,
    @Req() r: Request,
  ) {
    return this.p.clockIn(a, b, requestMeta(r));
  }

  @Post('attendance/clock-out')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('attendance:self')
  async clockOut(
    @CurrentAuth() a: AuthContext,
    @Body(new ZodValidationPipe(clockOutSchema)) b: z.infer<typeof clockOutSchema>,
    @Req() r: Request,
  ) {
    await this.p.clockOut(a, b, requestMeta(r));
  }

  @Get('attendance')
  @RequirePermission('member:read')
  attendance(
    @CurrentAuth() a: AuthContext,
    @Query(new ZodValidationPipe(rangeSchema)) q: z.infer<typeof rangeSchema>,
  ) {
    return this.p.attendance(a, q);
  }

  @Patch('attendance/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('member:manage')
  async fix(
    @CurrentAuth() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(fixSchema)) b: z.infer<typeof fixSchema>,
    @Req() r: Request,
  ) {
    await this.p.fix(a, id, b, requestMeta(r));
  }

  @Get('shifts')
  @RequirePermission('member:read')
  shifts(
    @CurrentAuth() a: AuthContext,
    @Query(new ZodValidationPipe(shiftListSchema)) q: z.infer<typeof shiftListSchema>,
  ) {
    return this.p.shifts(a, q);
  }

  @Post('shifts')
  @RequirePermission('member:manage')
  createShift(
    @CurrentAuth() a: AuthContext,
    @Body(new ZodValidationPipe(shiftSchema)) b: z.infer<typeof shiftSchema>,
    @Req() r: Request,
  ) {
    return this.p.createShift(a, b, requestMeta(r));
  }

  @Delete('shifts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('member:manage')
  async deleteShift(
    @CurrentAuth() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() r: Request,
  ) {
    await this.p.deleteShift(a, id, requestMeta(r));
  }

  @Get('staff-performance')
  @RequirePermission('report:view')
  performance(
    @CurrentAuth() a: AuthContext,
    @Query(new ZodValidationPipe(rangeSchema)) q: z.infer<typeof rangeSchema>,
  ) {
    return this.p.performance(a, q);
  }

  @Get('roles')
  @RequirePermission('member:read')
  roles(@CurrentAuth() a: AuthContext) {
    return this.p.roles(a);
  }

  @Post('roles')
  @RequirePermission('role:manage')
  createRole(
    @CurrentAuth() a: AuthContext,
    @Body(new ZodValidationPipe(roleSchema)) b: z.infer<typeof roleSchema>,
    @Req() r: Request,
  ) {
    return this.p.createRole(a, b, requestMeta(r));
  }

  @Patch('roles/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('role:manage')
  async updateRole(
    @CurrentAuth() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(roleUpdateSchema)) b: z.infer<typeof roleUpdateSchema>,
    @Req() r: Request,
  ) {
    await this.p.updateRole(a, id, b, requestMeta(r));
  }

  @Delete('roles/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('role:manage')
  async deleteRole(
    @CurrentAuth() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() r: Request,
  ) {
    await this.p.deleteRole(a, id, requestMeta(r));
  }
}
