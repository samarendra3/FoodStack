import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DbContext } from '../../core/db/db-context';
import { accessibleBranches, hasPermission } from '../auth/access';
import { AccessService } from '../auth/access.service';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth, RequirePermission } from '../auth/decorators';

/**
 * Restaurant workspace data for the signed-in member. Runs under the member's tenant RLS
 * context and is further narrowed to the branches the member can access.
 */
@ApiTags('Restaurant')
@Controller()
export class RestaurantOverviewController {
  constructor(
    private readonly db: DbContext,
    private readonly access: AccessService,
  ) {}

  @Get('restaurant/overview')
  @RequirePermission('branch:read')
  @ApiOperation({ summary: 'Tenant, restaurants and branches visible to the caller' })
  overview(@CurrentAuth() auth: AuthContext) {
    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, async (db) => {
      const access = await this.access.forRequest(db, auth);
      const branches = accessibleBranches(access);
      const restaurantIds = [...new Set(branches.map((b) => b.restaurantId))];
      const tenant = await db.one<{
        id: string;
        name: string;
        status: string;
        trial_ends_at: Date | null;
      }>(
        `SELECT t.id, t.name, t.status, s.trial_ends_at
           FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id WHERE t.id = $1`,
        [auth.tenantId],
      );
      const restaurants = await db.query<{
        id: string;
        name: string;
        currency_code: string;
        timezone: string;
        status: string;
      }>(
        `SELECT id, name, currency_code, timezone, status FROM restaurants
          WHERE id = ANY($1::uuid[]) ORDER BY name`,
        [restaurantIds],
      );
      const team = hasPermission(access, 'member:read')
        ? await db.one<{ count: string }>(
            `SELECT count(*) FROM tenant_memberships WHERE tenant_id = $1 AND status = 'active'`,
            [auth.tenantId],
          )
        : undefined;
      return {
        tenant: tenant && {
          id: tenant.id,
          name: tenant.name,
          status: tenant.status,
          trialEndsAt: tenant.trial_ends_at,
        },
        restaurants: restaurants.map((r) => ({
          id: r.id,
          name: r.name,
          currencyCode: r.currency_code,
          timezone: r.timezone,
          status: r.status,
        })),
        branches,
        activeMembers: team ? Number(team.count) : null,
        roles: access.roles,
      };
    });
  }

  @Get('restaurant/activity')
  @RequirePermission('audit:view')
  @ApiOperation({
    summary: 'Recent business events (team changes, approvals) for business-wide managers',
  })
  activity(@CurrentAuth() auth: AuthContext) {
    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, async (db) => {
      const access = await this.access.forRequest(db, auth);
      // The audit log is business-wide; branch-limited managers do not get it.
      if (!access.tenant.includes('audit:view')) return { available: false, events: [] };
      const events = await db.query<{
        id: string;
        action: string;
        createdAt: string;
        actorName: string | null;
        subjectName: string | null;
        metadata: Record<string, unknown>;
      }>(
        `SELECT a.id, a.action, a.created_at AS "createdAt", actor.full_name AS "actorName",
                subject.full_name AS "subjectName", a.metadata
           FROM audit_logs a
           LEFT JOIN users actor ON actor.id = a.actor_user_id
           LEFT JOIN tenant_memberships m
                  ON a.entity_type = 'membership' AND m.id = a.entity_id
           LEFT JOIN users subject ON subject.id = m.user_id
          WHERE a.tenant_id = $1
            AND (a.action LIKE 'member.%' OR a.action IN ('tenant.created', 'access_request.approved'))
          ORDER BY a.created_at DESC
          LIMIT 12`,
        [auth.tenantId],
      );
      return {
        available: true,
        events: events.map((e) => ({
          id: e.id,
          action: e.action,
          createdAt: e.createdAt,
          actorName: e.actorName,
          subjectName: e.subjectName,
          role: typeof e.metadata.role === 'string' ? e.metadata.role : null,
          toRole: typeof e.metadata.to === 'string' ? e.metadata.to : null,
        })),
      };
    });
  }

  @Get('branches/:id/receipt-header')
  @RequirePermission('branch:read', { branchParam: 'id' })
  @ApiOperation({ summary: 'Restaurant details printed on customer bills (for POS staff)' })
  receiptHeader(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, async (db) => {
      const r = await db.one<{
        branch_name: string;
        name: string;
        legal_name: string | null;
        logo_url: string | null;
        phone: string | null;
        email: string | null;
        address_line: string | null;
        city: string | null;
        state: string | null;
        postal_code: string | null;
        gstin: string | null;
        country_code: string;
      }>(
        `SELECT b.name AS branch_name, r.name, r.legal_name, r.logo_url, r.phone, r.email,
                r.address_line, r.city, r.state, r.postal_code, r.gstin, r.country_code
           FROM branches b JOIN restaurants r ON r.id = b.restaurant_id WHERE b.id = $1`,
        [id],
      );
      if (!r) return null;
      return {
        branchName: r.branch_name,
        name: r.name,
        legalName: r.legal_name,
        logoUrl: r.logo_url,
        phone: r.phone,
        email: r.email,
        address:
          [r.address_line, r.city, r.state, r.postal_code].filter(Boolean).join(', ') || null,
        gstin: r.gstin,
        countryCode: r.country_code.trim(),
      };
    });
  }

  @Get('branches/:id')
  @RequirePermission('branch:read', { branchParam: 'id' })
  @ApiOperation({ summary: 'One branch (404 outside the tenant, 403 outside the caller scope)' })
  async branch(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, (db) =>
      db.one(
        `SELECT b.id, b.name, b.code::text AS code, b.timezone, b.status, b.is_default AS "isDefault",
                b.restaurant_id AS "restaurantId", r.name AS "restaurantName"
           FROM branches b JOIN restaurants r ON r.id = b.restaurant_id
          WHERE b.id = $1`,
        [id],
      ),
    );
  }
}
