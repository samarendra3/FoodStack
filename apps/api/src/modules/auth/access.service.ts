import { Injectable } from '@nestjs/common';
import type { Db } from '../../core/db/db-context';
import { accessibleBranches, buildTenantAccess, resolveHomePath } from './access';
import type {
  Assignment,
  Audience,
  BranchRef,
  SessionProfile,
  TenantAccess,
  AuthContext,
} from './auth.types';

export const ACTIVE_TENANT_STATUSES = ['trial', 'active'];

interface MembershipRow {
  membership_id: string;
  tenant_id: string;
  membership_status: string;
  name: string;
  slug: string;
  tenant_status: string;
}

/**
 * Reads roles and permissions. Every query runs inside the caller's RLS context, so a tenant
 * scope only ever sees its own assignments and branches.
 */
@Injectable()
export class AccessService {
  /**
   * The caller's permissions for this request: the set AuthGuard already computed (same request,
   * validated session) when there is one, otherwise a fresh database look-up. Requires scope
   * { tenantId }.
   */
  forRequest(db: Db, auth: AuthContext): Promise<TenantAccess> {
    if (auth.access && auth.audience === 'tenant') return Promise.resolve(auth.access);
    return this.tenantAccess(db, auth.membershipId!);
  }

  /** Requires scope { tenantId }. */
  async tenantAccess(db: Db, membershipId: string): Promise<TenantAccess> {
    const assignments = await db.query<{
      role: string;
      scope_type: Assignment['scopeType'];
      scope_id: string | null;
      permissions: string[];
    }>(
      `SELECT r.code AS role, a.scope_type, a.scope_id,
              coalesce(array_agg(p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
         FROM user_role_assignments a
         JOIN roles r ON r.id = a.role_id
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
         LEFT JOIN permissions p ON p.id = rp.permission_id
        WHERE a.membership_id = $1
        GROUP BY a.id, r.code`,
      [membershipId],
    );
    const branches = await db.query<BranchRef>(
      `SELECT id, name, code::text AS code, restaurant_id AS "restaurantId"
         FROM branches WHERE status = 'active' ORDER BY is_default DESC, name`,
    );
    return buildTenantAccess(
      assignments.map((a) => ({
        role: a.role,
        scopeType: a.scope_type,
        scopeId: a.scope_id,
        permissions: a.permissions,
      })),
      branches,
    );
  }

  /** Requires scope { userId }. */
  async platformRoles(db: Db, userId: string): Promise<{ roles: string[]; permissions: string[] }> {
    const rows = await db.query<{ role: string; permission: string | null }>(
      `SELECT r.code AS role, p.code AS permission
         FROM platform_role_assignments a
         JOIN roles r ON r.id = a.role_id AND r.audience = 'platform'
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
         LEFT JOIN permissions p ON p.id = rp.permission_id
        WHERE a.user_id = $1`,
      [userId],
    );
    return {
      roles: [...new Set(rows.map((r) => r.role))].sort(),
      permissions: [...new Set(rows.flatMap((r) => (r.permission ? [r.permission] : [])))].sort(),
    };
  }

  /** The user's memberships (own-membership policy). Requires scope { userId }. */
  memberships(db: Db, userId: string): Promise<MembershipRow[]> {
    return db.query<MembershipRow>(
      `SELECT m.id AS membership_id, m.tenant_id, m.status AS membership_status,
              t.name, t.slug::text AS slug, t.status AS tenant_status
         FROM tenant_memberships m
         JOIN tenants t ON t.id = m.tenant_id
        WHERE m.user_id = $1
        ORDER BY m.joined_at NULLS LAST, m.created_at`,
      [userId],
    );
  }

  /**
   * Builds the profile for a session. Requires scope { userId } for platform sessions and
   * { userId, tenantId } for tenant sessions.
   */
  async profile(
    db: Db,
    session: {
      userId: string;
      audience: Audience;
      tenantId: string | null;
      membershipId: string | null;
    },
  ): Promise<SessionProfile> {
    const user = await db.one<{
      id: string;
      email: string;
      full_name: string;
      mfa_enabled: boolean;
    }>('SELECT id, email::text AS email, full_name, mfa_enabled FROM users WHERE id = $1', [
      session.userId,
    ]);
    if (!user) throw new Error('Session user not found');
    const memberships = (await this.memberships(db, session.userId)).filter(
      (m) => m.membership_status === 'active',
    );
    const base = {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        mfaEnabled: user.mfa_enabled,
      },
      audience: session.audience,
      memberships: memberships.map((m) => ({
        tenantId: m.tenant_id,
        name: m.name,
        slug: m.slug,
        status: m.tenant_status,
      })),
    };

    if (session.audience === 'platform') {
      const platform = await this.platformRoles(db, session.userId);
      return {
        ...base,
        activeTenant: null,
        roles: platform.roles,
        permissions: { platform: platform.permissions, tenant: [], byRestaurant: {}, byBranch: {} },
        branches: [],
        homePath: resolveHomePath('platform'),
      };
    }

    const active = memberships.find((m) => m.tenant_id === session.tenantId);
    const access = await this.tenantAccess(db, session.membershipId!);
    return {
      ...base,
      activeTenant: active
        ? {
            id: active.tenant_id,
            name: active.name,
            slug: active.slug,
            status: active.tenant_status,
          }
        : null,
      roles: access.roles,
      permissions: {
        platform: [],
        tenant: access.tenant,
        byRestaurant: access.byRestaurant,
        byBranch: access.byBranch,
      },
      branches: accessibleBranches(access),
      homePath: resolveHomePath('tenant', access),
    };
  }
}
