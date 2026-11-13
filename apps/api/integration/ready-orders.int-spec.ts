import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PasswordHasher } from '../src/core/security/password-hasher';
import { OrderEventsService } from '../src/modules/orders/order-events';
import { DbContext } from '../src/core/db/db-context';
import { connect } from './helpers';

/**
 * Kitchen → waiter "order ready" events: SSE delivery to every waiter of the branch, never to
 * other branches or tenants, backlog recovery after a reconnect, and waiter-side "served".
 */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Sse {
  status: number;
  events: { event: string; data: Record<string, unknown>; id?: string }[];
  close: () => void;
}

describe('Ready-order events (integration)', () => {
  let app: NestExpressApplication;
  let base: string;
  let migrator: DataSource;
  const tenants: string[] = [];
  const emails: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  const streams: Sse[] = [];
  let main: string;
  let second: string;
  let bravoMain: string;
  let chai: string;
  let table: string;
  let alphaId: string;

  const call = (who: string, method: 'get' | 'post', url: string) =>
    request(app.getHttpServer())
      [method](`${API}${url}`)
      .set('X-Forwarded-For', freshIp())
      .set('Authorization', `Bearer ${tokens[who]}`);

  /** Opens the SSE stream like the web app does (fetch + Bearer) and collects its events. */
  async function listen(
    who: string | null,
    branchId: string,
    path = '/waiter/ready-orders/stream',
    lastEventId?: string,
  ): Promise<Sse> {
    const ctrl = new AbortController();
    const res = await fetch(`${base}${API}${path}?branchId=${branchId}`, {
      headers: {
        Accept: 'text/event-stream',
        'X-Forwarded-For': freshIp(),
        ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}),
        ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
      },
      signal: ctrl.signal,
    });
    const sse: Sse = { status: res.status, events: [], close: () => ctrl.abort() };
    streams.push(sse);
    if (res.ok && res.body) {
      void (async () => {
        const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            buf += value;
            let cut: number;
            while ((cut = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, cut);
              buf = buf.slice(cut + 2);
              const event = /^event: (.*)$/m.exec(block)?.[1];
              const data = /^data: (.*)$/m.exec(block)?.[1];
              const id = /^id: (.*)$/m.exec(block)?.[1];
              if (event && data) sse.events.push({ event, data: JSON.parse(data), id });
            }
          }
        } catch {
          /* aborted */
        }
      })();
      await until(() => sse.events.some((e) => e.event === 'hello'));
    }
    return sse;
  }

  async function until(check: () => boolean, ms = 3000) {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out waiting for event');
      await sleep(20);
    }
  }

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
    const alpha = await tenant('rdyalpha');
    const bravo = await tenant('rdybravo');
    main = alpha.main;
    second = alpha.second;
    bravoMain = bravo.main;
    await member('owner', alpha.id, 'owner', hash);
    await member('cook', alpha.id, 'kitchen_staff', hash, alpha.main);
    await member('waiter1', alpha.id, 'waiter', hash, alpha.main);
    await member('waiter2', alpha.id, 'waiter', hash, alpha.main);
    await member('waiterSecond', alpha.id, 'waiter', hash, alpha.second);
    await member('cashier', alpha.id, 'cashier', hash, alpha.main);
    await member('bravoWaiter', bravo.id, 'waiter', hash, bravo.main);
    await member('cook2', alpha.id, 'kitchen_staff', hash, alpha.main);
    await member('cookSecond', alpha.id, 'kitchen_staff', hash, alpha.second);
    await member('bravoCook', bravo.id, 'kitchen_staff', hash, bravo.main);
    alphaId = alpha.id;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    for (const who of Object.keys(emails)) {
      const res = await request(app.getHttpServer())
        .post(`${API}/auth/login`)
        .set('X-Forwarded-For', freshIp())
        .send({ email: emails[who], password: PASSWORD })
        .expect(200);
      tokens[who] = res.body.data.accessToken as string;
    }
    await call('owner', 'post', '/menu/import')
      .send({ rows: [{ category: 'Drinks', name: 'Chai', priceMinor: 5000, diet: 'veg' }] })
      .expect(201);
    chai = (await call('owner', 'get', '/menu').expect(200)).body.data.items[0].id;
    table = (
      await call('owner', 'post', '/tables').send({ branchId: main, label: 'Q1' }).expect(201)
    ).body.data.id;
  });

  afterAll(async () => {
    streams.forEach((s) => s.close());
    await app?.close();
    if (migrator?.isInitialized) {
      for (const table of [
        'refunds',
        'payments',
        'order_discounts',
        'order_items',
        'orders',
        'table_guests',
        'table_sessions',
        'dining_tables',
        'branch_order_counters',
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

  async function placeAndCookToPreparing(table: string) {
    const order = (
      await call('owner', 'post', '/orders')
        .send({
          branchId: main,
          channel: 'dine_in',
          tableLabel: table,
          lines: [{ menuItemId: chai, quantity: 2, note: 'less sugar' }],
        })
        .expect(201)
    ).body.data as { id: string; orderNumber: string | number };
    for (const to of ['accepted', 'preparing']) {
      await call('cook', 'post', `/kitchen/tickets/${order.id}/status`).send({ to }).expect(200);
    }
    return order;
  }

  it('authorizes the stream per branch and tenant', async () => {
    expect((await listen(null, main)).status).toBe(401);
    expect((await listen('cashier', main)).status).toBe(403); // no waiter:access
    expect((await listen('waiterSecond', main)).status).toBe(403); // other branch
    expect((await listen('bravoWaiter', main)).status).toBe(403); // other tenant
    await call('cashier', 'get', `/waiter/ready-orders?branchId=${main}`).expect(403);
  });

  let ready: { id: string };

  it('pushes order.ready to every waiter of the branch, and to no one else', async () => {
    const w1 = await listen('waiter1', main);
    const w2 = await listen('waiter2', main);
    const other = await listen('waiterSecond', second);
    const otherTenant = await listen('bravoWaiter', bravoMain);

    ready = await placeAndCookToPreparing('T7');
    // Preparing is not "ready": nothing is sent yet.
    await sleep(300);
    expect(w1.events.filter((e) => e.event !== 'hello')).toHaveLength(0);

    const t0 = Date.now();
    await call('cook', 'post', `/kitchen/tickets/${ready.id}/status`)
      .send({ to: 'ready' })
      .expect(200);
    const isReady = (s: Sse) => s.events.some((e) => e.event === 'order.ready');
    await until(() => isReady(w1) && isReady(w2));
    const latency = Date.now() - t0;

    const e = w1.events.find((x) => x.event === 'order.ready')!.data;
    expect(e).toMatchObject({
      orderId: ready.id,
      branchId: main,
      tableLabel: 'T7',
      items: [expect.objectContaining({ name: 'Chai', qty: 2, note: 'less sugar' })],
    });
    expect(typeof e.orderNumber).toBe('string');
    expect(e).not.toHaveProperty('tenantId');
    expect(w2.events.filter((x) => x.event === 'order.ready')).toHaveLength(1); // exactly once

    await sleep(400);
    expect(other.events.filter((x) => x.event !== 'hello')).toHaveLength(0);
    expect(otherTenant.events.filter((x) => x.event !== 'hello')).toHaveLength(0);
    expect(latency).toBeLessThan(1000); // "instant": well under a second end to end
  });

  it('recovers ready orders missed while disconnected', async () => {
    streams.forEach((s) => s.close()); // everyone goes offline
    const missed = await placeAndCookToPreparing('T9');
    await call('cook', 'post', `/kitchen/tickets/${missed.id}/status`)
      .send({ to: 'ready' })
      .expect(200);

    const back = await listen('waiter1', main); // reconnect…
    expect(back.events[0]!.event).toBe('hello');
    const backlog = (
      await call('waiter1', 'get', `/waiter/ready-orders?branchId=${main}`).expect(200)
    ).body.data as { orderId: string; tableLabel: string }[];
    expect(backlog.map((o) => o.orderId)).toEqual(expect.arrayContaining([ready.id, missed.id]));
    // Other branch's backlog stays empty.
    const otherBacklog = (
      await call('waiterSecond', 'get', `/waiter/ready-orders?branchId=${second}`).expect(200)
    ).body.data;
    expect(otherBacklog).toHaveLength(0);
  });

  it('lets a waiter mark a ready order served and tells the other waiters', async () => {
    const w2 = await listen('waiter2', main);
    await call('waiterSecond', 'post', `/waiter/orders/${ready.id}/served`).expect(403);
    await call('waiter1', 'post', `/waiter/orders/${ready.id}/served`).expect(200);
    await until(() =>
      w2.events.some((e) => e.event === 'order.served' && e.data.orderId === ready.id),
    );
    await call('waiter1', 'post', `/waiter/orders/${ready.id}/served`).expect(409); // already served
    const backlog = (
      await call('waiter1', 'get', `/waiter/ready-orders?branchId=${main}`).expect(200)
    ).body.data as { orderId: string }[];
    expect(backlog.map((o) => o.orderId)).not.toContain(ready.id);
  });

  it('cannot serve an order that is not ready yet', async () => {
    const o = await placeAndCookToPreparing('T3');
    await call('waiter1', 'post', `/waiter/orders/${o.id}/served`).expect(409);
  });

  // ---- kitchen: new-order events (waiter, POS and QR share one path) ----

  const kitchen = (who: string, branchId = main) =>
    listen(who, branchId, '/kitchen/tickets/stream');
  const created = (s: Sse) => s.events.filter((e) => e.event === 'order.created');

  async function waiterOrder(who: string, tableLabel: string) {
    return (
      await call(who, 'post', '/orders')
        .set('Idempotency-Key', `w-${suffix()}${suffix()}`)
        .send({
          branchId: main,
          channel: 'dine_in',
          tableLabel,
          lines: [{ menuItemId: chai, quantity: 1 }],
        })
        .expect(201)
    ).body.data as { id: string };
  }

  it('authorizes the kitchen stream per branch and tenant', async () => {
    expect((await kitchen('waiter1')).status).toBe(403); // no kds:access
    expect((await kitchen('cookSecond')).status).toBe(403); // other branch
    expect((await kitchen('bravoCook')).status).toBe(403); // other tenant
  });

  it('rings every kitchen screen of the branch when a waiter sends an order', async () => {
    streams.forEach((s) => s.close());
    const k1 = await kitchen('cook');
    const k2 = await kitchen('cook2');
    const other = await kitchen('cookSecond', second);
    const otherTenant = await kitchen('bravoCook', bravoMain);

    const t0 = Date.now();
    const o = await waiterOrder('waiter1', 'T11');
    await until(() => created(k1).length === 1 && created(k2).length === 1);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(created(k1)[0]!.data).toMatchObject({
      type: 'order.created',
      branchId: main,
      orderId: o.id,
      tableLabel: 'T11',
    });
    expect(created(k1)[0]!.data).not.toHaveProperty('tenantId');

    // The kitchen re-reads its tickets on the event: the order is there, status new.
    const tickets = (await call('cook', 'get', `/kitchen/tickets?branchId=${main}`).expect(200))
      .body.data as { id: string; status: string; tableLabel: string }[];
    expect(tickets.find((t) => t.id === o.id)).toMatchObject({ status: 'new', tableLabel: 'T11' });

    await sleep(400);
    expect(created(other)).toHaveLength(0);
    expect(created(otherTenant)).toHaveLength(0);
  });

  it('delivers both orders when two waiters send at the same time', async () => {
    const k = await kitchen('cook');
    const [a, b] = await Promise.all([
      waiterOrder('waiter1', 'T12'),
      waiterOrder('waiter2', 'T13'),
    ]);
    await until(() => created(k).length === 2);
    expect(
      created(k)
        .map((e) => e.data.orderId)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  });

  it('rings the kitchen for QR guest orders through the same event', async () => {
    const k = await kitchen('cook');
    const join = await request(app.getHttpServer())
      .post(`${API}/public/guest/join`)
      .set('X-Forwarded-For', freshIp())
      .send({
        tenantId: alphaId,
        tableId: table,
        key: (
          (await migrator.query('SELECT qr_key FROM dining_tables WHERE id = $1', [table])) as {
            qr_key: string;
          }[]
        )[0]!.qr_key,
      })
      .expect(200);
    const res = await request(app.getHttpServer())
      .post(`${API}/public/guest/orders`)
      .set('X-Forwarded-For', freshIp())
      .set('X-Guest-Token', join.body.data.token)
      .set('Idempotency-Key', `g-${suffix()}${suffix()}`)
      .send({ lines: [{ menuItemId: chai, quantity: 1 }] })
      .expect(201);
    await until(() => created(k).length === 1);
    expect(created(k)[0]!.data.orderId).toBe(res.body.data.order.id);
  });

  it('tells other kitchen screens when a ticket moves', async () => {
    const o = await waiterOrder('waiter1', 'T14');
    const k2 = await kitchen('cook2');
    await call('cook', 'post', `/kitchen/tickets/${o.id}/status`)
      .send({ to: 'accepted' })
      .expect(200);
    await until(() => k2.events.some((e) => e.event === 'order.status' && e.data.orderId === o.id));
  });

  // ---- Phase 1: transactional outbox, replay, sweeper, timeline ----

  const eventsOf = async (orderId: string) =>
    (await migrator.query(
      `SELECT id, type, published_at FROM order_events WHERE order_id = $1 ORDER BY id`,
      [orderId],
    )) as { id: string; type: string; published_at: Date | null }[];

  it('records each change in the same transaction and publishes it after commit', async () => {
    const key = `w-${suffix()}${suffix()}`;
    const body = {
      branchId: main,
      channel: 'dine_in',
      tableLabel: 'T20',
      lines: [{ menuItemId: chai, quantity: 1 }],
    };
    const first = (
      await call('waiter1', 'post', '/orders').set('Idempotency-Key', key).send(body).expect(201)
    ).body.data as { id: string };
    // Idempotent retry: same order, no second event (the kitchen cannot ring twice).
    const again = (
      await call('waiter1', 'post', '/orders').set('Idempotency-Key', key).send(body).expect(201)
    ).body.data as { id: string };
    expect(again.id).toBe(first.id);

    let rows = await eventsOf(first.id);
    expect(rows.map((r) => r.type)).toEqual(['order.created']);

    // A rejected change rolls back with its event: skipping straight to ready is refused.
    await call('cook', 'post', `/kitchen/tickets/${first.id}/status`)
      .send({ to: 'ready' })
      .expect(409);
    await call('cook', 'post', `/kitchen/tickets/${first.id}/status`)
      .send({ to: 'accepted' })
      .expect(200);
    await sleep(200);
    rows = await eventsOf(first.id);
    expect(rows.map((r) => r.type)).toEqual(['order.created', 'order.status']);
    expect(rows.every((r) => r.published_at !== null)).toBe(true);
  });

  it('replays events missed while disconnected, exactly once and in order', async () => {
    const k = await kitchen('cook');
    const a = await waiterOrder('waiter1', 'T21');
    await until(() => created(k).some((e) => e.data.orderId === a.id));
    const lastSeen = created(k).find((e) => e.data.orderId === a.id)!.id!;
    k.close(); // screen goes offline…

    const b = await waiterOrder('waiter2', 'T22');
    await call('cook', 'post', `/kitchen/tickets/${b.id}/status`)
      .send({ to: 'accepted' })
      .expect(200);
    const c = await waiterOrder('waiter1', 'T23');

    // …and comes back with Last-Event-ID: it gets b, b's status change and c, nothing older.
    const back = await listen('cook', main, '/kitchen/tickets/stream', lastSeen);
    await until(() => back.events.filter((e) => e.event !== 'hello').length >= 3);
    await sleep(300);
    const got = back.events.filter((e) => e.event !== 'hello');
    expect(got.map((e) => [e.event, e.data.orderId])).toEqual([
      ['order.created', b.id],
      ['order.status', b.id],
      ['order.created', c.id],
    ]);
    expect(new Set(got.map((e) => e.id)).size).toBe(got.length);
  });

  it('re-publishes events a crashed process left unpublished (sweeper)', async () => {
    const o = await waiterOrder('waiter1', 'T24');
    await sleep(200);
    const [row] = await eventsOf(o.id);
    // Simulate "committed, then the process died before publishing".
    await migrator.query(
      `UPDATE order_events SET published_at = NULL, created_at = now() - interval '1 minute' WHERE id = $1`,
      [row!.id],
    );
    const k = await kitchen('cook2');
    // Any instance's sweeper may win (a dev API sharing this DB too); the outcome is what counts.
    await app.get(OrderEventsService).sweep();
    await until(() => k.events.some((e) => e.id === row!.id));
    expect((await eventsOf(o.id))[0]!.published_at).not.toBeNull();
  });

  it('shows a readable, branch-scoped timeline', async () => {
    const o = await waiterOrder('waiter1', 'T25');
    for (const to of ['accepted', 'preparing', 'ready']) {
      await call('cook', 'post', `/kitchen/tickets/${o.id}/status`).send({ to }).expect(200);
    }
    await call('waiter1', 'post', `/waiter/orders/${o.id}/served`).expect(200);
    const detail = (await call('owner', 'get', `/orders/${o.id}`).expect(200)).body.data as {
      totalMinor: number;
    };
    await call('owner', 'post', `/orders/${o.id}/payments`)
      .set('Idempotency-Key', `p-${suffix()}${suffix()}`)
      .send({ method: 'cash', amountMinor: detail.totalMinor })
      .expect(201);

    const timeline = (await call('owner', 'get', `/orders/${o.id}/timeline`).expect(200)).body
      .data as {
      type: string;
      actor: { kind: string; name: string };
      details: Record<string, unknown>;
    }[];
    expect(timeline.map((t) => t.type)).toEqual([
      'order.created',
      'order.status',
      'order.status',
      'order.ready',
      'order.served',
      'payment.recorded',
    ]);
    expect(timeline[0]!.actor).toEqual({ kind: 'staff', name: 'waiter1' });
    expect(timeline[3]!.actor.name).toBe('cook');
    expect(timeline[3]!.details).toEqual({ from: 'preparing', to: 'ready' });
    expect(timeline[5]!.details).toMatchObject({ method: 'cash', paidInFull: true });
    expect(timeline[3]!.details).not.toHaveProperty('items');

    // Another branch's waiter and another tenant cannot read it.
    await call('waiterSecond', 'get', `/orders/${o.id}/timeline`).expect(403);
    const other = await call('bravoWaiter', 'get', `/orders/${o.id}/timeline`);
    expect([403, 404]).toContain(other.status);
  });

  it('isolates the event table by tenant under RLS', async () => {
    const leaked = await app
      .get(DbContext)
      .run({ tenantId: tenants[1]! }, (db) =>
        db.query(`SELECT 1 FROM order_events WHERE tenant_id = $1 LIMIT 1`, [alphaId]),
      );
    expect(leaked).toHaveLength(0);
  });
});
