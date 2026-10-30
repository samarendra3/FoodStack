import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

export interface TenantWorld {
  tenantId: string;
  restaurantId: string;
  branchId: string;
  otherBranchId: string;
  userId: string;
  membershipId: string;
  customRoleId: string;
  sessionId: string;
}

const suffix = () => randomBytes(4).toString('hex');

/**
 * Creates a tenant with one restaurant, two branches, one active member with a session, and a
 * custom role. Uses the owner pool (RLS does not apply), so isolation is tested only through
 * the app pool. Names are randomised so parallel files never collide.
 */
export async function createTenantWorld(owner: Pool, label: string): Promise<TenantWorld> {
  const s = suffix();
  const one = async (sql: string, params: unknown[]): Promise<string> => {
    const { rows } = await owner.query<{ id: string }>(sql, params);
    return rows[0]!.id;
  };

  const tenantId = await one(`INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`, [
    `${label}-${s}`,
    `${label} ${s}`,
  ]);
  const restaurantId = await one(
    `INSERT INTO restaurants (tenant_id, name, slug, currency_code, country_code, timezone)
     VALUES ($1, $2, $3, 'INR', 'IN', 'Asia/Kolkata') RETURNING id`,
    [tenantId, `${label} Restaurant`, `${label}-r-${s}`],
  );
  const branchId = await one(
    `INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone, is_default)
     VALUES ($1, $2, 'MAIN', 'Main', 'Asia/Kolkata', true) RETURNING id`,
    [tenantId, restaurantId],
  );
  const otherBranchId = await one(
    `INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone)
     VALUES ($1, $2, 'SECOND', 'Second', 'Asia/Kolkata') RETURNING id`,
    [tenantId, restaurantId],
  );
  const userId = await one(`INSERT INTO users (email, full_name) VALUES ($1, $2) RETURNING id`, [
    `${label}-${s}@example.test`,
    `${label} User`,
  ]);
  const membershipId = await one(
    `INSERT INTO tenant_memberships (tenant_id, user_id, status, joined_at)
     VALUES ($1, $2, 'active', now()) RETURNING id`,
    [tenantId, userId],
  );
  const customRoleId = await one(
    `INSERT INTO roles (tenant_id, code, name, audience) VALUES ($1, $2, 'Custom', 'tenant') RETURNING id`,
    [tenantId, `custom_${s}`],
  );
  const sessionId = await one(
    `INSERT INTO sessions (user_id, audience, tenant_id, membership_id, idle_expires_at, absolute_expires_at)
     VALUES ($1, 'tenant', $2, $3, now() + interval '30 days', now() + interval '90 days') RETURNING id`,
    [userId, tenantId, membershipId],
  );
  return {
    tenantId,
    restaurantId,
    branchId,
    otherBranchId,
    userId,
    membershipId,
    customRoleId,
    sessionId,
  };
}

/** Id of a seeded system role or permission. */
export async function systemRoleId(owner: Pool, code: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    'SELECT id FROM roles WHERE tenant_id IS NULL AND code = $1',
    [code],
  );
  return rows[0]!.id;
}

export async function permissionId(owner: Pool, code: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>('SELECT id FROM permissions WHERE code = $1', [
    code,
  ]);
  return rows[0]!.id;
}
