import type { SessionProfile } from '@foodstack/types';
import { describe, expect, it } from 'vitest';
import { canAccessPath, destinationAfterLogin, safeNextPath } from './access';

function profile(overrides: Partial<SessionProfile> = {}): SessionProfile {
  return {
    user: { id: 'u', email: 'u@example.com', fullName: 'U', mfaEnabled: false },
    audience: 'tenant',
    activeTenant: { id: 't', name: 'T', slug: 't', status: 'active' },
    memberships: [],
    roles: [],
    permissions: { platform: [], tenant: [], byRestaurant: {}, byBranch: {} },
    branches: [],
    homePath: '/no-access',
    ...overrides,
  };
}

const owner = profile({
  roles: ['owner'],
  permissions: {
    platform: [],
    tenant: ['restaurant:read', 'branch:manage', 'pos:access', 'kds:access', 'waiter:access'],
    byRestaurant: {},
    byBranch: {},
  },
  homePath: '/restaurant/dashboard',
});
const cashier = profile({
  roles: ['cashier'],
  permissions: {
    platform: [],
    tenant: [],
    byRestaurant: {},
    byBranch: { b1: ['branch:read', 'pos:access'] },
  },
  homePath: '/pos',
});
const superAdmin = profile({
  audience: 'platform',
  activeTenant: null,
  roles: ['super_admin'],
  permissions: {
    platform: ['platform:dashboard_view'],
    tenant: [],
    byRestaurant: {},
    byBranch: {},
  },
  homePath: '/platform/dashboard',
});

describe('canAccessPath', () => {
  it('keeps restaurant users out of platform administration', () => {
    expect(canAccessPath(owner, '/platform/dashboard')).toBe(false);
    expect(canAccessPath(cashier, '/platform')).toBe(false);
    expect(canAccessPath(superAdmin, '/platform/dashboard')).toBe(true);
  });

  it('keeps platform sessions out of restaurant areas', () => {
    expect(canAccessPath(superAdmin, '/restaurant/dashboard')).toBe(false);
    expect(canAccessPath(superAdmin, '/pos')).toBe(false);
  });

  it('gates staff areas by permission in any scope', () => {
    expect(canAccessPath(cashier, '/pos')).toBe(true);
    expect(canAccessPath(cashier, '/restaurant/dashboard')).toBe(false);
    expect(canAccessPath(cashier, '/kitchen')).toBe(false);
    expect(canAccessPath(owner, '/kitchen')).toBe(true);
  });

  it('does not treat look-alike paths as protected areas', () => {
    expect(canAccessPath(cashier, '/posters')).toBe(true);
  });
});

describe('safeNextPath', () => {
  it.each([
    ['/pos', '/pos'],
    ['/restaurant/dashboard?tab=1', '/restaurant/dashboard?tab=1'],
    ['//evil.example', null],
    ['/\\evil.example', null],
    ['https://evil.example', null],
    ['', null],
    [null, null],
  ])('%p → %p', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });
});

describe('destinationAfterLogin (role-based redirection)', () => {
  it('sends each role home when no page was requested', () => {
    expect(destinationAfterLogin(owner, null)).toBe('/restaurant/dashboard');
    expect(destinationAfterLogin(cashier, null)).toBe('/pos');
    expect(destinationAfterLogin(superAdmin, null)).toBe('/platform/dashboard');
  });

  it('honours a requested page only when the user may open it', () => {
    expect(destinationAfterLogin(owner, '/kitchen')).toBe('/kitchen');
    expect(destinationAfterLogin(cashier, '/restaurant/dashboard')).toBe('/pos');
    expect(destinationAfterLogin(cashier, '/platform/dashboard')).toBe('/pos');
    expect(destinationAfterLogin(owner, '//evil.example')).toBe('/restaurant/dashboard');
    expect(destinationAfterLogin(owner, '/login')).toBe('/restaurant/dashboard');
  });
});
