import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DbContext } from '../../core/db/db-context';
import { hasPermission } from './access';
import { ACTIVE_TENANT_STATUSES, AccessService } from './access.service';
import type { Audience } from './auth.types';
import {
  AUDIENCE_KEY,
  type AuthedRequest,
  PERMISSION_KEY,
  type PermissionRequirement,
  PUBLIC_KEY,
} from './decorators';
import { TokenService } from './token.service';

const unauthenticated = (message = 'Sign in to continue.') =>
  new UnauthorizedException({ code: 'AUTH_UNAUTHENTICATED', message });

/**
 * Global guard, deny by default. Every route needs @Public() or a valid access token, and then:
 * - the session must still be live (revocation and tenant suspension apply on the next request,
 *   even with an unexpired token);
 * - the session audience must match the route (tenant by default; platform needs TOTP);
 * - @RequirePermission is checked against the caller's scopes. Branches of other tenants are
 *   invisible under RLS and answer 404, never 403, so their existence is not revealed.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly db: DbContext,
    private readonly access: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthenticated();
    const claims = await this.tokens.verify(header.slice(7).trim());

    const required =
      this.reflector.getAllAndOverride<Audience | 'any'>(AUDIENCE_KEY, targets) ?? 'tenant';
    if (required !== 'any' && required !== claims.audience) {
      throw new ForbiddenException({
        code: 'AUTH_AUDIENCE_FORBIDDEN',
        message:
          required === 'platform'
            ? 'Platform administration requires a platform administrator account.'
            : 'This area is only available to restaurant accounts.',
      });
    }
    const mfaVerified = claims.amr.includes('totp');
    if (claims.audience === 'platform' && !mfaVerified) {
      throw new ForbiddenException({
        code: 'AUTH_MFA_REQUIRED',
        message: 'Two-factor authentication is required.',
      });
    }

    const permission = this.reflector.getAllAndOverride<PermissionRequirement | undefined>(
      PERMISSION_KEY,
      targets,
    );

    await this.db.run(
      { userId: claims.userId, sessionId: claims.sessionId, tenantId: claims.tenantId },
      async (db) => {
        const state = await db.one<{
          revoked: boolean;
          expired: boolean;
          user_status: string;
          tenant_status: string | null;
          membership_status: string | null;
        }>(
          `SELECT s.revoked_at IS NOT NULL AS revoked, s.absolute_expires_at <= now() AS expired,
                  u.status AS user_status, t.status AS tenant_status, m.status AS membership_status
             FROM sessions s
             JOIN users u ON u.id = s.user_id
             LEFT JOIN tenants t ON t.id = s.tenant_id
             LEFT JOIN tenant_memberships m ON m.id = s.membership_id
            WHERE s.id = $1 AND s.user_id = $2`,
          [claims.sessionId, claims.userId],
        );
        if (!state || state.revoked || state.expired || state.user_status !== 'active') {
          throw new UnauthorizedException({
            code: 'AUTH_SESSION_REVOKED',
            message: 'Your session has ended. Please sign in again.',
          });
        }
        if (claims.audience === 'tenant') {
          if (!ACTIVE_TENANT_STATUSES.includes(state.tenant_status ?? '')) {
            throw new ForbiddenException({
              code: 'TENANT_INACTIVE',
              message: 'This restaurant account is suspended.',
            });
          }
          if (state.membership_status !== 'active') {
            throw unauthenticated('Your access to this restaurant has been removed.');
          }
        }

        if (!permission) return;
        if (claims.audience === 'platform') {
          const platform = await this.access.platformRoles(db, claims.userId);
          if (!platform.permissions.includes(permission.permission)) throw denied();
          return;
        }

        const access = await this.access.tenantAccess(db, claims.membershipId!);
        const branchId = permission.branchParam
          ? String(req.params[permission.branchParam] ?? '')
          : undefined;
        if (branchId !== undefined && !access.allBranches.some((b) => b.id === branchId)) {
          throw new NotFoundException({ code: 'NOT_FOUND', message: 'Branch not found.' });
        }
        if (!hasPermission(access, permission.permission, branchId ? { branchId } : {})) {
          throw branchId
            ? new ForbiddenException({
                code: 'BRANCH_FORBIDDEN',
                message: 'You do not have access to this branch.',
              })
            : denied();
        }
      },
    );

    req.auth = {
      userId: claims.userId,
      sessionId: claims.sessionId,
      audience: claims.audience,
      tenantId: claims.tenantId,
      membershipId: claims.membershipId,
      mfaVerified,
    };
    return true;
  }
}

function denied(): ForbiddenException {
  return new ForbiddenException({
    code: 'AUTH_PERMISSION_DENIED',
    message: 'You do not have permission to do this.',
  });
}
