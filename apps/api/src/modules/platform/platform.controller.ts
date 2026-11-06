import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DbContext } from '../../core/db/db-context';
import { CacheService } from '../../shared/cache/cache.service';
import { PlatformAnalyticsService } from '../analytics/platform-analytics.service';
import { QueueMonitorService } from '../notifications/queue-monitor.service';
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
  constructor(
    private readonly db: DbContext,
    private readonly cache: CacheService,
    private readonly queues: QueueMonitorService,
    private readonly analytics: PlatformAnalyticsService,
  ) {}

  @Get('analytics')
  @RequirePermission('platform:dashboard_view')
  @ApiOperation({
    summary:
      'Tenant growth, subscription distribution and paid SaaS invoice revenue (platform data only)',
  })
  platformAnalytics(@CurrentAuth() auth: AuthContext) {
    return this.analytics.overview(auth.userId);
  }

  @Get('queues')
  @RequirePermission('platform:dashboard_view')
  @ApiOperation({
    summary:
      'Email queue and outbox: job counts, processing and wait times, retries, worker health (no job data)',
  })
  queueStats() {
    return this.queues.snapshot();
  }

  @Get('cache')
  @RequirePermission('platform:dashboard_view')
  @ApiOperation({
    summary:
      'Cache metrics for this API instance: hits, misses, fallbacks, Redis latency and memory',
  })
  cacheStats() {
    return this.cache.stats();
  }

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
