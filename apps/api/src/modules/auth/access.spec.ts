import {
  accessibleBranches,
  buildTenantAccess,
  hasPermission,
  HOME_PATHS,
  resolveHomePath,
} from './access';
import type { Assignment, BranchRef } from './auth.types';

const branches: BranchRef[] = [
  { id: 'b1', name: 'Main', code: 'MAIN', restaurantId: 'r1' },
  { id: 'b2', name: 'Mall', code: 'MALL', restaurantId: 'r1' },
  { id: 'b3', name: 'Airport', code: 'AIR', restaurantId: 'r2' },
];

const assign = (
  role: string,
  scopeType: Assignment['scopeType'],
  scopeId: string | null,
  permissions: string[] = [],
): Assignment => ({ role, scopeType, scopeId, permissions });

const access = (...assignments: Assignment[]) => buildTenantAccess(assignments, branches);

describe('hasPermission (scope containment)', () => {
  it('tenant scope covers every restaurant and branch', () => {
    const a = access(assign('owner', 'tenant', null, ['branch:read']));
    expect(hasPermission(a, 'branch:read', { branchId: 'b3' })).toBe(true);
    expect(hasPermission(a, 'branch:manage', { branchId: 'b3' })).toBe(false);
  });

  it('restaurant scope covers its own branches only', () => {
    const a = access(assign('restaurant_admin', 'restaurant', 'r1', ['branch:read']));
    expect(hasPermission(a, 'branch:read', { branchId: 'b2' })).toBe(true);
    expect(hasPermission(a, 'branch:read', { branchId: 'b3' })).toBe(false);
    expect(hasPermission(a, 'branch:read', { restaurantId: 'r2' })).toBe(false);
  });

  it('branch scope never extends to a sibling branch', () => {
    const a = access(assign('cashier', 'branch', 'b1', ['pos:access']));
    expect(hasPermission(a, 'pos:access', { branchId: 'b1' })).toBe(true);
    expect(hasPermission(a, 'pos:access', { branchId: 'b2' })).toBe(false);
    expect(hasPermission(a, 'pos:access', { restaurantId: 'r1' })).toBe(false);
    expect(hasPermission(a, 'pos:access')).toBe(true);
    expect(accessibleBranches(a).map((b) => b.id)).toEqual(['b1']);
  });

  it('never grants access to a branch outside the tenant', () => {
    const a = access(assign('restaurant_admin', 'restaurant', 'r1', ['branch:read']));
    expect(hasPermission(a, 'branch:read', { branchId: 'foreign-branch' })).toBe(false);
  });
});

describe('resolveHomePath (role-based redirection)', () => {
  const home = (...a: Assignment[]) => resolveHomePath('tenant', access(...a));

  it('sends platform sessions to the platform dashboard', () => {
    expect(resolveHomePath('platform')).toBe(HOME_PATHS.platform);
  });

  it.each([
    ['owner', HOME_PATHS.restaurant],
    ['restaurant_admin', HOME_PATHS.restaurant],
    ['branch_manager', HOME_PATHS.restaurant],
    ['cashier', HOME_PATHS.pos],
    ['kitchen_staff', HOME_PATHS.kitchen],
    ['kitchen_manager', HOME_PATHS.kitchen],
    ['waiter', HOME_PATHS.waiter],
  ])('%s → %s', (role, path) => {
    expect(home(assign(role, 'branch', 'b1'))).toBe(path);
  });

  it('prefers the management dashboard for users holding several roles', () => {
    expect(home(assign('cashier', 'branch', 'b1'), assign('branch_manager', 'branch', 'b1'))).toBe(
      HOME_PATHS.restaurant,
    );
  });

  it('routes custom roles by permission, and members without access to /no-access', () => {
    expect(home(assign('custom_till', 'branch', 'b1', ['pos:access']))).toBe(HOME_PATHS.pos);
    expect(home(assign('custom_kds', 'branch', 'b1', ['kds:access']))).toBe(HOME_PATHS.kitchen);
    expect(home(assign('accountant', 'tenant', null, ['restaurant:read']))).toBe(
      HOME_PATHS.restaurant,
    );
    expect(home()).toBe(HOME_PATHS.noAccess);
    expect(resolveHomePath('tenant')).toBe(HOME_PATHS.noAccess);
  });
});
