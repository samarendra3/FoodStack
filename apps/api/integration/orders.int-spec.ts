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
 * Orders: server pricing (portions, offers, coupon, tax), idempotent placement, numbering,
 * split and concurrent payments, voids with re-pricing, cancellation, refunds, kitchen flow,
 * permissions and tenant isolation.
 */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;

describe('Orders (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  const tenants: string[] = [];
  const emails: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  let main: string;
  let second: string;
  let bravoMain: string;
  let tikka: string;
  let full: string;
  let half: string;
  let chai: string;

  const call = (who: string, method: 'get' | 'post' | 'patch', url: string) =>
    request(app.getHttpServer())
      [method](`${API}${url}`)
      .set('X-Forwarded-For', freshIp())
      .set('Authorization', `Bearer ${tokens[who]}`);

  async function tenant(label: string) {
    const [t] = await migrator.query(
      `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
      [`${label}-${suffix()}`, label],
    );
    tenants.push(t.id);
    const [r] = await migrator.query(
      `INSERT INTO restaurants (tenant_id, name, slug, currency_code, country_code, timezone)
       VALUES ($1, $2, $3, 'INR', 'IN', 'Asia/Kolkata') RETURNING id`,
      [t.id, label, `${label}-${suffix()}`],
    );
    const branch = async (code: string) =>
      (
        await migrator.query(
          `INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone, is_default)
           VALUES ($1, $2, $3, $4, 'Asia/Kolkata', $5) RETURNING id`,
          [t.id, r.id, code, `${code} branch`, code === 'MAIN'],
        )
      )[0].id as string;
    return { id: t.id as string, main: await branch('MAIN'), second: await branch('SECOND') };
  }

  async function member(
    key: string,
    tenantId: string,
    role: string,
    hash: string,
    branchId?: string,
  ) {
    emails[key] = `${key}-${suffix()}@example.test`;
    const [u] = await migrator.query(
      `INSERT INTO users (email, full_name, password_hash, email_verified_at)
       VALUES ($1, $2, $3, now()) RETURNING id`,
      [emails[key], key, hash],
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
    const hash = await new PasswordHasher().hash(PASSWORD);
    const alpha = await tenant('ordalpha');
    const bravo = await tenant('ordbravo');
    main = alpha.main;
    second = alpha.second;
    bravoMain = bravo.main;
    await member('owner', alpha.id, 'owner', hash);
    await member('manager', alpha.id, 'branch_manager', hash, alpha.main);
    await member('cashier', alpha.id, 'cashier', hash, alpha.main);
    await member('cook', alpha.id, 'kitchen_staff', hash, alpha.main);
    await member('bravoOwner', bravo.id, 'owner', hash);

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

    // Menu: Paneer Tikka Full ₹300 / Half ₹180 (via import half price), Chai ₹50.
    await call('owner', 'post', '/menu/import')
      .send({
        rows: [
          {
            category: 'Starters',
            name: 'Paneer Tikka',
            priceMinor: 30000,
            halfPriceMinor: 18000,
            diet: 'veg',
          },
          { category: 'Drinks', name: 'Chai', priceMinor: 5000, diet: 'veg' },
        ],
      })
      .expect(201);
    const menu = (await call('owner', 'get', '/menu').expect(200)).body.data;
    const t = menu.items.find((i: { name: string }) => i.name === 'Paneer Tikka');
    tikka = t.id;
    full = t.variants.find((v: { name: string }) => v.name === 'Full').id;
    half = t.variants.find((v: { name: string }) => v.name === 'Half').id;
    chai = menu.items.find((i: { name: string }) => i.name === 'Chai').id;
    await call('owner', 'post', '/promotions')
      .send({ name: 'Chai 20%', type: 'percentage', scope: 'items', itemIds: [chai], value: 2000 })
      .expect(201);
    await call('owner', 'post', '/promotions')
      .send({
        name: 'Flat 50',
        type: 'fixed_amount',
        value: 5000,
        couponCode: 'FLAT50',
        stackable: true,
      })
      .expect(201);
  });

  afterAll(async () => {
    await app?.close();
    if (migrator?.isInitialized) {
      for (const table of [
        'refunds',
        'payments',
        'order_discounts',
        'order_items',
        'invoices',
        'invoice_series',
        'orders',
        'branch_order_counters',
        'customers',
        'promotion_items',
        'promotion_categories',
        'promotion_branches',
        'promotions',
        'menu_item_variants',
        'menu_items',
        'menu_categories',
        'user_role_assignments',
      ]) {
        await migrator.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
      }
      await migrator.destroy();
    }
  });

  const place = (who: string, body: object = {}, key?: string) => {
    const req = call(who, 'post', '/orders').send({
      branchId: main,
      channel: 'dine_in',
      tableLabel: 'T4',
      lines: [
        { menuItemId: tikka, variantId: half, quantity: 2 },
        { menuItemId: chai, quantity: 2, note: 'less sugar' },
      ],
      ...body,
    });
    return key ? req.set('Idempotency-Key', key) : req;
  };

  let order: { id: string; totalMinor: number; items: { id: string; name: string }[] };

  it('prices portions, offers, coupon and tax on the server', async () => {
    const res = await place('cashier', {
      couponCode: 'flat50',
      customer: { phone: '98765 43210', name: 'Asha' },
    }).expect(201);
    order = res.body.data;
    // 2×180 + 2×50 = 460. The stackable coupon (50) combines only with stackable offers, so the
    // non-stackable "Chai 20%" is left out → discount 50; net 410; GST 5% = 20.50.
    expect(res.body.data).toMatchObject({
      orderNumber: 1,
      status: 'open',
      kitchenStatus: 'new',
      subtotalMinor: 46000,
      discountMinor: 5000,
      taxMinor: 2050,
      totalMinor: 43050,
      dueMinor: 43050,
      couponCode: 'FLAT50',
      customer: { name: 'Asha', phone: '9876543210' },
    });
    expect(res.body.data.items[0]).toMatchObject({
      name: 'Paneer Tikka',
      variantName: 'Half',
      unitPriceMinor: 18000,
    });
    expect(res.body.data.discounts.map((d: { name: string }) => d.name)).toEqual(['Flat 50']);
  });

  it('requires a portion for items that have them and rejects invalid coupons', async () => {
    await place('cashier', { lines: [{ menuItemId: tikka, quantity: 1 }] }).expect(400);
    await place('cashier', { lines: [{ menuItemId: chai, variantId: full, quantity: 1 }] }).expect(
      400,
    );
    await place('cashier', { couponCode: 'NOPE' }).expect(400);
  });

  it('is idempotent and numbers orders per branch', async () => {
    const key = `retry-${suffix()}`;
    const a = (await place('cashier', {}, key).expect(201)).body.data;
    const b = (await place('cashier', {}, key).expect(201)).body.data;
    expect(b.id).toBe(a.id);
    expect(a.orderNumber).toBe(2);
    const other = (await place('owner', { branchId: second }).expect(201)).body.data;
    expect(other.orderNumber).toBe(1);
  });

  it('takes split payments, refuses overpayment and completes when paid', async () => {
    await call('cashier', 'post', `/orders/${order.id}/payments`)
      .send({ method: 'card', amountMinor: 50000 })
      .expect(400);
    let o = (
      await call('cashier', 'post', `/orders/${order.id}/payments`)
        .send({ method: 'cash', amountMinor: 20000 })
        .expect(201)
    ).body.data;
    expect(o).toMatchObject({ status: 'open', paidMinor: 20000, dueMinor: 23050 });
    o = (
      await call('cashier', 'post', `/orders/${order.id}/payments`)
        .send({ method: 'upi', amountMinor: 23050, reference: 'UPI123' })
        .expect(201)
    ).body.data;
    expect(o).toMatchObject({ status: 'completed', paidMinor: 43050, dueMinor: 0 });
    expect(o.completedAt).not.toBeNull();
    await call('cashier', 'post', `/orders/${order.id}/payments`)
      .send({ method: 'cash', amountMinor: 1 })
      .expect(409);
  });

  it('serializes concurrent payments so the bill is never overpaid', async () => {
    const o = (
      await place('cashier', {
        couponCode: null,
        lines: [{ menuItemId: chai, quantity: 2 }],
      }).expect(201)
    ).body.data;
    // 100 - 20 = 80, tax 4 → 84
    expect(o.totalMinor).toBe(8400);
    const pay = () =>
      call('cashier', 'post', `/orders/${o.id}/payments`).send({
        method: 'cash',
        amountMinor: 8400,
      });
    const results = await Promise.all([pay(), pay(), pay()]);
    // The first payment closes the bill; the others find it already completed.
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const after = (await call('owner', 'get', `/orders/${o.id}`).expect(200)).body.data;
    expect(after).toMatchObject({ paidMinor: 8400, status: 'completed' });
  });

  it('voids an item and re-prices; the last item cannot be voided', async () => {
    const o = (await place('cashier').expect(201)).body.data;
    const chaiLine = o.items.find((i: { name: string }) => i.name === 'Chai');
    await call('cashier', 'post', `/orders/${o.id}/items/${chaiLine.id}/void`)
      .send({ reason: 'x' })
      .expect(403);
    const v = (
      await call('manager', 'post', `/orders/${o.id}/items/${chaiLine.id}/void`)
        .send({ reason: 'Guest changed mind' })
        .expect(200)
    ).body.data;
    // 2×180 = 360, no offers left; GST 18 → 378
    expect(v).toMatchObject({
      subtotalMinor: 36000,
      discountMinor: 0,
      taxMinor: 1800,
      totalMinor: 37800,
    });
    expect(v.discounts).toEqual([]);
    const tikkaLine = v.items.find((i: { name: string }) => i.name === 'Paneer Tikka');
    await call('manager', 'post', `/orders/${o.id}/items/${tikkaLine.id}/void`)
      .send({ reason: 'x' })
      .expect(409);
  });

  it('cancels only unpaid orders', async () => {
    const o = (await place('cashier').expect(201)).body.data;
    await call('cashier', 'post', `/orders/${o.id}/cancel`).send({ reason: 'x' }).expect(403);
    await call('cashier', 'post', `/orders/${o.id}/payments`)
      .send({ method: 'cash', amountMinor: 1000 })
      .expect(201);
    await call('manager', 'post', `/orders/${o.id}/cancel`)
      .send({ reason: 'Walked out' })
      .expect(409);
    const fresh = (await place('cashier').expect(201)).body.data;
    const c = (
      await call('manager', 'post', `/orders/${fresh.id}/cancel`)
        .send({ reason: 'Walked out' })
        .expect(200)
    ).body.data;
    expect(c).toMatchObject({ status: 'cancelled', cancelReason: 'Walked out' });
  });

  it('refunds within the payment amount, by managers only', async () => {
    const o = (await call('owner', 'get', `/orders/${order.id}`).expect(200)).body.data;
    const upi = o.payments.find((p: { method: string }) => p.method === 'upi');
    await call('cashier', 'post', `/payments/${upi.id}/refunds`)
      .send({ amountMinor: 100, reason: 'x' })
      .expect(403);
    await call('manager', 'post', `/payments/${upi.id}/refunds`)
      .send({ amountMinor: 30000, reason: 'Too much' })
      .expect(400);
    const r = (
      await call('manager', 'post', `/payments/${upi.id}/refunds`)
        .send({ amountMinor: 5000, reason: 'Cold food' })
        .expect(201)
    ).body.data;
    expect(r).toMatchObject({ status: 'completed', refundedMinor: 5000, paidMinor: 43050 });
    expect(r.refunds[0]).toMatchObject({ amountMinor: 5000, reason: 'Cold food' });
  });

  it('moves kitchen tickets forward one step at a time', async () => {
    const tickets = (await call('cook', 'get', `/kitchen/tickets?branchId=${main}`).expect(200))
      .body.data;
    const t = tickets.find((x: { id: string }) => x.id === order.id);
    expect(t).toMatchObject({ status: 'new', tableLabel: 'T4', customerName: 'Asha' });
    expect(t.items.map((i: { name: string }) => i.name)).toContain('Paneer Tikka (Half)');
    await call('cook', 'post', `/kitchen/tickets/${order.id}/status`)
      .send({ to: 'ready' })
      .expect(409);
    // The manual Accept step is retired: NEW → PREPARING → READY → SERVED.
    await call('cook', 'post', `/kitchen/tickets/${order.id}/status`)
      .send({ to: 'accepted' })
      .expect(409);
    for (const to of ['preparing', 'ready', 'served']) {
      await call('cook', 'post', `/kitchen/tickets/${order.id}/status`).send({ to }).expect(200);
    }
    expect(tickets.some((x: { status: string }) => x.status === 'cancelled')).toBe(false);
    await call('cashier', 'get', `/kitchen/tickets?branchId=${main}`).expect(403);
  });

  it('keeps branch staff to their branch and tenants apart', async () => {
    await place('cashier', { branchId: second }).expect(403);
    await call('cook', 'get', `/kitchen/tickets?branchId=${second}`).expect(403);
    await call('bravoOwner', 'get', `/orders/${order.id}`).expect(404);
    await call('bravoOwner', 'post', `/orders/${order.id}/payments`)
      .send({ method: 'cash', amountMinor: 1 })
      .expect(404);
    await call('bravoOwner', 'post', '/orders')
      .send({ branchId: main, channel: 'dine_in', lines: [{ menuItemId: chai, quantity: 1 }] })
      .expect(403);
    await call('bravoOwner', 'post', '/orders')
      .send({ branchId: bravoMain, channel: 'dine_in', lines: [{ menuItemId: chai, quantity: 1 }] })
      .expect(400);
  });

  // ---- Phase 4: item-level kitchen status, one workflow ----

  describe('item-level kitchen status', () => {
    const ticket = async (id: string) =>
      (
        (await call('cook', 'get', `/kitchen/tickets?branchId=${main}`).expect(200)).body.data as {
          id: string;
          status: string;
          items: { id: string; name: string; kitchenStatus: string }[];
        }[]
      ).find((t) => t.id === id)!;
    const itemTo = (orderId: string, itemId: string, to: string) =>
      call('cook', 'post', `/kitchen/tickets/${orderId}/items/${itemId}/status`).send({ to });
    const threeLines = async () =>
      (
        await place('cashier', {
          tableLabel: 'K1',
          lines: [
            { menuItemId: tikka, variantId: half, quantity: 1 },
            { menuItemId: chai, quantity: 1 },
            { menuItemId: tikka, variantId: full, quantity: 1, note: 'extra spicy' },
          ],
        }).expect(201)
      ).body.data as { id: string; items: { id: string; name: string }[] };

    it('starts every order NEW with pending dishes; starting a dish starts the order', async () => {
      const o = await threeLines();
      let t = await ticket(o.id);
      expect(t.status).toBe('new');
      expect(t.items.map((i) => i.kitchenStatus)).toEqual(['pending', 'pending', 'pending']);

      await itemTo(o.id, o.items[1]!.id, 'preparing').expect(200);
      t = await ticket(o.id);
      expect(t.status).toBe('preparing');
      expect(t.items.map((i) => i.kitchenStatus)).toEqual(['pending', 'preparing', 'pending']);
    });

    it('marks the order READY only when every dish is ready', async () => {
      const o = await threeLines();
      const [a, b, c] = o.items;
      await itemTo(o.id, a!.id, 'ready').expect(200); // pending → ready is allowed
      await itemTo(o.id, b!.id, 'preparing').expect(200);
      await itemTo(o.id, b!.id, 'ready').expect(200);
      expect((await ticket(o.id)).status).toBe('preparing');
      await itemTo(o.id, b!.id, 'ready').expect(409); // already ready
      const last = (await itemTo(o.id, c!.id, 'ready').expect(200)).body.data;
      expect(last.status).toBe('ready');
      expect((await ticket(o.id)).items.every((i) => i.kitchenStatus === 'ready')).toBe(true);

      const types = (
        (await call('owner', 'get', `/orders/${o.id}/timeline`).expect(200)).body.data as {
          type: string;
        }[]
      ).map((e) => e.type);
      expect(types.filter((t) => t === 'order.item_status')).toHaveLength(4);
      expect(types.filter((t) => t === 'order.ready')).toHaveLength(1);
      // A ready order no longer takes dish updates.
      await itemTo(o.id, a!.id, 'ready').expect(409);
    });

    it('order-level buttons still move every dish', async () => {
      const o = await threeLines();
      await call('cook', 'post', `/kitchen/tickets/${o.id}/status`)
        .send({ to: 'preparing' })
        .expect(200);
      expect((await ticket(o.id)).items.map((i) => i.kitchenStatus)).toEqual([
        'preparing',
        'preparing',
        'preparing',
      ]);
      await call('cook', 'post', `/kitchen/tickets/${o.id}/status`)
        .send({ to: 'ready' })
        .expect(200);
      expect((await ticket(o.id)).items.every((i) => i.kitchenStatus === 'ready')).toBe(true);
    });

    it('voiding the last unfinished dish makes the order ready', async () => {
      const o = await threeLines();
      await itemTo(o.id, o.items[0]!.id, 'ready').expect(200);
      await itemTo(o.id, o.items[1]!.id, 'ready').expect(200);
      await call('manager', 'post', `/orders/${o.id}/items/${o.items[2]!.id}/void`)
        .send({ reason: 'Out of stock' })
        .expect(200);
      expect((await ticket(o.id)).status).toBe('ready');
    });

    it('keeps dish updates to the branch kitchen', async () => {
      const o = await threeLines();
      await call('cashier', 'post', `/kitchen/tickets/${o.id}/items/${o.items[0]!.id}/status`)
        .send({ to: 'ready' })
        .expect(403);
      const other = await call(
        'bravoOwner',
        'post',
        `/kitchen/tickets/${o.id}/items/${o.items[0]!.id}/status`,
      ).send({
        to: 'ready',
      });
      expect([403, 404]).toContain(other.status);
    });
  });
});
