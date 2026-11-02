import type { AuthAudience, SessionProfile } from '@foodstack/types';

/**
 * Which signed-in users may open each protected area. This only shapes navigation: every API
 * call behind these pages is authorized by the server again.
 */
export interface AreaRule {
  prefix: string;
  audience: AuthAudience;
  /** At least one of these permissions, in any scope. */
  anyPermission?: string[];
}

export const AREA_RULES: AreaRule[] = [
  { prefix: '/platform', audience: 'platform' },
  {
    prefix: '/restaurant',
    audience: 'tenant',
    anyPermission: ['restaurant:read', 'branch:manage'],
  },
  { prefix: '/pos', audience: 'tenant', anyPermission: ['pos:access'] },
  { prefix: '/kitchen', audience: 'tenant', anyPermission: ['kds:access'] },
  { prefix: '/waiter', audience: 'tenant', anyPermission: ['waiter:access'] },
];

export const PROTECTED_PREFIXES = AREA_RULES.map((r) => r.prefix);

export function ruleFor(pathname: string): AreaRule | undefined {
  return AREA_RULES.find((r) => pathname === r.prefix || pathname.startsWith(`${r.prefix}/`));
}

/** True when the user holds the permission in any scope (tenant, restaurant or branch). */
export function hasPermissionAnywhere(profile: SessionProfile, permission: string): boolean {
  const { permissions } = profile;
  return (
    permissions.platform.includes(permission) ||
    permissions.tenant.includes(permission) ||
    Object.values(permissions.byRestaurant).some((p) => p.includes(permission)) ||
    Object.values(permissions.byBranch).some((p) => p.includes(permission))
  );
}

export function canAccessPath(profile: SessionProfile, pathname: string): boolean {
  const rule = ruleFor(pathname);
  if (!rule) return true;
  if (rule.audience !== profile.audience) return false;
  return !rule.anyPermission || rule.anyPermission.some((p) => hasPermissionAnywhere(profile, p));
}

/**
 * `?next=` only ever points inside this app: a relative path, never `//host` or `/\host`
 * (open-redirect protection).
 */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) {
    return null;
  }
  return next;
}

/** After sign-in: the requested page if this user may open it, otherwise their role's home. */
export function destinationAfterLogin(profile: SessionProfile, next: string | null): string {
  const target = safeNextPath(next);
  if (target && target !== '/login' && canAccessPath(profile, target.split('?')[0]!)) {
    return target;
  }
  return profile.homePath;
}
