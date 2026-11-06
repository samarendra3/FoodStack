#!/usr/bin/env node
/**
 * Seeds a load-test tenant into a *_load database (never dev, test or production):
 * one restaurant, two branches, an owner and a cashier per branch, and a complimentary
 * (unlimited) subscription so order quotas don't turn the test into a quota test.
 * Optionally adds historical orders for large-dataset runs (LOAD_ORDERS, default 0).
 * The menu is created through the API by the k6 setup() step.
 *
 * Usage (from apps/api, schema already migrated):
 *   DATABASE_HOST=localhost DATABASE_NAME=foodstack_load \
 *   DATABASE_MIGRATION_USER=foodstack_owner DATABASE_MIGRATION_PASSWORD=... \
 *   LOAD_PASSWORD='Load-Test-Pass-42' [LOAD_ORDERS=1000000] node scripts/seed-load.mjs
 * Prints the credentials k6 needs as JSON.
 */
import argon2 from 'argon2';
import pg from 'pg';

const name = process.env.DATABASE_NAME ?? '';
if (!name.endsWith('_load')) {
  console.error(`Refusing to seed "${name}": the database name must end in _load.`);
  process.exit(1);
}
const password = process.env.LOAD_PASSWORD;
if (!password || password.length < 12) {
  console.error('Set LOAD_PASSWORD (at least 12 characters).');
  process.exit(1);
}
const orders = Number(process.env.LOAD_ORDERS ?? 0);
const batch = 50_000;

const client = new pg.Client({
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5432),
  database: name,
  user: process.env.DATABASE_MIGRATION_USER,
  password: process.env.DATABASE_MIGRATION_PASSWORD,
});
await client.connect();
const one = async (sql, params) => (await client.query(sql, params)).rows[0];

try {
  const existing = await one(`SELECT id FROM tenants WHERE slug = 'load-tenant'`);
  if (existing)
    throw new Error('load-tenant already exists: drop and recreate the _load database to reseed.');
  const hash = await argon2.hash(password, { type: argon2.argon2id });

  await client.query('BEGIN');
  const t = await one(
    `INSERT INTO tenants (slug, name) VALUES ('load-tenant', 'Load Test') RETURNING id`,
  );
  const r = await one(
    `INSERT INTO restaurants (tenant_id, name, slug, currency_code, country_code, timezone)
     VALUES ($1, 'Load Restaurant', 'load-restaurant', 'INR', 'IN', 'Asia/Kolkata') RETURNING id`,
    [t.id],
  );
  const branches = [];
  for (const code of ['MAIN', 'SECOND']) {
    branches.push(
      (
        await one(
          `INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone, is_default)
           VALUES ($1, $2, $3, $4, 'Asia/Kolkata', $5) RETURNING id`,
          [t.id, r.id, code, `${code} branch`, code === 'MAIN'],
        )
      ).id,
    );
  }
  // Every new tenant gets a trial subscription from a trigger; turn it into a complimentary
  // one (no plan, no end), which the entitlement rules treat as unlimited.
  await client.query(
    `INSERT INTO subscriptions (tenant_id, status, current_period_start) VALUES ($1, 'active', now())
     ON CONFLICT (tenant_id) DO UPDATE
        SET status = 'active', plan_id = NULL, billing_cycle = NULL, plan_snapshot = NULL,
            current_period_start = now(), current_period_end = NULL,
            trial_started_at = NULL, trial_ends_at = NULL, status_changed_at = now(),
            status_reason = 'Load test (complimentary)'`,
    [t.id],
  );
  const users = {};
  const member = async (key, role, branchId) => {
    const email = `${key}@load.example.test`;
    const u = await one(
      `INSERT INTO users (email, full_name, password_hash, email_verified_at)
       VALUES ($1, $2, $3, now()) RETURNING id`,
      [email, key, hash],
    );
    const m = await one(
      `INSERT INTO tenant_memberships (tenant_id, user_id, status, joined_at)
       VALUES ($1, $2, 'active', now()) RETURNING id`,
      [t.id, u.id],
    );
    await client.query(
      `INSERT INTO user_role_assignments (tenant_id, membership_id, role_id, scope_type, scope_id)
       SELECT $1, $2, id, $4, $5 FROM roles WHERE tenant_id IS NULL AND code = $3`,
      [t.id, m.id, role, branchId ? 'branch' : 'tenant', branchId ?? null],
    );
    users[key] = email;
  };
  await member('load-owner', 'owner');
  await member('load-cashier-main', 'cashier', branches[0]);
  await member('load-cashier-second', 'cashier', branches[1]);
  await client.query('COMMIT');

  // Historical orders (no items) for large-dataset list and analytics runs.
  for (let from = 1; from <= orders; from += batch) {
    const to = Math.min(orders, from + batch - 1);
    await client.query(
      `INSERT INTO orders (tenant_id, restaurant_id, branch_id, order_number, channel, status,
                           kitchen_status, currency_code, tax_rate_bp, subtotal_minor, discount_minor,
                           tax_minor, total_minor, paid_minor, refunded_minor, created_at, completed_at,
                           cancelled_at, cancel_reason)
       SELECT $1, $2, CASE WHEN g % 2 = 0 THEN $3::uuid ELSE $4::uuid END, 1000000 + g, 'takeaway',
              CASE WHEN g % 20 = 0 THEN 'cancelled' ELSE 'completed' END, 'served', 'INR', 500,
              10000, 0, 500, 10500, CASE WHEN g % 20 = 0 THEN 0 ELSE 10500 END, 0,
              now() - ((g::bigint * 7919) % 525600) * interval '1 minute',
              CASE WHEN g % 20 = 0 THEN NULL ELSE now() - ((g::bigint * 7919) % 525600) * interval '1 minute' END,
              CASE WHEN g % 20 = 0 THEN now() - ((g::bigint * 7919) % 525600) * interval '1 minute' END,
              CASE WHEN g % 20 = 0 THEN 'load test' END
         FROM generate_series($5::int, $6::int) g`,
      [t.id, r.id, branches[0], branches[1], from, to],
    );
    process.stderr.write(`orders ${to}/${orders}\n`);
  }
  if (orders > 0) await client.query('ANALYZE orders');

  console.log(JSON.stringify({ tenantId: t.id, branches, users }, null, 2));
} catch (e) {
  await client.query('ROLLBACK').catch(() => undefined);
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await client.end();
}
