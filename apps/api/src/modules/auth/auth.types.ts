export type Audience = 'tenant' | 'platform';

/** Authenticated caller, attached to the request by AuthGuard. */
export interface AuthContext {
  userId: string;
  sessionId: string;
  audience: Audience;
  tenantId: string | null;
  membershipId: string | null;
  /** True when this session passed TOTP. */
  mfaVerified: boolean;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export interface BranchRef {
  id: string;
  name: string;
  code: string;
  restaurantId: string;
}

export interface Assignment {
  role: string;
  scopeType: 'tenant' | 'restaurant' | 'branch';
  scopeId: string | null;
  permissions: string[];
}

/** Everything a tenant member may do, by scope (docs/phase-3-design.md §3.3). */
export interface TenantAccess {
  roles: string[];
  /** Permissions held at tenant scope: they cover every restaurant and branch. */
  tenant: string[];
  byRestaurant: Record<string, string[]>;
  byBranch: Record<string, string[]>;
  /** Every branch in the tenant (RLS limits the query to it), to map branch → restaurant. */
  allBranches: BranchRef[];
}

/** Body of a successful sign-in, refresh or /auth/me. Never contains secrets. */
export interface SessionProfile {
  user: { id: string; email: string; fullName: string; mfaEnabled: boolean };
  audience: Audience;
  activeTenant: { id: string; name: string; slug: string; status: string } | null;
  memberships: { tenantId: string; name: string; slug: string; status: string }[];
  roles: string[];
  permissions: {
    platform: string[];
    tenant: string[];
    byRestaurant: Record<string, string[]>;
    byBranch: Record<string, string[]>;
  };
  branches: BranchRef[];
  /** Where the frontend sends the user after sign-in. Access is still checked server-side. */
  homePath: string;
}
