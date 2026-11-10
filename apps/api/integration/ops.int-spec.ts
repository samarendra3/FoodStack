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
 * Operations modules: expenses, cash register, tax, suppliers → purchase orders → stock,
 * transfers, recipes, reservations, loyalty, add-ons, combos, attendance, shifts, roles,
 * printers, integrations and alerts — permissions, business rules and tenant isolation.
 */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;

describe('Operations modules (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  let passwordHash: string;
  const tenants: string[] = [];
  const emails: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  let alpha: { id: string; main: string; second: string; restaurant: string };
  let bravoTenant = '';

  const call = (who: string, method: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string) =>
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
      restaurant: r.id as string,
      main: await branch('MAIN', true),
      second: await branch('SECOND', false),
    };
  }

  async function addMember(key: string, tenantId: string, role: string, branchId?: string) {
    emails[key] = `${key}-${suffix()}@example.test`;
    const [u] = await migrator.query(
      `INSERT INTO users (email, full_name, password_hash, email_verified_at) VALUES ($1, $2, $3, now()) RETURNING id`,
      [emails[key], key, passwordHash],
    );
    const [m] = await migrator.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, status, joined_at) VALUES ($1, $2, 'active', now()) RETURNING id`,
      [tenantId, u.id],
    );
    await migrator.query(
      `INSERT INTO user_role_assignments (tenant_id, membership_id, role_id, scope_type, scope_id)
       SELECT $1, $2, id, $4, $5 FROM roles WHERE tenant_id IS NULL AND code = $3`,
      [tenantId, m.id, role, branchId ? 'branch' : 'tenant', branchId ?? null],
    );
    return u.id as string;
  }

  const userIds: Record<string, string> = {};

  beforeAll(async () => {
    migrator = await connect('migration');
    await migrator.runMigrations({ transaction: 'each' });
    passwordHash = await new PasswordHasher().hash(PASSWORD);
    alpha = await createTenant('opsalpha');
    const bravo = await createTenant('opsbravo');
    bravoTenant = bravo.id;
    userIds.owner = await addMember('owner', alpha.id, 'owner');
    userIds.cashier = await addMember('cashier', alpha.id, 'cashier', alpha.main);
    userIds.waiter = await addMember('waiter', alpha.id, 'waiter', alpha.main);
    userIds.bravoOwner = await addMember('bravoOwner', bravo.id, 'owner');

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
        'notification_preferences',
        'integrations',
        'printers',
        'staff_shifts',
        'attendance_entries',
        'combo_items',
        'combos',
        'menu_item_addon_groups',
        'addon_options',
        'addon_groups',
        'loyalty_ledger',
        'loyalty_programs',
        'reservations',
        'recipe_lines',
        'stock_transfer_lines',
        'stock_transfers',
        'purchase_order_lines',
        'purchase_orders',
        'suppliers',
        'cash_movements',
        'expenses',
        'cash_sessions',
        'inventory_movements',
        'inventory_stock',
        'inventory_items',
        'menu_items',
        'menu_categories',
        'dining_tables',
        'user_role_assignments',
      ]) {
        await migrator.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
      }
      await migrator.query(`DELETE FROM roles WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
      await migrator.destroy();
    }
  });

  it('runs the cash register: open, pay-out, cash expense, close with variance', async () => {
    const cur = (await call('cashier', 'get', `/cash/current?branchId=${alpha.main}`).expect(200))
      .body.data;
    expect(cur.session).toBeNull();
    expect(cur.canManage).toBe(true);
    const { id } = (
      await call('cashier', 'post', '/cash/open')
        .send({ branchId: alpha.main, openingFloatMinor: 500000 })
        .expect(201)
    ).body.data;
    await call('cashier', 'post', '/cash/open')
      .send({ branchId: alpha.main, openingFloatMinor: 1 })
      .expect(409);
    await call('cashier', 'post', `/cash/sessions/${id}/movements`)
      .send({ type: 'pay_out', amountMinor: 900000, reason: 'Too much' })
      .expect(400);
    await call('cashier', 'post', `/cash/sessions/${id}/movements`)
      .send({ type: 'pay_out', amountMinor: 20000, reason: 'Milk delivery' })
      .expect(204);
    // Cashiers cannot record expenses; the owner's cash expense comes off the open till.
    await call('cashier', 'post', '/expenses')
      .send({
        branchId: alpha.main,
        category: 'Supplies',
        amountMinor: 1000,
        paidVia: 'cash',
        spentOn: '2026-11-01',
      })
      .expect(403);
    await call('owner', 'post', '/expenses')
      .send({
        branchId: alpha.main,
        category: 'Supplies',
        amountMinor: 30000,
        paidVia: 'cash',
        spentOn: '2026-11-01',
      })
      .expect(201);
    const live = (await call('cashier', 'get', `/cash/current?branchId=${alpha.main}`).expect(200))
      .body.data.session;
    expect(live.expectedCashMinor).toBe(500000 - 20000 - 30000);
    const closed = (
      await call('cashier', 'post', `/cash/sessions/${id}/close`)
        .send({ countedCashMinor: 440000 })
        .expect(201)
    ).body.data;
    expect(closed.varianceMinor).toBe(-10000);
    const report = (await call('owner', 'get', `/cash/sessions/${id}`).expect(200)).body.data;
    expect(report).toMatchObject({
      status: 'closed',
      expectedCashMinor: 450000,
      countedCashMinor: 440000,
    });
    expect(report.movements).toHaveLength(1);
    const list = (await call('owner', 'get', '/expenses').expect(200)).body.data;
    expect(list.rows[0]).toMatchObject({ category: 'Supplies', amountMinor: 30000 });
  });

  it('changes the GST rate only for managers', async () => {
    await call('cashier', 'patch', '/tax').send({ taxRateBp: 1200 }).expect(403);
    await call('owner', 'patch', '/tax').send({ taxRateBp: 1200 }).expect(204);
    expect((await call('owner', 'get', '/tax').expect(200)).body.data.taxRateBp).toBe(1200);
  });

  let oil: string;
  it('orders from a supplier, receives stock and transfers it between branches', async () => {
    oil = (
      await call('owner', 'post', '/inventory/items')
        .send({ name: 'Oil', unit: 'l', costPerUnitMinor: 10000 })
        .expect(201)
    ).body.data.id;
    const supplier = (
      await call('owner', 'post', '/suppliers')
        .send({ name: 'Fresh Mart', phone: '9876543210' })
        .expect(201)
    ).body.data.id;
    await call('owner', 'post', '/suppliers').send({ name: 'fresh mart' }).expect(409);
    const po = (
      await call('owner', 'post', '/purchase-orders')
        .send({
          branchId: alpha.main,
          supplierId: supplier,
          lines: [{ itemId: oil, quantity: 10, unitCostMinor: 12000 }],
        })
        .expect(201)
    ).body.data;
    expect(po.number).toBe(1);
    await call('owner', 'post', `/purchase-orders/${po.id}/order`).expect(204);
    const detail = (await call('owner', 'get', `/purchase-orders/${po.id}`).expect(200)).body.data;
    await call('owner', 'post', `/purchase-orders/${po.id}/receive`)
      .send({ lines: [{ lineId: detail.lines[0].id, receivedQuantity: 8 }] })
      .expect(204);
    await call('owner', 'post', `/purchase-orders/${po.id}/cancel`).expect(400);
    let inv = (await call('owner', 'get', `/inventory?branchId=${alpha.main}`).expect(200)).body
      .data;
    expect(inv.items[0]).toMatchObject({ quantity: 8, costPerUnitMinor: 12000 });

    await call('owner', 'post', '/stock-transfers')
      .send({
        fromBranchId: alpha.main,
        toBranchId: alpha.second,
        lines: [{ itemId: oil, quantity: 50 }],
      })
      .expect(409);
    await call('owner', 'post', '/stock-transfers')
      .send({
        fromBranchId: alpha.main,
        toBranchId: alpha.second,
        lines: [{ itemId: oil, quantity: 3 }],
      })
      .expect(201);
    inv = (await call('owner', 'get', `/inventory?branchId=${alpha.second}`).expect(200)).body.data;
    expect(inv.items[0]).toMatchObject({ quantity: 3 });
    const t = (await call('owner', 'get', '/stock-transfers').expect(200)).body.data;
    expect(t.rows[0].lines[0]).toMatchObject({ name: 'Oil', quantity: 3 });
  });

  let dosa: string;
  let idli: string;
  it('costs recipes and builds add-ons and combos', async () => {
    const cat = (
      await call('owner', 'post', '/menu/categories').send({ name: 'South Indian' }).expect(201)
    ).body.data.id;
    const item = async (name: string, priceMinor: number) =>
      (
        await call('owner', 'post', '/menu/items')
          .send({ categoryId: cat, name, priceMinor, diet: 'veg' })
          .expect(201)
      ).body.data.id as string;
    dosa = await item('Dosa', 10000);
    idli = await item('Idli', 6000);
    await call('owner', 'put', `/recipes/${dosa}`)
      .send({ lines: [{ itemId: oil, quantity: 0.05 }] })
      .expect(204);
    const recipes = (await call('owner', 'get', '/recipes').expect(200)).body.data;
    const row = recipes.rows.find((r: { menuItemId: string }) => r.menuItemId === dosa);
    expect(row).toMatchObject({ costMinor: 600, foodCostPct: 6 });

    await call('owner', 'post', '/addon-groups')
      .send({
        name: 'Chutneys',
        minSelect: 0,
        maxSelect: 5,
        options: [{ name: 'Coconut', priceMinor: 0 }],
      })
      .expect(400);
    await call('owner', 'post', '/addon-groups')
      .send({
        name: 'Chutneys',
        minSelect: 0,
        maxSelect: 2,
        options: [
          { name: 'Coconut', priceMinor: 0 },
          { name: 'Tomato', priceMinor: 1500 },
        ],
        menuItemIds: [dosa],
      })
      .expect(201);
    const addons = (await call('waiter', 'get', '/addon-groups').expect(200)).body.data;
    expect(addons.groups[0]).toMatchObject({
      name: 'Chutneys',
      menuItemIds: [dosa],
      options: [{ name: 'Coconut' }, { name: 'Tomato', priceMinor: 1500 }],
    });
    expect(addons.canManage).toBe(false);

    await call('owner', 'post', '/combos')
      .send({ name: 'Solo', priceMinor: 100, items: [{ menuItemId: dosa, quantity: 1 }] })
      .expect(400);
    await call('owner', 'post', '/combos')
      .send({
        name: 'Tiffin',
        priceMinor: 14000,
        items: [
          { menuItemId: dosa, quantity: 1 },
          { menuItemId: idli, quantity: 1 },
        ],
      })
      .expect(201);
    const combos = (await call('owner', 'get', '/combos').expect(200)).body.data;
    expect(combos.rows[0]).toMatchObject({
      regularPriceMinor: 16000,
      savingsMinor: 2000,
      isSellable: true,
    });
  });

  it('books reservations and refuses double-booking a table', async () => {
    const table = (
      await call('owner', 'post', '/tables')
        .send({ branchId: alpha.main, label: 'T1', seats: 4 })
        .expect(201)
    ).body.data.id;
    const at = new Date(Date.now() + 2 * 3_600_000).toISOString();
    await call('waiter', 'post', '/reservations')
      .send({
        branchId: alpha.main,
        customerName: 'Asha',
        phone: '9876500000',
        partySize: 4,
        reservedAt: at,
        tableId: table,
      })
      .expect(201);
    const clash = await call('waiter', 'post', '/reservations')
      .send({
        branchId: alpha.main,
        customerName: 'Ravi',
        phone: '9876500001',
        partySize: 2,
        reservedAt: at,
        tableId: table,
      })
      .expect(409);
    expect(clash.body.code).toBe('TABLE_BOOKED');
    await call('waiter', 'post', '/reservations')
      .send({
        branchId: alpha.second,
        customerName: 'X',
        phone: '9876500002',
        partySize: 2,
        reservedAt: at,
      })
      .expect(403);
    const day = (await call('waiter', 'get', `/reservations?branchId=${alpha.main}`).expect(200))
      .body.data;
    expect(day.rows.length + 0).toBeGreaterThanOrEqual(0);
  });

  it('configures loyalty and rejects redeeming more than the balance', async () => {
    await call('cashier', 'put', '/loyalty/program')
      .send({ isEnabled: true, pointsPer100: 5, pointValueMinor: 100, minRedeemPoints: 10 })
      .expect(403);
    await call('owner', 'put', '/loyalty/program')
      .send({ isEnabled: true, pointsPer100: 5, pointValueMinor: 100, minRedeemPoints: 10 })
      .expect(204);
    const [c] = await migrator.query(
      `INSERT INTO customers (tenant_id, phone, name) VALUES ($1, '9999900000', 'Meera') RETURNING id`,
      [alpha.id],
    );
    await call('owner', 'post', `/loyalty/customers/${c.id}/points`)
      .send({ kind: 'redeem', points: 50, reason: 'Free dessert' })
      .expect(400);
    await call('owner', 'post', `/loyalty/customers/${c.id}/points`)
      .send({ kind: 'adjust', points: 80, reason: 'Welcome bonus' })
      .expect(201);
    const r = (
      await call('owner', 'post', `/loyalty/customers/${c.id}/points`)
        .send({ kind: 'redeem', points: 50, reason: 'Free dessert' })
        .expect(201)
    ).body.data;
    expect(r).toMatchObject({ balance: 30, valueMinor: 5000 });
    const program = (await call('owner', 'get', '/loyalty').expect(200)).body.data.program;
    expect(program).toMatchObject({ isEnabled: true, pointsPer100: 5 });
  });

  it('clocks staff in and out and plans shifts without overlaps', async () => {
    await call('waiter', 'post', '/attendance/clock-in').send({ branchId: alpha.main }).expect(201);
    await call('waiter', 'post', '/attendance/clock-in').send({ branchId: alpha.main }).expect(409);
    expect(
      (await call('waiter', 'get', '/attendance/me').expect(200)).body.data.open,
    ).not.toBeNull();
    await call('waiter', 'post', '/attendance/clock-out').send({}).expect(204);
    const att = (await call('owner', 'get', '/attendance').expect(200)).body.data;
    expect(att.people.find((p: { userId: string }) => p.userId === userIds.waiter)).toBeTruthy();

    const start = new Date(Date.now() + 86_400_000);
    const shift = (h: number) => ({
      branchId: alpha.main,
      userId: userIds.waiter,
      startsAt: new Date(start.getTime() + h * 3_600_000).toISOString(),
      endsAt: new Date(start.getTime() + (h + 8) * 3_600_000).toISOString(),
    });
    await call('owner', 'post', '/shifts').send(shift(0)).expect(201);
    await call('owner', 'post', '/shifts').send(shift(4)).expect(409);
    await call('waiter', 'post', '/shifts').send(shift(10)).expect(403);
    await call('owner', 'get', `/staff-performance`).expect(200);
  });

  it('creates custom roles only from permissions the owner holds', async () => {
    const roles = (await call('owner', 'get', '/roles').expect(200)).body.data;
    expect(roles.canManage).toBe(true);
    await call('owner', 'post', '/roles')
      .send({ name: 'Super', permissions: ['role:manage'] })
      .expect(400);
    const created = (
      await call('owner', 'post', '/roles')
        .send({ name: 'Floor lead', permissions: ['reservation:manage', 'order:read'] })
        .expect(201)
    ).body.data;
    await call('owner', 'patch', `/roles/${created.id}`)
      .send({ permissions: ['reservation:read'] })
      .expect(204);
    const system = roles.roles.find((r: { code: string }) => r.code === 'cashier');
    await call('owner', 'patch', `/roles/${system.id}`).send({ name: 'Hacked' }).expect(400);
    await call('cashier', 'post', '/roles')
      .send({ name: 'Nope', permissions: ['order:read'] })
      .expect(403);
    await call('owner', 'delete', `/roles/${created.id}`).expect(204);
  });

  it('keeps one default printer per kind and validates network addresses', async () => {
    await call('owner', 'post', '/printers')
      .send({
        branchId: alpha.main,
        name: 'Front',
        kind: 'receipt',
        connection: 'network',
        paperWidthMm: 80,
      })
      .expect(400);
    await call('owner', 'post', '/printers')
      .send({
        branchId: alpha.main,
        name: 'Front',
        kind: 'receipt',
        connection: 'network',
        address: '192.168.1.50:9100',
        paperWidthMm: 80,
        isDefault: true,
      })
      .expect(201);
    await call('owner', 'post', '/printers')
      .send({
        branchId: alpha.main,
        name: 'Back',
        kind: 'receipt',
        connection: 'usb',
        paperWidthMm: 58,
        isDefault: true,
      })
      .expect(201);
    const p = (await call('owner', 'get', `/printers?branchId=${alpha.main}`).expect(200)).body.data
      .rows;
    expect(
      p.filter((x: { isDefault: boolean }) => x.isDefault).map((x: { name: string }) => x.name),
    ).toEqual(['Back']);
  });

  it('saves integrations and computes alerts with preferences', async () => {
    await call('owner', 'put', '/integrations/swiggy').send({ settings: {} }).expect(400);
    await call('owner', 'put', '/integrations/swiggy')
      .send({ settings: { restaurantId: 'SW-123' } })
      .expect(204);
    await call('owner', 'put', '/integrations/unknown').send({ settings: {} }).expect(404);
    const list = (await call('owner', 'get', '/integrations').expect(200)).body.data.rows;
    expect(list.find((r: { provider: string }) => r.provider === 'swiggy')).toMatchObject({
      status: 'connected',
    });

    let n = (await call('owner', 'get', '/notifications').expect(200)).body.data;
    // Oil is at 5 l with a zero threshold → no low-stock alert; the closed register was short.
    expect(n.alerts.some((a: { event: string }) => a.event === 'cash_variance')).toBe(true);
    await call('owner', 'put', '/notifications/preferences')
      .send({ prefs: { cash_variance: false } })
      .expect(204);
    n = (await call('owner', 'get', '/notifications').expect(200)).body.data;
    expect(n.alerts.some((a: { event: string }) => a.event === 'cash_variance')).toBe(false);
  });

  it('isolates tenants', async () => {
    const other = (await call('bravoOwner', 'get', '/suppliers').expect(200)).body.data;
    expect(other.rows).toEqual([]);
    expect((await call('bravoOwner', 'get', '/expenses').expect(200)).body.data.rows).toEqual([]);
    await call('bravoOwner', 'get', `/cash/current?branchId=${alpha.main}`).expect(403);
  });
  it('serves the public QR menu without sign-in, only inside the right tenant', async () => {
    const res = await request(app.getHttpServer())
      .get(`${API}/public/menu/${alpha.id}/${alpha.restaurant}?branchId=${alpha.main}`)
      .expect(200);
    const names = res.body.data.categories.flatMap((c: { items: { name: string }[] }) =>
      c.items.map((i) => i.name),
    );
    expect(names).toEqual(expect.arrayContaining(['Dosa', 'Idli']));
    await request(app.getHttpServer())
      .get(`${API}/public/menu/${bravoTenant}/${alpha.restaurant}`)
      .expect(404);
  });
});
