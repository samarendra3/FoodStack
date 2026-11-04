import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { Audience, AuthContext } from './auth.types';

export const PUBLIC_KEY = 'foodstack:public';
export const AUDIENCE_KEY = 'foodstack:audience';
export const PERMISSION_KEY = 'foodstack:permission';
export const SUBSCRIPTION_EXEMPT_KEY = 'foodstack:subscription-exempt';

/** No authentication (sign-in, refresh, password reset, health probes). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/**
 * Which session audience may call the route. Without it: tenant sessions only.
 * Platform routes also require a TOTP-verified session.
 */
export const AllowAudience = (audience: Audience | 'any') => SetMetadata(AUDIENCE_KEY, audience);

/**
 * Tenant routes that stay reachable when the subscription has lapsed (sign-in/session, account,
 * subscription, billing and payment). Every other tenant route requires an active entitlement.
 */
export const AllowInactiveSubscription = () => SetMetadata(SUBSCRIPTION_EXEMPT_KEY, true);

export interface PermissionRequirement {
  permission: string;
  /** Route param holding the target branch id; the permission must cover that branch. */
  branchParam?: string;
}

/** Permission checked server-side before the handler runs. */
export const RequirePermission = (permission: string, scope: { branchParam?: string } = {}) =>
  SetMetadata(PERMISSION_KEY, { permission, ...scope } satisfies PermissionRequirement);

export type AuthedRequest = Request & { auth?: AuthContext; id?: string | number };

/** The authenticated caller (set by AuthGuard). */
export const CurrentAuth = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const auth = ctx.switchToHttp().getRequest<AuthedRequest>().auth;
  if (!auth) throw new Error('CurrentAuth used on a route without authentication');
  return auth;
});
