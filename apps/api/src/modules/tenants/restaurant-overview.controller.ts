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
      const access = await this.access.tenantAccess(db, auth.membershipId!);
      const branches = accessibleBranches(access);
      const restaurantIds = [...new Set(branches.map((b) => b.restaurantId))];
      const tenant = await db.one<{
        id: string;
        name: string;
        status: string;
        trial_ends_at: Date | null;
      }>('SELECT id, name, status, trial_ends_at FROM tenants WHERE id = $1', [auth.tenantId]);
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
