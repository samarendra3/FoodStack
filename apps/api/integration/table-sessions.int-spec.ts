import { randomBytes, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PasswordHasher } from '../src/core/security/password-hasher';
import { connect } from './helpers';

/**
 * QR guests and table sessions: incremental orders by one guest, many guests at once, guest-wise
 * and whole-table payment, ordering after paying, re-scans, expiry and recovery, idempotency,
 * closed sittings and cross-tenant attempts.
 */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;

describe('QR guests and table sessions (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  const tenants: string[] = [];
  const emails: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  let alpha: { id: string; main: string };
  let bravo: { id: string; main: string };
  let table1 = '';
  let table2 = '';
  let bravoTable = '';
  const item: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const staff = (who: string, method: 'get' | 'post' | 'put', url: string) =>
    http()
      [method](`${API}${url}`)
      .set('X-Forwarded-For', freshIp())
      .set('Authorization', `Bearer ${tokens[who]}`);
  /** Table QR keys (the `?k=` of each printed code), loaded after the tables are created. */
  const qrKeys: Record<string, string> = {};
  const join = (tenantId: string, tableId: string, token?: string, name?: string) => {
    const r = http().post(`${API}/public/guest/join`).set('X-Forwarded-For', freshIp());
    if (token) r.set('X-Guest-Token', token);
    const key = qrKeys[tableId];
    return r.send({ tenantId, tableId, ...(key ? { key } : {}), ...(name ? { name } : {}) });
  };
  const me = (token: string) =>
    http().get(`${API}/public/guest`).set('X-Forwarded-For', freshIp()).set('X-Guest-Token', token);
  const order = (token: string, name: string, qty = 1, key = randomUUID()) =>
    http()
      .post(`${API}/public/guest/orders`)
      .set('X-Forwarded-For', freshIp())
      .set('X-Guest-Token', token)
      .set('Idempotency-Key', key)
      .send({ lines: [{ menuItemId: item[name], quantity: qty }] });

  async function tenant(label: string) {
    const [t] = await migrator.query(
      `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
      [`${label}-${suffix()}`, label],
    );
    tenants.push(t.id);
    const [r] = await migrator.query(
      `INSERT INTO restaurants (tenant_id, name, slug, currency_code, country_code, timezone, tax_rate_bp)
       VALUES ($1, $2, $3, 'INR', 'IN', 'Asia/Kolkata', 0) RETURNING id`,
      [t.id, label, `${label}-${suffix()}`],
    );
    const [b] = await migrator.query(
      `INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone, is_default)
       VALUES ($1, $2, 'MAIN', 'Main', 'Asia/Kolkata', true) RETURNING id`,
      [t.id, r.id],
    );
    return { id: t.id as string, main: b.id as string };
  }
  async function member(key: string, tenantId: string, role: string, hash: string) {
    emails[key] = `${key}-${suffix()}@example.test`;
    const [u] = await migrator.query(
      `INSERT INTO users (email, full_name, password_hash, email_verified_at) VALUES ($1, $2, $3, now()) RETURNING id`,
      [emails[key], key, hash],
    );
    const [m] = await migrator.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, status, joined_at) VALUES ($1, $2, 'active', now()) RETURNING id`,
      [tenantId, u.id],
    );
    await migrator.query(
      `INSERT INTO user_role_assignments (tenant_id, membership_id, role_id, scope_type)
       SELECT $1, $2, id, 'tenant' FROM roles WHERE tenant_id IS NULL AND code = $3`,
      [tenantId, m.id, role],
    );
  }

  beforeAll(async () => {
    migrator = await connect('migration');
    await migrator.runMigrations({ transaction: 'each' });
    const hash = await new PasswordHasher().hash(PASSWORD);
    alpha = await tenant('qralpha');
    bravo = await tenant('qrbravo');
    await member('owner', alpha.id, 'owner', hash);
    await member('bravoOwner', bravo.id, 'owner', hash);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app);
    await app.init();
    for (const who of Object.keys(emails)) {
      tokens[who] = (
        await http()
          .post(`${API}/auth/login`)
          .set('X-Forwarded-For', freshIp())
          .send({ email: emails[who], password: PASSWORD })
          .expect(200)
      ).body.data.accessToken;
    }
    await staff('owner', 'post', '/menu/import')
      .send({
        rows: [
          { category: 'Mains', name: 'Thali', priceMinor: 35000, diet: 'veg' },
          { category: 'Mains', name: 'Dosa', priceMinor: 10000, diet: 'veg' },
          { category: 'Drinks', name: 'Lassi', priceMinor: 6000, diet: 'veg' },
        ],
      })
      .expect(201);
    const menu = (await staff('owner', 'get', '/menu').expect(200)).body.data;
    for (const i of menu.items as { id: string; name: string }[]) item[i.name] = i.id;
    table1 = (
      await staff('owner', 'post', '/tables')
        .send({ branchId: alpha.main, label: 'T01' })
        .expect(201)
    ).body.data.id;
    table2 = (
      await staff('owner', 'post', '/tables')
        .send({ branchId: alpha.main, label: 'T02' })
        .expect(201)
    ).body.data.id;
    bravoTable = (
      await staff('bravoOwner', 'post', '/tables')
        .send({ branchId: bravo.main, label: 'B1' })
        .expect(201)
    ).body.data.id;
    for (const r of (await migrator.query(
      `SELECT id, qr_key FROM dining_tables WHERE id = ANY($1::uuid[])`,
      [[table1, table2, bravoTable]],
    )) as { id: string; qr_key: string }[])
      qrKeys[r.id] = r.qr_key;
  });

  afterAll(async () => {
    await app?.close();
    if (migrator?.isInitialized) {
      for (const t of [
        'refunds',
        'payments',
        'order_discounts',
        'order_items',
        'invoices',
        'invoice_series',
        'orders',
        'table_guests',
        'table_sessions',
        'dining_tables',
        'user_role_assignments',
      ]) {
        await migrator
          .query(`DELETE FROM ${t} WHERE tenant_id = ANY($1::uuid[])`, [tenants])
          .catch(() => undefined);
      }
      await migrator.destroy();
    }
  });

  let guestA = '';
  let sessionId = '';

  it('keeps one guest and one sitting across incremental orders (₹350 + ₹100 + ₹60 = ₹510)', async () => {
    const j = (await join(alpha.id, table1, undefined, 'Asha').expect(200)).body.data;
    guestA = j.token;
    sessionId = j.session.id;
    expect(j.restored).toBe(false);
    const o1 = (await order(guestA, 'Thali').expect(201)).body.data.order;
    const o2 = (await order(guestA, 'Dosa').expect(201)).body.data.order;
    const r3 = (await order(guestA, 'Lassi').expect(201)).body.data;
    const numbers = [o1.orderNumber, o2.orderNumber, r3.order.orderNumber];
    expect(new Set(numbers).size).toBe(3);
    expect(r3.session.id).toBe(sessionId);
    expect(r3.guest).toMatchObject({
      name: 'Asha',
      totalMinor: 51000,
      paidMinor: 0,
      outstandingMinor: 51000,
    });
    expect(r3.guest.orders).toHaveLength(3);
    // Each order is its own kitchen ticket, labelled with the guest.
    const kds = (await staff('owner', 'get', `/kitchen/tickets?branchId=${alpha.main}`).expect(200))
      .body.data;
    const mine = kds.filter((t: { id: string }) => [o1.id, o2.id, r3.order.id].includes(t.id));
    expect(mine).toHaveLength(3);
    expect(
      mine.every(
        (t: { billLabel: string; tableLabel: string }) =>
          t.billLabel === 'Asha' && t.tableLabel === 'T01',
      ),
    ).toBe(true);
    const rows = await migrator.query(
      `SELECT count(*)::int AS n FROM table_guests WHERE session_id = $1`,
      [sessionId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('handles five consecutive orders and repeated scans on the same device', async () => {
    const again = (await join(alpha.id, table1, guestA).expect(200)).body.data;
    expect(again).toMatchObject({ restored: true, token: guestA });
    expect(again.guest.orders).toHaveLength(3);
    await order(guestA, 'Lassi').expect(201);
    await order(guestA, 'Lassi').expect(201);
    const v = (await me(guestA).expect(200)).body.data;
    expect(v.guest.orders).toHaveLength(5);
    expect(v.guest.outstandingMinor).toBe(51000 + 12000);
  });

  it('rejects a duplicate submission (same Idempotency-Key) and requires a key', async () => {
    const key = randomUUID();
    const [a, b] = await Promise.all([
      order(guestA, 'Dosa', 1, key),
      order(guestA, 'Dosa', 1, key),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.data.order.id).toBe(b.body.data.order.id);
    await http()
      .post(`${API}/public/guest/orders`)
      .set('X-Guest-Token', guestA)
      .send({ lines: [{ menuItemId: item.Dosa, quantity: 1 }] })
      .expect(400);
  });

  let guestB = '';
  it('lets several guests order at the same time without mixing bills or numbers', async () => {
    guestB = (await join(alpha.id, table1).expect(200)).body.data.token;
    const guestC = (await join(alpha.id, table1).expect(200)).body.data.token;
    const results = await Promise.all([
      ...Array.from({ length: 4 }, () => order(guestB, 'Dosa')),
      ...Array.from({ length: 4 }, () => order(guestC, 'Lassi')),
    ]);
    expect(results.every((r) => r.status === 201)).toBe(true);
    const nums = results.map((r) => r.body.data.order.orderNumber);
    expect(new Set(nums).size).toBe(8);
    const s = (await staff('owner', 'get', `/table-sessions?tableId=${table1}`).expect(200)).body
      .data;
    expect(s.session.id).toBe(sessionId);
    const byName = Object.fromEntries(s.guests.map((g: { name: string }) => [g.name, g]));
    expect(byName['Guest 2'].outstandingMinor).toBe(40000);
    expect(byName['Guest 3'].outstandingMinor).toBe(24000);
    expect(s.totals.outstandingMinor).toBe(63000 + 10000 + 40000 + 24000);
  });

  it('lets Guest A pay while Guest B keeps ordering, never touching paid bills', async () => {
    const s0 = (await staff('owner', 'get', `/table-sessions?tableId=${table1}`).expect(200)).body
      .data;
    const a = s0.guests.find((g: { name: string }) => g.name === 'Asha');
    const [pay, more] = await Promise.all([
      staff('owner', 'post', `/table-sessions/${sessionId}/payments`).send({
        guestId: a.id,
        method: 'upi',
        amountMinor: a.outstandingMinor,
      }),
      order(guestB, 'Lassi'),
    ]);
    expect(pay.status).toBe(201);
    expect(more.status).toBe(201);
    const paid = pay.body.data.guests.find((g: { id: string }) => g.id === a.id);
    expect(paid).toMatchObject({ outstandingMinor: 0, paidMinor: a.totalMinor });
    expect(paid.orders.every((o: { status: string }) => o.status === 'completed')).toBe(true);
    const b = pay.body.data.guests.find((g: { name: string }) => g.name === 'Guest 2');
    expect(b.payments).toHaveLength(0);
    // Overpaying and paying a settled guest are refused.
    await staff('owner', 'post', `/table-sessions/${sessionId}/payments`)
      .send({ guestId: a.id, method: 'cash', amountMinor: 100 })
      .expect(409);
  });

  it('starts a new outstanding bill when Guest A orders after paying', async () => {
    const before = (await me(guestA).expect(200)).body.data.guest;
    const paidOrders = before.orders.map(
      (o: { id: string; totalMinor: number; paidMinor: number }) => ({ ...o }),
    );
    const r = (await order(guestA, 'Lassi').expect(201)).body.data;
    expect(r.guest.outstandingMinor).toBe(6000);
    expect(r.guest.paidMinor).toBe(before.paidMinor);
    for (const p of paidOrders) {
      expect(r.guest.orders.find((o: { id: string }) => o.id === p.id)).toMatchObject({
        status: 'completed',
        totalMinor: p.totalMinor,
        paidMinor: p.paidMinor,
      });
    }
  });

  it('refuses to close with open bills, then closes; the closed sitting rejects orders and a re-scan starts fresh', async () => {
    await staff('owner', 'post', `/table-sessions/${sessionId}/close`).expect(409);
    // Whole-table settlement (combined bill), paid in two parts.
    const s = (await staff('owner', 'get', `/table-sessions?sessionId=${sessionId}`).expect(200))
      .body.data;
    const due = s.totals.outstandingMinor;
    await staff('owner', 'post', `/table-sessions/${sessionId}/payments`)
      .send({ method: 'cash', amountMinor: 1000 })
      .expect(201);
    const done = (
      await staff('owner', 'post', `/table-sessions/${sessionId}/payments`)
        .send({ method: 'card', amountMinor: due - 1000 })
        .expect(201)
    ).body.data;
    expect(done.totals.outstandingMinor).toBe(0);
    await staff('owner', 'post', `/table-sessions/${sessionId}/close`).expect(204);

    const closed = await order(guestA, 'Dosa').expect(409);
    expect(closed.body.code).toBe('SESSION_CLOSED');
    const fresh = (await join(alpha.id, table1, guestA).expect(200)).body.data;
    expect(fresh.restored).toBe(false);
    expect(fresh.token).not.toBe(guestA);
    expect(fresh.session.id).not.toBe(sessionId);
    expect(fresh.guest.orders).toHaveLength(0);
  });

  it('expires idle guests and recovers them by re-scanning while the sitting is open', async () => {
    const g = (await join(alpha.id, table2, undefined, 'Ravi').expect(200)).body.data;
    await order(g.token, 'Thali').expect(201);
    await migrator.query(
      `UPDATE table_guests SET last_seen_at = now() - interval '13 hours' WHERE session_id = $1`,
      [g.session.id],
    );
    const exp = await me(g.token).expect(401);
    expect(exp.body.code).toBe('GUEST_SESSION_EXPIRED');
    const back = (await join(alpha.id, table2, g.token).expect(200)).body.data;
    expect(back).toMatchObject({ restored: true });
    expect(back.guest.outstandingMinor).toBe(35000);
    await order(g.token, 'Lassi').expect(201);
  });

  it('links staff dine-in orders at a known table to the same sitting', async () => {
    const s = (await staff('owner', 'get', `/table-sessions?tableId=${table2}`).expect(200)).body
      .data;
    const o = (
      await staff('owner', 'post', '/orders')
        .set('Idempotency-Key', randomUUID())
        .send({
          branchId: alpha.main,
          channel: 'dine_in',
          tableLabel: 'T02',
          lines: [{ menuItemId: item.Dosa, quantity: 1 }],
        })
        .expect(201)
    ).body.data;
    expect(o.tableSessionId).toBe(s.session.id);
    const after = (await staff('owner', 'get', `/table-sessions?tableId=${table2}`).expect(200))
      .body.data;
    expect(after.table.outstandingMinor).toBe(10000);
    await staff('owner', 'post', `/table-sessions/${s.session.id}/payments`)
      .send({ unassigned: true, method: 'cash', amountMinor: 10000 })
      .expect(201);
  });

  it('lists open sittings with balances', async () => {
    const open = (
      await staff('owner', 'get', `/table-sessions/open?branchId=${alpha.main}`).expect(200)
    ).body.data;
    const t2 = open.find((o: { tableLabel: string }) => o.tableLabel === 'T02');
    expect(t2).toMatchObject({ guests: 1, outstandingMinor: 35000 + 6000 });
    await staff('bravoOwner', 'get', `/table-sessions/open?branchId=${alpha.main}`).expect(403);
  });

  it('blocks cross-tenant access everywhere', async () => {
    // Another tenant's table under my tenant id, and a forged token tenant prefix.
    await join(alpha.id, bravoTable).expect(404);
    await join(bravo.id, table1).expect(404);
    const g = (await join(alpha.id, table2).expect(200)).body.data.token as string;
    const forged = `${bravo.id}.${g.split('.')[1]}`;
    await me(forged).expect(401);
    await me('not-a-token').expect(401);
    const s = (await staff('owner', 'get', `/table-sessions?tableId=${table2}`).expect(200)).body
      .data;
    expect(
      (await staff('bravoOwner', 'get', `/table-sessions?sessionId=${s.session.id}`).expect(200))
        .body.data,
    ).toBeNull();
    await staff('bravoOwner', 'post', `/table-sessions/${s.session.id}/payments`)
      .send({ method: 'cash', amountMinor: 100 })
      .expect(404);
    await staff('bravoOwner', 'post', `/table-sessions/${s.session.id}/close`).expect(404);
  });

  // ---- Phase 2: secure QR links, guest contact & consent, payment choice ----

  const rawJoin = (body: Record<string, unknown>, token?: string) => {
    const r = http().post(`${API}/public/guest/join`).set('X-Forwarded-For', freshIp());
    if (token) r.set('X-Guest-Token', token);
    return r.send(body);
  };

  it('requires the table QR key for new guests unless old links are allowed', async () => {
    // Restaurants created after the migration start with old (keyless) links off.
    const none = await rawJoin({ tenantId: alpha.id, tableId: table2 }).expect(410);
    expect(none.body.code ?? none.body.error?.code).toBeDefined();
    await rawJoin({ tenantId: alpha.id, tableId: table2, key: 'x'.repeat(32) }).expect(410);
    await rawJoin({ tenantId: alpha.id, tableId: table2, key: qrKeys[table2] }).expect(200);

    // A manager can temporarily allow the old printed codes.
    await staff('owner', 'put', '/tables/qr-settings')
      .send({ branchId: alpha.main, legacyLinks: true })
      .expect(200);
    await rawJoin({ tenantId: alpha.id, tableId: table2 }).expect(200);
    await staff('owner', 'put', '/tables/qr-settings')
      .send({ branchId: alpha.main, legacyLinks: false })
      .expect(200);
    await rawJoin({ tenantId: alpha.id, tableId: table2 }).expect(410);
  });

  it('rotates a table key: old code stops working, seated guests are unaffected', async () => {
    const oldKey = qrKeys[table2]!;
    const seated = (await rawJoin({ tenantId: alpha.id, tableId: table2, key: oldKey }).expect(200))
      .body.data.token as string;
    expect((await staff('owner', 'get', `/tables/${table2}/qr`).expect(200)).body.data.key).toBe(
      oldKey,
    );

    const rotated = (await staff('owner', 'post', `/tables/${table2}/qr/rotate`).expect(200)).body
      .data.key as string;
    expect(rotated).not.toBe(oldKey);
    await rawJoin({ tenantId: alpha.id, tableId: table2, key: oldKey }).expect(410); // new device
    // The guest already seated re-opens the page (old link, own token): still their bill.
    const back = (
      await rawJoin({ tenantId: alpha.id, tableId: table2, key: oldKey }, seated).expect(200)
    ).body.data;
    expect(back.restored).toBe(true);
    await rawJoin({ tenantId: alpha.id, tableId: table2, key: rotated }).expect(200);
    qrKeys[table2] = rotated;

    // Keys are manager-only and tenant-scoped; the audit log never stores the key.
    await staff('bravoOwner', 'get', `/tables/${table2}/qr`).expect(404);
    await staff('bravoOwner', 'post', `/tables/${table2}/qr/rotate`).expect(404);
    const audit = (await migrator.query(
      `SELECT metadata FROM audit_logs WHERE action = 'table.qr_rotated' AND entity_id = $1`,
      [table2],
    )) as { metadata: unknown }[];
    expect(JSON.stringify(audit)).not.toContain(rotated);
  });

  it('stores an optional mobile number with explicit consent', async () => {
    const token = (await join(alpha.id, table1).expect(200)).body.data.token as string;
    const put = (body: object) =>
      http()
        .put(`${API}/public/guest/contact`)
        .set('X-Forwarded-For', freshIp())
        .set('X-Guest-Token', token)
        .send(body);
    const saved = (
      await put({ phone: '98765 43210', receiptConsent: true, marketingConsent: false }).expect(200)
    ).body.data.contact;
    expect(saved).toEqual({
      phone: '+919876543210',
      receiptConsent: true,
      marketingConsent: false,
    });
    await put({ phone: '12345', receiptConsent: true, marketingConsent: false }).expect(400);
    // No number → no receipt consent, whatever the client sends.
    const cleared = (
      await put({ phone: null, receiptConsent: true, marketingConsent: true }).expect(200)
    ).body.data.contact;
    expect(cleared).toEqual({ phone: null, receiptConsent: false, marketingConsent: true });
    // Without a guest token nothing is written.
    await http()
      .put(`${API}/public/guest/contact`)
      .set('X-Forwarded-For', freshIp())
      .send({ phone: null, receiptConsent: false, marketingConsent: false })
      .expect(401);
  });

  it("records the guest's payment choice on the order", async () => {
    const token = (await join(alpha.id, table1).expect(200)).body.data.token as string;
    const name = Object.keys(item)[0]!;
    const send = (paymentPreference: string) =>
      http()
        .post(`${API}/public/guest/orders`)
        .set('X-Forwarded-For', freshIp())
        .set('X-Guest-Token', token)
        .set('Idempotency-Key', randomUUID())
        .send({ paymentPreference, lines: [{ menuItemId: item[name], quantity: 1 }] });
    const res = await send('counter_card').expect(201);
    const detail = (await staff('owner', 'get', `/orders/${res.body.data.order.id}`).expect(200))
      .body.data;
    expect(detail.paymentPreference).toBe('counter_card');
    await send('online').expect(400); // online payment arrives with the payment phase
  });
});
