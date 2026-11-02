/**
 * Operator commands. No password is ever passed on the command line or stored in the repository:
 * each command prints a one-time link where the person sets their own password.
 *
 *   pnpm --filter @foodstack/api cli platform:create-admin --email admin@example.com --name "Ana Admin"
 *   pnpm --filter @foodstack/api cli tenant:create --name "Spice Hub" --slug spice-hub \
 *        --owner-email owner@example.com --owner-name "Olu Owner" [--currency INR --country IN --timezone Asia/Kolkata]
 *   pnpm --filter @foodstack/api cli tenant:add-member --tenant spice-hub --email cashier@example.com \
 *        --name "Cara Cashier" --role cashier [--branch MAIN]
 *
 * Runs as the API role (DATABASE_USER) under row-level security, like the API itself.
 */
import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DataSource } from 'typeorm';
import { envFilePaths } from './config/env-files';
import { validateEnv } from './config/env.validation';
import { Db } from './core/db/db-context';
import { issueUserToken, writeAudit } from './modules/auth/user-tokens';
import { buildDataSourceOptions } from './database/typeorm.options';

const SET_PASSWORD_TTL_MS = 72 * 3_600_000;
/** Roles granted per branch; every other tenant role is granted for the whole tenant. */
const BRANCH_ROLES = new Set([
  'branch_manager',
  'cashier',
  'waiter',
  'kitchen_manager',
  'kitchen_staff',
]);

for (const file of envFilePaths()) {
  if (existsSync(file)) process.loadEnvFile(file);
}
const env = validateEnv(process.env);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    slug: { type: 'string' },
    tenant: { type: 'string' },
    role: { type: 'string' },
    branch: { type: 'string', default: 'MAIN' },
    'owner-email': { type: 'string' },
    'owner-name': { type: 'string' },
    currency: { type: 'string', default: 'INR' },
    country: { type: 'string', default: 'IN' },
    timezone: { type: 'string', default: 'Asia/Kolkata' },
  },
});

function required(name: keyof typeof values): string {
  const value = values[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`--${name} is required`);
  }
  return value.trim();
}

async function inTransaction<T>(ds: DataSource, work: (db: Db) => Promise<T>): Promise<T> {
  return ds.transaction(async (manager) => work(new Db(manager.queryRunner!)));
}

