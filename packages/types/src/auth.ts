/** Session audience: restaurant staff (`tenant`) or FoodStack platform administrators. */
export type AuthAudience = 'tenant' | 'platform';

export interface BranchSummary {
  id: string;
  name: string;
  code: string;
  restaurantId: string;
}

/**
 * Who is signed in and what they may do. Returned by sign-in, refresh and `GET /auth/me`.
 * The frontend uses it only to shape the UI; the API authorizes every request itself.
 */
export interface SessionProfile {
  user: { id: string; email: string; fullName: string; mfaEnabled: boolean };
  audience: AuthAudience;
  activeTenant: { id: string; name: string; slug: string; status: string } | null;
  memberships: { tenantId: string; name: string; slug: string; status: string }[];
  roles: string[];
  permissions: {
    platform: string[];
    tenant: string[];
    byRestaurant: Record<string, string[]>;
    byBranch: Record<string, string[]>;
  };
  branches: BranchSummary[];
  /** Landing page for this user's roles, e.g. `/pos` for a cashier. */
  homePath: string;
}

export interface AuthSession {
  accessToken: string;
  expiresAt: string;
  profile: SessionProfile;
}

/** `POST /auth/login` answers 202 with this when a TOTP step follows. */
export interface MfaChallenge {
  mfaRequired: true;
  mfaEnrollmentRequired: boolean;
  challengeToken: string;
}

export interface MfaEnrollment {
  otpauthUrl: string;
  qrDataUrl: string;
  manualKey: string;
}
