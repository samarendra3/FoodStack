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
 * Menu: managers build categories and items; staff (incl. branch-scoped cashiers) can read the
 * menu but not change it; tenants never see each other's menus.
 */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;

describe('Menu (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  let passwordHash: string;
  const tenants: string[] = [];
  const emails: Record<string, string> = {};
  const tokens: Record<string, string> = {};

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
    const [b] = await migrator.query(
      `INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone, is_default)
       VALUES ($1, $2, 'MAIN', 'Main', 'Asia/Kolkata', true) RETURNING id`,
      [t.id, r.id],
    );
    return { id: t.id as string, restaurant: r.id as string, branch: b.id as string };
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

    const alpha = await createTenant('menualpha');
    const bravo = await createTenant('menubravo');
    await addMember('owner', alpha.id, 'owner');
    await addMember('cashier', alpha.id, 'cashier', alpha.branch);
    await addMember('bravoOwner', bravo.id, 'owner');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app);
    await app.init();

    for (const who of ['owner', 'cashier', 'bravoOwner']) {
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
      await migrator.query('DELETE FROM menu_items WHERE tenant_id = ANY($1::uuid[])', [tenants]);
      await migrator.query('DELETE FROM menu_categories WHERE tenant_id = ANY($1::uuid[])', [
        tenants,
      ]);
      await migrator.query('DELETE FROM user_role_assignments WHERE tenant_id = ANY($1::uuid[])', [
        tenants,
      ]);
      await migrator.destroy();
    }
  });

  let categoryId: string;
  let itemId: string;

  it('starts empty and lets the owner manage it', async () => {
    const res = await call('owner', 'get', '/menu').expect(200);
    expect(res.body.data).toMatchObject({
      categories: [],
      items: [],
      canManage: true,
      restaurant: { currencyCode: 'INR' },
    });
  });

  it('creates a category and rejects a duplicate name', async () => {
    const res = await call('owner', 'post', '/menu/categories')
      .send({ name: 'Starters' })
      .expect(201);
    categoryId = res.body.data.id;
    await call('owner', 'post', '/menu/categories').send({ name: 'starters' }).expect(409);
  });

  it('creates, edits and lists an item', async () => {
    const res = await call('owner', 'post', '/menu/items')
      .send({ categoryId, name: 'Paneer Tikka', priceMinor: 26000, diet: 'veg' })
      .expect(201);
    itemId = res.body.data.id;
    await call('owner', 'patch', `/menu/items/${itemId}`)
      .send({ priceMinor: 28000, isAvailable: false, description: 'Smoky' })
      .expect(204);
    const menu = (await call('owner', 'get', '/menu').expect(200)).body.data;
    expect(menu.categories).toEqual([expect.objectContaining({ name: 'Starters', itemCount: 1 })]);
    expect(menu.items).toEqual([
      expect.objectContaining({
        id: itemId,
        priceMinor: 28000,
        currencyCode: 'INR',
        isAvailable: false,
        description: 'Smoky',
        diet: 'veg',
      }),
    ]);
  });

  it('validates input', async () => {
    await call('owner', 'post', '/menu/items')
      .send({ categoryId, name: 'Bad', priceMinor: -1, diet: 'veg' })
      .expect(400);
    await call('owner', 'post', '/menu/items')
      .send({ categoryId, name: 'Bad', priceMinor: 100, diet: 'vegan' })
      .expect(400);
  });

  it('lets a branch cashier read but not change the menu', async () => {
    const res = await call('cashier', 'get', '/menu').expect(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.canManage).toBe(false);
    await call('cashier', 'post', '/menu/categories').send({ name: 'Nope' }).expect(403);
    await call('cashier', 'patch', `/menu/items/${itemId}`).send({ priceMinor: 1 }).expect(403);
  });

  it('isolates tenants', async () => {
    const res = await call('bravoOwner', 'get', '/menu').expect(200);
    expect(res.body.data.items).toEqual([]);
    await call('bravoOwner', 'patch', `/menu/items/${itemId}`).send({ priceMinor: 1 }).expect(404);
    await call('bravoOwner', 'delete', `/menu/categories/${categoryId}`).expect(404);
  });

  it('refuses to delete a category that still has items, then deletes both', async () => {
    await call('owner', 'delete', `/menu/categories/${categoryId}`).expect(409);
    await call('owner', 'delete', `/menu/items/${itemId}`).expect(204);
    await call('owner', 'delete', `/menu/categories/${categoryId}`).expect(204);
    const menu = (await call('owner', 'get', '/menu').expect(200)).body.data;
    expect(menu).toMatchObject({ categories: [], items: [] });
  });

  describe('import', () => {
    const rows = [
      { category: 'Mains', name: 'Butter Chicken', priceMinor: 36000, diet: 'non_veg' },
      {
        category: 'mains',
        name: 'Dal Makhani',
        priceMinor: 28000,
        diet: 'veg',
        isAvailable: false,
      },
      {
        category: 'Drinks',
        name: 'Masala Chai',
        priceMinor: 5000,
        diet: 'veg',
        description: 'Ginger',
      },
    ];

    it('creates categories (case-insensitive) and items in one go', async () => {
      const res = await call('owner', 'post', '/menu/import').send({ rows }).expect(201);
      expect(res.body.data).toEqual({ categoriesCreated: 2, created: 3, updated: 0, skipped: 0 });
      const menu = (await call('owner', 'get', '/menu').expect(200)).body.data;
      expect(menu.categories.map((c: { name: string }) => c.name)).toEqual(['Mains', 'Drinks']);
      expect(menu.items).toHaveLength(3);
      expect(menu.items.find((i: { name: string }) => i.name === 'Dal Makhani').isAvailable).toBe(
        false,
      );
    });

    it('skips or updates existing items on re-import', async () => {
      const again = [
        { category: 'MAINS', name: 'butter chicken', priceMinor: 39000, diet: 'non_veg' },
      ];
      let res = await call('owner', 'post', '/menu/import').send({ rows: again }).expect(201);
      expect(res.body.data).toEqual({ categoriesCreated: 0, created: 0, updated: 0, skipped: 1 });
      res = await call('owner', 'post', '/menu/import')
        .send({ rows: again, onDuplicate: 'update' })
        .expect(201);
      expect(res.body.data.updated).toBe(1);
      const menu = (await call('owner', 'get', '/menu').expect(200)).body.data;
      expect(menu.items.find((i: { name: string }) => i.name === 'Butter Chicken').priceMinor).toBe(
        39000,
      );
    });

    it('rejects the whole file on a bad row or repeated item, changing nothing', async () => {
      await call('owner', 'post', '/menu/import')
        .send({
          rows: [
            { category: 'X', name: 'Ok', priceMinor: 100, diet: 'veg' },
            { category: 'X', name: 'Bad', priceMinor: -5, diet: 'veg' },
          ],
        })
        .expect(400);
      await call('owner', 'post', '/menu/import')
        .send({
          rows: [
            { category: 'X', name: 'Same', priceMinor: 100, diet: 'veg' },
            { category: 'x', name: 'same', priceMinor: 200, diet: 'veg' },
          ],
        })
        .expect(400);
      const menu = (await call('owner', 'get', '/menu').expect(200)).body.data;
      expect(menu.categories.map((c: { name: string }) => c.name)).not.toContain('X');
    });

    it('is for managers only', async () => {
      await call('cashier', 'post', '/menu/import').send({ rows }).expect(403);
    });
  });
});