/** Finds or creates the user; returns its id and whether it already had a password. */
async function upsertUser(db: Db, email: string, fullName: string) {
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

async function setPasswordLink(db: Db, userId: string): Promise<string> {
  const { token } = await issueUserToken(db, userId, 'password_reset', SET_PASSWORD_TTL_MS);
  return `${env.APP_URL}/reset-password?token=${token}`;
}

async function createPlatformAdmin(ds: DataSource): Promise<string> {
  const email = required('email');
  return inTransaction(ds, async (db) => {
    const user = await upsertUser(db, email, required('name'));
    await db.setScope({ platform: true, userId: user.id });
    await db.query(
      `INSERT INTO platform_role_assignments (user_id, role_id)
       SELECT $1, id FROM roles WHERE tenant_id IS NULL AND code = 'super_admin'
       ON CONFLICT (user_id, role_id) DO NOTHING`,
      [user.id],
    );
    await writeAudit(db, {
      action: 'platform.roles_changed',
      entityType: 'user',
      entityId: user.id,
      metadata: { granted: 'super_admin', via: 'cli' },
    });
    const link = await setPasswordLink(db, user.id);
    return `Super Admin ${email} is ready.\nSet the password (valid 72 h): ${link}\nTwo-factor setup starts at the first sign-in.`;
  });
}

async function createTenant(ds: DataSource): Promise<string> {
  const slug = required('slug').toLowerCase();
  const name = required('name');
  const ownerEmail = required('owner-email');
  return inTransaction(ds, async (db) => {
    const owner = await upsertUser(db, ownerEmail, required('owner-name'));
    // Creating tenants is a platform action; the new tenant's rows are then written in its scope.
    await db.setScope({ platform: true });
    const tenant = await db.one<{ id: string }>(
      `INSERT INTO tenants (slug, name, status, trial_ends_at)
       VALUES ($1, $2, 'trial', now() + interval '14 days') RETURNING id`,
      [slug, name],
    );
    await db.setScope({ tenantId: tenant!.id, userId: owner.id });
    const restaurant = await db.one<{ id: string }>(
      `INSERT INTO restaurants (tenant_id, name, slug, currency_code, country_code, timezone)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenant!.id, name, slug, values.currency, values.country, values.timezone],
    );
    await db.query(
      `INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone, is_default)
       VALUES ($1, $2, 'MAIN', 'Main branch', $3, true)`,
      [tenant!.id, restaurant!.id, values.timezone],
    );
    const membership = await db.one<{ id: string }>(
      `INSERT INTO tenant_memberships (tenant_id, user_id, status, joined_at)
       VALUES ($1, $2, 'active', now()) RETURNING id`,
      [tenant!.id, owner.id],
    );
    await db.query(
      `INSERT INTO user_role_assignments (tenant_id, membership_id, role_id, scope_type)
       SELECT $1, $2, id, 'tenant' FROM roles WHERE tenant_id IS NULL AND code = 'owner'`,
      [tenant!.id, membership!.id],
    );
    await writeAudit(db, {
      action: 'tenant.created',
      tenantId: tenant!.id,
      entityType: 'tenant',
      entityId: tenant!.id,
      metadata: { via: 'cli', slug },
    });
    const link = owner.hasPassword ? null : await setPasswordLink(db, owner.id);
    return [
      `Restaurant "${name}" (${slug}) created with branch MAIN; owner ${ownerEmail}.`,
      link ? `Owner sets a password here (valid 72 h): ${link}` : 'Owner already has a password.',
    ].join('\n');
  });
}

async function addMember(ds: DataSource): Promise<string> {
  const slug = required('tenant').toLowerCase();
  const email = required('email');
  const role = required('role');
  return inTransaction(ds, async (db) => {
    await db.setScope({ platform: true });
    const tenant = await db.one<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [slug]);
    if (!tenant) throw new Error(`No tenant with slug ${slug}`);
    const user = await upsertUser(db, email, required('name'));
    await db.setScope({ tenantId: tenant.id, userId: user.id });
    const roleRow = await db.one<{ id: string }>(
      `SELECT id FROM roles WHERE code = $1 AND audience = 'tenant'
        AND (tenant_id IS NULL OR tenant_id = $2)`,
      [role, tenant.id],
    );
    if (!roleRow) throw new Error(`Unknown tenant role ${role}`);
    let branchId: string | null = null;
    if (BRANCH_ROLES.has(role)) {
      const branch = await db.one<{ id: string }>('SELECT id FROM branches WHERE code = $1', [
        values.branch,
      ]);
      if (!branch) throw new Error(`No branch with code ${values.branch} in ${slug}`);
      branchId = branch.id;
    }
    const membership = await db.one<{ id: string }>(
      `INSERT INTO tenant_memberships (tenant_id, user_id, status, joined_at)
       VALUES ($1, $2, 'active', now())
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = 'active'
       RETURNING id`,
      [tenant.id, user.id],
    );
    await db.query(
      `INSERT INTO user_role_assignments (tenant_id, membership_id, role_id, scope_type, scope_id)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [tenant.id, membership!.id, roleRow.id, branchId ? 'branch' : 'tenant', branchId],
    );
    await db.query(
      'UPDATE tenant_memberships SET permission_version = permission_version + 1 WHERE id = $1',
      [membership!.id],
    );
    await writeAudit(db, {
      action: 'member.roles_changed',
      tenantId: tenant.id,
      entityType: 'membership',
      entityId: membership!.id,
      metadata: { via: 'cli', role, branch: branchId ? values.branch : null },
    });
    const link = user.hasPassword ? null : await setPasswordLink(db, user.id);
    return [
      `${email} is now ${role}${branchId ? ` at branch ${values.branch}` : ''} in ${slug}.`,
      link ? `They set a password here (valid 72 h): ${link}` : 'They already have a password.',
    ].join('\n');
  });
}

const COMMANDS: Record<string, (ds: DataSource) => Promise<string>> = {
  'platform:create-admin': createPlatformAdmin,
  'tenant:create': createTenant,
  'tenant:add-member': addMember,
};

async function main(): Promise<void> {
  const command = COMMANDS[positionals[0] ?? ''];
  if (!command) {
    console.error(`Usage: cli <${Object.keys(COMMANDS).join(' | ')}> [options] (see src/cli.ts)`);
    process.exitCode = 1;
    return;
  }
  const ds = await new DataSource({
    ...buildDataSourceOptions({ ...env, DATABASE_LOGGING: false }, 'app'),
    entities: [],
    migrations: [],
  }).initialize();
  try {
    process.stdout.write(`${await command(ds)}
`);
  } finally {
    await ds.destroy();
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
