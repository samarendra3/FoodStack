import type { Assignment, BranchRef, TenantAccess } from './auth.types';

/** Groups role assignments into permission sets per scope. */
export function buildTenantAccess(
  assignments: Assignment[],
  allBranches: BranchRef[],
): TenantAccess {
  const tenant = new Set<string>();
  const byRestaurant: Record<string, Set<string>> = {};
  const byBranch: Record<string, Set<string>> = {};
  for (const a of assignments) {
    let target = tenant;
    if (a.scopeType === 'restaurant') target = byRestaurant[a.scopeId!] ??= new Set();
    if (a.scopeType === 'branch') target = byBranch[a.scopeId!] ??= new Set();
    for (const p of a.permissions) target.add(p);
  }
  const sorted = (set: Set<string>) => [...set].sort();
  const sortMap = (map: Record<string, Set<string>>) =>
    Object.fromEntries(Object.entries(map).map(([id, set]) => [id, sorted(set)]));
  return {
    roles: [...new Set(assignments.map((a) => a.role))].sort(),
    tenant: sorted(tenant),
    byRestaurant: sortMap(byRestaurant),
    byBranch: sortMap(byBranch),
    allBranches,
  };
}

export interface AccessTarget {
  restaurantId?: string;
  branchId?: string;
}

/**
 * Scope containment: tenant scope covers everything, restaurant scope covers that restaurant and
 * its branches, branch scope covers that branch. Without a target, any scope granting the
 * permission is enough ("may this user use the POS anywhere?").
 */
export function hasPermission(
  access: TenantAccess,
  permission: string,
  target: AccessTarget = {},
): boolean {
  if (access.tenant.includes(permission)) return true;
  const { branchId } = target;
  let { restaurantId } = target;
  if (branchId) {
    if (access.byBranch[branchId]?.includes(permission)) return true;
    restaurantId ??= access.allBranches.find((b) => b.id === branchId)?.restaurantId;
    return Boolean(restaurantId && access.byRestaurant[restaurantId]?.includes(permission));
  }
  if (restaurantId) return Boolean(access.byRestaurant[restaurantId]?.includes(permission));
  return (
    Object.values(access.byRestaurant).some((p) => p.includes(permission)) ||
    Object.values(access.byBranch).some((p) => p.includes(permission))
  );
}

/** Branches where the member holds at least one permission. */
export function accessibleBranches(access: TenantAccess): BranchRef[] {
  if (access.tenant.length > 0) return access.allBranches;
  return access.allBranches.filter(
    (b) =>
      (access.byBranch[b.id]?.length ?? 0) > 0 ||
      (access.byRestaurant[b.restaurantId]?.length ?? 0) > 0,
  );
}

export const HOME_PATHS = {
  platform: '/platform/dashboard',
  restaurant: '/restaurant/dashboard',
  pos: '/pos',
  kitchen: '/kitchen',
  waiter: '/waiter',
  noAccess: '/no-access',
} as const;

/** Management roles first: a Branch Manager who is also a Cashier lands on the dashboard. */
const ROLE_HOMES: [role: string, path: string][] = [
  ['owner', HOME_PATHS.restaurant],
  ['restaurant_admin', HOME_PATHS.restaurant],
  ['branch_manager', HOME_PATHS.restaurant],
  ['cashier', HOME_PATHS.pos],
  ['kitchen_manager', HOME_PATHS.kitchen],
  ['kitchen_staff', HOME_PATHS.kitchen],
  ['waiter', HOME_PATHS.waiter],
];

/**
 * Landing page after sign-in. System roles map directly; custom and other roles fall back to
 * what their permissions allow, so a custom till role still lands on the POS.
 */
export function resolveHomePath(audience: 'platform' | 'tenant', access?: TenantAccess): string {
  if (audience === 'platform') return HOME_PATHS.platform;
  if (!access) return HOME_PATHS.noAccess;
  for (const [role, path] of ROLE_HOMES) if (access.roles.includes(role)) return path;
  if (hasPermission(access, 'restaurant:read') || hasPermission(access, 'branch:manage')) {
    return HOME_PATHS.restaurant;
  }
  if (hasPermission(access, 'pos:access')) return HOME_PATHS.pos;
  if (hasPermission(access, 'kds:access')) return HOME_PATHS.kitchen;
  if (hasPermission(access, 'waiter:access')) return HOME_PATHS.waiter;
  return HOME_PATHS.noAccess;
}
