import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DbContext } from '../../core/db/db-context';
import type { AuthContext } from '../auth/auth.types';
import { AllowAudience, CurrentAuth, RequirePermission } from '../auth/decorators';

/**
 * Super Admin endpoints: platform sessions only (TOTP-verified), checked by AuthGuard. Queries
 * run in the platform RLS context, which can read tenants but not tenant business data.
 */
@ApiTags('Platform')
@AllowAudience('platform')
@Controller('platform')
export class PlatformController {
  constructor(private readonly db: DbContext) {}

  @Get('dashboard')
  @RequirePermission('platform:dashboard_view')
  @ApiOperation({ summary: 'Platform-wide counts' })
  dashboard(@CurrentAuth() auth: AuthContext) {
    return this.db.run({ platform: true, userId: auth.userId }, async (db) => {
      const tenants = await db.query<{ status: string; count: string }>(
        'SELECT status, count(*) FROM tenants GROUP BY status',
      );
      const counts = await db.one<{
        users: string;
        active_sessions: string;
        failed_logins_24h: string;
        new_tenants_7d: string;
      }>(
        `SELECT (SELECT count(*) FROM users) AS users,
                (SELECT count(*) FROM sessions
                  WHERE revoked_at IS NULL AND idle_expires_at > now()) AS active_sessions,
                (SELECT count(*) FROM login_attempts
                  WHERE NOT success AND created_at > now() - interval '24 hours') AS failed_logins_24h,
                (SELECT count(*) FROM tenants
                  WHERE created_at > now() - interval '7 days') AS new_tenants_7d`,
      );
      const byStatus = Object.fromEntries(tenants.map((t) => [t.status, Number(t.count)]));
      return {
        tenants: {
          total: Object.values(byStatus).reduce((a, b) => a + b, 0),
          byStatus: { trial: 0, active: 0, suspended: 0, deactivated: 0, ...byStatus },
          newLast7Days: Number(counts?.new_tenants_7d ?? 0),
        },
        users: Number(counts?.users ?? 0),
        activeSessions: Number(counts?.active_sessions ?? 0),
        failedLoginsLast24h: Number(counts?.failed_logins_24h ?? 0),
      };
    });
  }

  @Get('tenants')
  @RequirePermission('platform:tenants_read')
  @ApiOperation({ summary: 'Registered restaurant accounts (newest first)' })
  tenants(@CurrentAuth() auth: AuthContext) {
    return this.db.run({ platform: true, userId: auth.userId }, (db) =>
      db.query(
        `SELECT t.id, t.name, t.slug::text AS slug, t.status, t.trial_ends_at AS "trialEndsAt",
                t.created_at AS "createdAt",
                (SELECT count(*)::int FROM tenant_memberships m
                  WHERE m.tenant_id = t.id AND m.status = 'active') AS "activeMembers"
           FROM tenants t ORDER BY t.created_at DESC LIMIT 200`,
      ),
    );
  }
}
