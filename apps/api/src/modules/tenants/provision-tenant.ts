import type { Db } from '../../core/db/db-context';
import { writeAudit } from '../auth/user-tokens';

export interface ProvisionTenantInput {
  name: string;
  slug: string;
  ownerEmail: string;
  ownerName: string;
  currency: string;
  country: string;
  timezone: string;
  /** Super Admin who triggered it (null from the CLI). */
  actorUserId?: string | null;
  via: 'cli' | 'access_request';
  /** Free trial length in days (default 15). */
  trialDays?: number;
}

export interface ProvisionedTenant {
  tenantId: string;
  ownerId: string;
  /** False when the owner account is new and still needs a set-password link. */
  ownerHasPassword: boolean;
}

/** Finds or creates the user; returns its id and whether it already had a password. */
export async function upsertUser(db: Db, email: string, fullName: string) {
  const existing = await db.one<{ id: string; password_hash: string | null }>(
    'SELECT id, password_hash FROM users WHERE email = $1',
    [email.toLowerCase()],
  );
  if (existing) return { id: existing.id, hasPassword: existing.password_hash !== null };
  const created = await db.one<{ id: string }>(
    'INSERT INTO users (email, full_name) VALUES ($1, $2) RETURNING id',
    [email.toLowerCase(), fullName],
  );
  return { id: created!.id, hasPassword: false };
}

/**
 * Creates a restaurant account on a 15-day trial (trial_ends_at is set by the database from its clock): tenant, restaurant, MAIN branch, and the owner
 * with the Owner role. Runs inside the caller's transaction; leaves the scope set to the new
 * tenant. Throws on a taken slug (unique constraint), which callers turn into a clear message.
 */
export async function provisionTenant(
  db: Db,
  input: ProvisionTenantInput,
): Promise<ProvisionedTenant> {
  const owner = await upsertUser(db, input.ownerEmail, input.ownerName);
  // Creating tenants is a platform action; the new tenant's rows are then written in its scope.
  await db.setScope({ platform: true, userId: input.actorUserId ?? null });
  const tenant = await db.one<{ id: string }>(
    `INSERT INTO tenants (slug, name, status, trial_ends_at)
     VALUES ($1, $2, 'trial', now() + make_interval(days => $3)) RETURNING id`,
    [input.slug, input.name, input.trialDays ?? 15],
  );
  const tenantId = tenant!.id;
  await db.setScope({ tenantId, userId: owner.id });
  const restaurant = await db.one<{ id: string }>(
    `INSERT INTO restaurants (tenant_id, name, slug, currency_code, country_code, timezone)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [tenantId, input.name, input.slug, input.currency, input.country, input.timezone],
  );
  await db.query(
    `INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone, is_default)
     VALUES ($1, $2, 'MAIN', 'Main branch', $3, true)`,
    [tenantId, restaurant!.id, input.timezone],
  );
  const membership = await db.one<{ id: string }>(
    `INSERT INTO tenant_memberships (tenant_id, user_id, status, joined_at)
     VALUES ($1, $2, 'active', now()) RETURNING id`,
    [tenantId, owner.id],
  );
  await db.query(
    `INSERT INTO user_role_assignments (tenant_id, membership_id, role_id, scope_type)
     SELECT $1, $2, id, 'tenant' FROM roles WHERE tenant_id IS NULL AND code = 'owner'`,
    [tenantId, membership!.id],
  );
  await writeAudit(db, {
    action: 'tenant.created',
    tenantId,
    actorUserId: input.actorUserId ?? null,
    actorAudience: input.actorUserId ? 'platform' : 'system',
    entityType: 'tenant',
    entityId: tenantId,
    metadata: { via: input.via, slug: input.slug },
  });
  return { tenantId, ownerId: owner.id, ownerHasPassword: owner.hasPassword };
}
