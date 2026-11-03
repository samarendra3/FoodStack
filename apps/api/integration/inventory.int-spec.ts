import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PasswordHasher } from '../src/core/security/password-hasher';
import { connect } from './helpers';

/**
 * Inventory: restaurant-wide item list, per-branch stock, the movement ledger, scope rules
 * (branch managers move stock only at their branch) and tenant isolation.
 */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;

describe('Inventory (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  let passwordHash: string;
  const tenants: string[] = [];
  const emails: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  let alpha: { id: string; main: string; second: string };

  const call = (who: string, method: 'get' | 'post' | 'patch' | 'delete', url: string) =>
    request(app.getHttpServer())
      [method](`${API}${url}`)
      .set('X-Forwarded-For', freshIp())
      .set('Authorization', `Bearer ${tokens[who]}`);

  async function createTenant(label: string) {
    const [t] = await migrator.query(
      `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
      [`${label}-${suffix()}`, `${label} Foods`],
    );
    tenants.push(t.id);
    const [r] = await migrator.query(
      `INSERT INTO restaurants (tenant_id, name, slug, currency_code, country_code, timezone)
       VALUES ($1, $2, $3, 'INR', 'IN', 'Asia/Kolkata') RETURNING id`,
      [t.id, label, `${label}-${suffix()}`],
    );
    const branch = async (code: string, isDefault: boolean) =>
      (
        await migrator.query(
          `INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone, is_default)
           VALUES ($1, $2, $3, $4, 'Asia/Kolkata', $5) RETURNING id`,
          [t.id, r.id, code, `${code} branch`, isDefault],
        )
      )[0].id as string;
    return {
      id: t.id as string,
      main: await branch('MAIN', true),
      second: await branch('SECOND', false),
    };
  }

  async function addMember(key: string, tenantId: string, role: string, branchId?: string) {
    emails[key] = `${key}-${suffix()}@example.test`;
    const [u] = await migrator.query(
      `INSERT INTO users (email, full_name, password_hash, email_verified_at)
       VALUES ($1, $2, $3, now()) RETURNING id`,
      [emails[key], key, passwordHash],
    );
    const [m] = await migrator.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, status, joined_at)
       VALUES ($1, $2, 'active', now()) RETURNING id`,
      [tenantId, u.id],
    );
    await migrator.query(
      `INSERT INTO user_role_assignments (tenant_id, membership_id, role_id, scope_type, scope_id)
       SELECT $1, $2, id, $4, $5 FROM roles WHERE tenant_id IS NULL AND code = $3`,
      [tenantId, m.id, role, branchId ? 'branch' : 'tenant', branchId ?? null],
    );
  }

  beforeAll(async () => {
    migrator = await connect('migration');
    await migrator.runMigrations({ transaction: 'each' });
    passwordHash = await new PasswordHasher().hash(PASSWORD);

    alpha = await createTenant('invalpha');
    const bravo = await createTenant('invbravo');
    await addMember('owner', alpha.id, 'owner');
    await addMember('manager', alpha.id, 'branch_manager', alpha.main);
    await addMember('cashier', alpha.id, 'cashier', alpha.main);
    await addMember('bravoOwner', bravo.id, 'owner');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app);
    await app.init();

    for (const who of Object.keys(emails)) {
      const res = await request(app.getHttpServer())
        .post(`${API}/auth/login`)
        .set('X-Forwarded-For', freshIp())
        .send({ email: emails[who], password: PASSWORD })
        .expect(200);
      tokens[who] = res.body.data.accessToken as string;
    }
  });

  afterAll(async () => {
    await app?.close();
    if (migrator?.isInitialized) {
      for (const table of [
        'inventory_movements',
        'inventory_stock',
        'inventory_items',
        'user_role_assignments',
      ]) {
        await migrator.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
      }
      await migrator.destroy();
    }
  });

  let rice: string;

  it('lets the owner add items, and rejects duplicates', async () => {
    const res = await call('owner', 'post', '/inventory/items')
      .send({
        name: 'Basmati Rice',
        unit: 'kg',
        category: 'Grains',
        lowStockThreshold: 5,
        costPerUnitMinor: 9000,
      })
      .expect(201);
    rice = res.body.data.id;
    await call('owner', 'post', '/inventory/items')
      .send({ name: 'basmati rice', unit: 'kg' })
      .expect(409);
  });

  it('starts at zero and records purchase, usage, wastage and count', async () => {
    let inv = (await call('owner', 'get', `/inventory?branchId=${alpha.main}`).expect(200)).body
      .data;
    expect(inv.items).toEqual([expect.objectContaining({ id: rice, quantity: 0, status: 'out' })]);

    const move = (type: string, quantity: number) =>
      call('owner', 'post', `/inventory/items/${rice}/movements`).send({
        branchId: alpha.main,
        type,
        quantity,
      });
    expect((await move('purchase', 20).expect(201)).body.data.quantity).toBe(20);
    expect((await move('usage', 12.5).expect(201)).body.data.quantity).toBe(7.5);
    expect((await move('wastage', 3).expect(201)).body.data.quantity).toBe(4.5);
    await move('usage', 10).expect(409);
    expect((await move('count', 4).expect(201)).body.data.quantity).toBe(4);

    inv = (await call('owner', 'get', `/inventory?branchId=${alpha.main}`).expect(200)).body.data;
    expect(inv.items[0]).toMatchObject({
      quantity: 4,
      status: 'low',
      unit: 'kg',
      costPerUnitMinor: 9000,
    });
    const second = (await call('owner', 'get', `/inventory?branchId=${alpha.second}`).expect(200))
      .body.data;
    expect(second.items[0]).toMatchObject({ quantity: 0 });

    const history = (
      await call(
        'owner',
        'get',
        `/inventory/items/${rice}/movements?branchId=${alpha.main}`,
      ).expect(200)
    ).body.data;
    expect(history.map((h: { type: string }) => h.type)).toEqual([
      'count',
      'wastage',
      'usage',
      'purchase',
    ]);
    expect(history[0]).toMatchObject({ quantityDelta: -0.5, quantityAfter: 4 });
  });

  it('lets a branch manager move stock only at their branch, not edit the item list', async () => {
    const inv = (await call('manager', 'get', '/inventory').expect(200)).body.data;
    expect(inv).toMatchObject({
      canManageItems: false,
      canRecordMovements: true,
      branch: { id: alpha.main },
    });
    await call('manager', 'post', `/inventory/items/${rice}/movements`)
      .send({ branchId: alpha.main, type: 'purchase', quantity: 1 })
      .expect(201);
    await call('manager', 'post', `/inventory/items/${rice}/movements`)
      .send({ branchId: alpha.second, type: 'purchase', quantity: 1 })
      .expect(403);
    await call('manager', 'get', `/inventory?branchId=${alpha.second}`).expect(403);
    await call('manager', 'post', '/inventory/items')
      .send({ name: 'Salt', unit: 'kg' })
      .expect(403);
  });

  it('keeps cashiers out and isolates tenants', async () => {
    await call('cashier', 'get', '/inventory').expect(403);
    const bravo = (await call('bravoOwner', 'get', '/inventory').expect(200)).body.data;
    expect(bravo.items).toEqual([]);
    await call('bravoOwner', 'patch', `/inventory/items/${rice}`).send({ name: 'x' }).expect(404);
    await call('bravoOwner', 'post', `/inventory/items/${rice}/movements`)
      .send({ branchId: alpha.main, type: 'purchase', quantity: 1 })
      .expect(403);
  });

  it('validates movement input', async () => {
    const send = (body: object) =>
      call('owner', 'post', `/inventory/items/${rice}/movements`).send({
        branchId: alpha.main,
        ...body,
      });
    await send({ type: 'purchase', quantity: 0 }).expect(400);
    await send({ type: 'purchase', quantity: 1.2345 }).expect(400);
    await send({ type: 'refund', quantity: 1 }).expect(400);
  });

  it('edits and deletes an item', async () => {
    await call('owner', 'patch', `/inventory/items/${rice}`)
      .send({ lowStockThreshold: 2, category: null })
      .expect(204);
    let inv = (await call('owner', 'get', `/inventory?branchId=${alpha.main}`).expect(200)).body
      .data;
    expect(inv.items[0]).toMatchObject({ lowStockThreshold: 2, category: null, status: 'ok' });
    await call('owner', 'delete', `/inventory/items/${rice}`).expect(204);
    inv = (await call('owner', 'get', `/inventory?branchId=${alpha.main}`).expect(200)).body.data;
    expect(inv.items).toEqual([]);
  });
});
