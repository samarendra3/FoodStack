import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { requestMeta } from '../../common/http/request-meta';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { type Db, DbContext } from '../../core/db/db-context';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { AllowAudience, CurrentAuth, RequirePermission } from '../auth/decorators';
import { writeAudit } from '../auth/user-tokens';

/*
 * Super Admin: every user account on the platform (disable, unlock, sign out everywhere),
 * the full audit trail, and platform settings. Runs in the platform RLS context.
 */

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const usersQuery = z.strictObject({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'disabled', 'locked']).optional(),
  kind: z.enum(['platform', 'tenant']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
const reasonSchema = z.strictObject({ reason: z.string().trim().min(3).max(200) });
const auditQuery = z.strictObject({
  search: z.string().trim().max(100).optional(),
  action: z.string().trim().max(80).optional(),
  audience: z.enum(['platform', 'tenant']).optional(),
  tenantId: z.uuid().optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** Cursor: the `createdAt|id` of the last row seen. */
  before: z.string().max(80).optional(),
});
const settingsSchema = z
  .strictObject({
    signupsOpen: z.boolean(),
    announcement: z
      .string()
      .trim()
      .max(300)
      .transform((v) => (v === '' ? null : v))
      .nullable(),
    announcementLevel: z.enum(['info', 'warning', 'critical']),
    supportEmail: z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .transform((v) => (v === '' ? null : v))
      .pipe(z.email().nullable())
      .nullable(),
    supportPhone: z
      .string()
      .trim()
      .max(20)
      .transform((v) => (v === '' ? null : v))
      .nullable(),
  })
  .partial();

const PAGE = 50;

@ApiTags('Platform')
@AllowAudience('platform')
@Controller('platform')
export class PlatformAdminController {
  constructor(private readonly db: DbContext) {}

  private run<T>(auth: AuthContext, work: (db: Db) => Promise<T>) {
    return this.db.run({ platform: true, userId: auth.userId }, work);
  }

  // ---------------------------------------------------------------- users

  @Get('users')
  @RequirePermission('platform:users_read')
  @ApiOperation({ summary: 'All user accounts with their restaurants and roles' })
  users(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(usersQuery)) q: z.infer<typeof usersQuery>,
  ) {
    return this.run(auth, async (db) => {
      const where: string[] = ['true'];
      const params: unknown[] = [];
      if (q.search) {
        params.push(like(q.search));
        where.push(
          `(u.email::text ILIKE $${params.length} OR u.full_name ILIKE $${params.length})`,
        );
      }
      if (q.status === 'active')
        where.push(`u.status = 'active' AND (u.locked_until IS NULL OR u.locked_until <= now())`);
      if (q.status === 'disabled') where.push(`u.status = 'disabled'`);
      if (q.status === 'locked') where.push(`u.locked_until > now()`);
      const platformRole = `EXISTS (SELECT 1 FROM platform_role_assignments pa WHERE pa.user_id = u.id)`;
      if (q.kind === 'platform') where.push(platformRole);
      if (q.kind === 'tenant') where.push(`NOT ${platformRole}`);
      const total = await db.one<{ n: string }>(
        `SELECT count(*) AS n FROM users u WHERE ${where.join(' AND ')}`,
        params,
      );
      params.push(PAGE, (q.page - 1) * PAGE);
      const rows = await db.query<Record<string, unknown>>(
        `SELECT u.id, u.email::text AS email, u.full_name, u.status, u.locked_until, u.last_login_at, u.mfa_enabled,
                u.created_at, u.failed_login_count,
                (SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL
                   AND s.absolute_expires_at > now()) AS active_sessions,
                coalesce((SELECT json_agg(json_build_object('tenantId', t.id, 'tenant', t.name, 'status', m.status,
                            'roles', (SELECT coalesce(json_agg(DISTINCT r.name), '[]') FROM user_role_assignments a
                                       JOIN roles r ON r.id = a.role_id WHERE a.membership_id = m.id)) ORDER BY t.name)
                          FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = u.id), '[]') AS memberships,
                coalesce((SELECT json_agg(r.name) FROM platform_role_assignments pa JOIN roles r ON r.id = pa.role_id
                           WHERE pa.user_id = u.id), '[]') AS platform_roles
           FROM users u
          WHERE ${where.join(' AND ')}
          ORDER BY u.created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      const summary = await db.one<Record<string, string>>(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE status = 'disabled') AS disabled,
                count(*) FILTER (WHERE locked_until > now()) AS locked,
                count(*) FILTER (WHERE mfa_enabled) AS mfa,
                count(*) FILTER (WHERE last_login_at > now() - interval '7 days') AS active_week
           FROM users`,
      );
      return {
        page: q.page,
        pageSize: PAGE,
        total: Number(total?.n ?? 0),
        summary: Object.fromEntries(Object.entries(summary ?? {}).map(([k, v]) => [k, Number(v)])),
        rows: rows.map((r) => ({
          id: r.id,
          email: r.email,
          fullName: r.full_name,
          status: r.status,
          locked: r.locked_until !== null && new Date(r.locked_until as string) > new Date(),
          lockedUntil: r.locked_until,
          lastLoginAt: r.last_login_at,
          mfaEnabled: r.mfa_enabled,
          createdAt: r.created_at,
          failedLogins: Number(r.failed_login_count),
          activeSessions: Number(r.active_sessions),
          memberships: r.memberships,
          platformRoles: r.platform_roles,
          isMe: r.id === auth.userId,
        })),
      };
    });
  }

  @Post('users/:id/disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('platform:users_manage')
  async disable(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
    @Req() req: Request,
  ) {
    if (id === auth.userId)
      throw new BadRequestException({
        code: 'CANNOT_DISABLE_SELF',
        message: 'You cannot disable your own account.',
      });
    await this.run(auth, async (db) => {
      await this.user(db, id);
      await db.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [id]);
      await this.revokeAll(db, id, 'admin_revoked');
      await this.audit(db, auth, requestMeta(req), 'platform.user_disabled', id, {
        reason: body.reason,
      });
    });
  }

  @Post('users/:id/enable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('platform:users_manage')
  async enable(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    await this.run(auth, async (db) => {
      await this.user(db, id);
      await db.query(
        `UPDATE users SET status = 'active', failed_login_count = 0, locked_until = NULL WHERE id = $1`,
        [id],
      );
      await this.audit(db, auth, requestMeta(req), 'platform.user_enabled', id);
    });
  }

  @Post('users/:id/unlock')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('platform:users_manage')
  async unlock(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    await this.run(auth, async (db) => {
      await this.user(db, id);
      await db.query(`UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [
        id,
      ]);
      await this.audit(db, auth, requestMeta(req), 'platform.user_unlocked', id);
    });
  }

  @Post('users/:id/revoke-sessions')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('platform:users_manage')
  revokeSessions(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.run(auth, async (db) => {
      await this.user(db, id);
      const n = await this.revokeAll(
        db,
        id,
        'admin_revoked',
        id === auth.userId ? auth.sessionId : undefined,
      );
      await this.audit(db, auth, requestMeta(req), 'platform.user_sessions_revoked', id, {
        sessions: n,
      });
      return { revoked: n };
    });
  }

  private async user(db: Db, id: string) {
    const u = await db.one('SELECT 1 FROM users WHERE id = $1', [id]);
    if (!u) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found.' });
  }

  private async revokeAll(db: Db, userId: string, reason: string, keep?: string) {
    const rows = await db.query(
      `UPDATE sessions SET revoked_at = now(), revoke_reason = $2
        WHERE user_id = $1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3) RETURNING id`,
      [userId, reason, keep ?? null],
    );
    return rows.length;
  }

  private audit(
    db: Db,
    auth: AuthContext,
    meta: RequestMeta,
    action: string,
    entityId: string | null,
    metadata: Record<string, unknown> = {},
  ) {
    return writeAudit(db, {
      action,
      tenantId: null,
      actorUserId: auth.userId,
      actorSessionId: auth.sessionId,
      actorAudience: 'platform',
      entityType: action.startsWith('platform.user') ? 'user' : 'platform_settings',
      entityId,
      metadata,
      ...meta,
    });
  }

  // ---------------------------------------------------------------- audit logs

  @Get('audit-logs')
  @RequirePermission('platform:audit_read')
  @ApiOperation({ summary: 'Audit trail across the platform, newest first (cursor paged)' })
  auditLogs(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(auditQuery)) q: z.infer<typeof auditQuery>,
  ) {
    return this.run(auth, async (db) => {
      const where: string[] = ['true'];
      const params: unknown[] = [];
      const add = (sql: string, v: unknown) => {
        params.push(v);
        where.push(sql.replaceAll('?', `$${params.length}`));
      };
      if (q.search)
        add(
          `(a.action ILIKE ? OR u.email::text ILIKE ? OR t.name ILIKE ? OR a.ip::text ILIKE ?)`,
          like(q.search),
        );
      if (q.action) add(`a.action LIKE ?`, `${q.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      if (q.audience) add(`a.actor_audience = ?`, q.audience);
      if (q.tenantId) add(`a.tenant_id = ?`, q.tenantId);
      if (q.from) add(`a.created_at >= ?::date`, q.from);
      if (q.to) add(`a.created_at < (?::date + 1)`, q.to);
      if (q.before) {
        const [at, id] = q.before.split('|');
        if (!at || !id || Number.isNaN(Date.parse(at)))
          throw new BadRequestException({ code: 'BAD_CURSOR', message: 'Invalid cursor.' });
        params.push(at, id);
        where.push(
          `(a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
        );
      }
      const rows = await db.query<Record<string, unknown>>(
        `SELECT a.id, a.created_at, a.action, a.entity_type, a.entity_id, a.actor_audience, a.metadata,
                a.ip::text AS ip, a.user_agent, a.request_id, a.tenant_id, t.name AS tenant_name,
                u.email::text AS actor_email, u.full_name AS actor_name
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.actor_user_id
           LEFT JOIN tenants t ON t.id = a.tenant_id
          WHERE ${where.join(' AND ')}
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT ${PAGE + 1}`,
        params,
      );
      const page = rows.slice(0, PAGE);
      const last = page.at(-1);
      const actions = await db.query<{ prefix: string }>(
        `SELECT DISTINCT split_part(action, '.', 1) AS prefix FROM audit_logs
          WHERE created_at > now() - interval '90 days' ORDER BY 1 LIMIT 100`,
      );
      return {
        actionGroups: actions.map((a) => a.prefix),
        nextCursor:
          rows.length > PAGE && last
            ? `${new Date(last.created_at as string).toISOString()}|${last.id}`
            : null,
        rows: page.map((r) => ({
          id: r.id,
          createdAt: r.created_at,
          action: r.action,
          entityType: r.entity_type,
          entityId: r.entity_id,
          audience: r.actor_audience,
          metadata: r.metadata,
          ip: r.ip,
          userAgent: r.user_agent,
          requestId: r.request_id,
          tenantId: r.tenant_id,
          tenantName: r.tenant_name,
          actorEmail: r.actor_email,
          actorName: r.actor_name,
        })),
      };
    });
  }

  // ---------------------------------------------------------------- settings

  @Get('settings')
  @RequirePermission('platform:dashboard_view')
  @ApiOperation({ summary: 'Platform settings and live system status' })
  settings(@CurrentAuth() auth: AuthContext) {
    return this.run(auth, async (db) => {
      const s = await db.one<Record<string, unknown>>(
        `SELECT p.signups_open, p.announcement, p.announcement_level, p.support_email::text AS support_email,
                p.support_phone, p.updated_at, u.full_name AS updated_by
           FROM platform_settings p LEFT JOIN users u ON u.id = p.updated_by`,
      );
      const counts = await db.one<Record<string, string>>(
        `SELECT (SELECT count(*) FROM tenants) AS tenants,
                (SELECT count(*) FROM users) AS users,
                (SELECT count(*) FROM sessions WHERE revoked_at IS NULL AND absolute_expires_at > now()) AS sessions,
                (SELECT count(*) FROM access_requests WHERE status = 'pending') AS pending_requests`,
      );
      const admins = await db.query<{
        name: string;
        email: string;
        role: string;
        mfa: boolean;
        last_login_at: string | null;
      }>(
        `SELECT u.full_name AS name, u.email::text AS email, r.name AS role, u.mfa_enabled AS mfa, u.last_login_at
           FROM platform_role_assignments pa JOIN users u ON u.id = pa.user_id JOIN roles r ON r.id = pa.role_id
          ORDER BY r.name, u.full_name`,
      );
      const manage = await db.one<{ ok: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM platform_role_assignments pa JOIN role_permissions rp ON rp.role_id = pa.role_id
                  JOIN permissions p ON p.id = rp.permission_id
                 WHERE pa.user_id = $1 AND p.code = 'platform:settings_manage') AS ok`,
        [auth.userId],
      );
      return {
        settings: {
          signupsOpen: s!.signups_open,
          announcement: s!.announcement,
          announcementLevel: s!.announcement_level,
          supportEmail: s!.support_email,
          supportPhone: s!.support_phone,
          updatedAt: s!.updated_at,
          updatedBy: s!.updated_by,
        },
        canManage: Boolean(manage?.ok),
        system: {
          tenants: Number(counts?.tenants ?? 0),
          users: Number(counts?.users ?? 0),
          activeSessions: Number(counts?.sessions ?? 0),
          pendingRequests: Number(counts?.pending_requests ?? 0),
          node: process.version,
          uptimeSeconds: Math.round(process.uptime()),
        },
        admins,
      };
    });
  }

  @Patch('settings')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('platform:settings_manage')
  async saveSettings(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(settingsSchema)) body: z.infer<typeof settingsSchema>,
    @Req() req: Request,
  ) {
    const cols: Record<string, string> = {
      signupsOpen: 'signups_open',
      announcement: 'announcement',
      announcementLevel: 'announcement_level',
      supportEmail: 'support_email',
      supportPhone: 'support_phone',
    };
    const params: unknown[] = [auth.userId];
    const sets = ['updated_by = $1'];
    for (const [k, col] of Object.entries(cols)) {
      const v = body[k as keyof typeof body];
      if (v !== undefined) {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (sets.length === 1)
      throw new BadRequestException({ code: 'NOTHING_TO_UPDATE', message: 'Nothing to update.' });
    await this.run(auth, async (db) => {
      await db.query(`UPDATE platform_settings SET ${sets.join(', ')} WHERE id`, params);
      await this.audit(db, auth, requestMeta(req), 'platform.settings_updated', null, body);
    });
  }
}

/** The current announcement for the banner every signed-in user sees. */
@ApiTags('Platform')
@AllowAudience('any')
@Controller('announcement')
export class AnnouncementController {
  constructor(private readonly db: DbContext) {}

  @Get()
  get(@CurrentAuth() auth: AuthContext) {
    return this.db.run({ userId: auth.userId }, async (db) => {
      const s = await db.one<{
        announcement: string | null;
        announcement_level: string;
        support_email: string | null;
        support_phone: string | null;
        updated_at: string;
      }>(
        `SELECT announcement, announcement_level, support_email::text AS support_email, support_phone, updated_at FROM platform_settings`,
      );
      return {
        message: s?.announcement ?? null,
        level: s?.announcement_level ?? 'info',
        supportEmail: s?.support_email ?? null,
        supportPhone: s?.support_phone ?? null,
        updatedAt: s?.updated_at ?? null,
      };
    });
  }
}
