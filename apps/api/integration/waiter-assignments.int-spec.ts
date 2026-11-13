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
 * Phase 5: automatic workload-based waiter assignment of READY orders, the unassigned queue,
 * accept / claim / problem / supervisor reassignment, concurrency and isolation.
 */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;

describe('Waiter assignment (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  const tenants: string[] = [];
  const emails: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  let main: string;
  let second: string;
  let chai: string;

  const call = (who: string, method: 'get' | 'post', url: string) =>
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
    userIds[key] = u.id;
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
    const alpha = await tenant('wasalpha');
    const bravo = await tenant('wasbravo');
    main = alpha.main;
    second = alpha.second;
    await member('owner', alpha.id, 'owner', hash);
    await member('manager', alpha.id, 'branch_manager', hash, alpha.main);
    await member('cook', alpha.id, 'kitchen_staff', hash, alpha.main);
    await member('asha', alpha.id, 'waiter', hash, alpha.main);
    await member('ravi', alpha.id, 'waiter', hash, alpha.main);
    await member('neha', alpha.id, 'waiter', hash, alpha.main); // never clocks in
    await member('sam', alpha.id, 'waiter', hash, alpha.second);
    await member('bravoWaiter', bravo.id, 'waiter', hash, bravo.main);

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
    await call('owner', 'post', '/menu/import')
      .send({ rows: [{ category: 'Drinks', name: 'Chai', priceMinor: 5000, diet: 'veg' }] })
      .expect(201);
    chai = (await call('owner', 'get', '/menu').expect(200)).body.data.items[0].id;
  });

  afterAll(async () => {
    await app?.close();
    if (migrator?.isInitialized) {
      for (const table of [
        'waiter_assignments',
        'attendance_entries',
        'order_discounts',
        'order_items',
        'invoices',
        'invoice_series',
        'orders',
        'table_sessions',
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

  /** Places an order and cooks it to READY (which triggers assignment). */
  async function readyOrder(table: string, branchId = main) {
    const o = (
      await call('owner', 'post', '/orders')
        .set('Idempotency-Key', `o-${suffix()}${suffix()}`)
        .send({
          branchId,
          channel: 'dine_in',
          tableLabel: table,
          lines: [{ menuItemId: chai, quantity: 1 }],
        })
        .expect(201)
    ).body.data as { id: string };
    for (const to of ['preparing', 'ready']) {
      await call(branchId === main ? 'cook' : 'owner', 'post', `/kitchen/tickets/${o.id}/status`)
        .send({ to })
        .expect(200);
    }
    return o.id;
  }
  const board = async (who = 'asha', branchId = main) =>
    (await call(who, 'get', `/waiter/ready-orders?branchId=${branchId}`).expect(200)).body.data as {
      orderId: string;
      tableLabel: string;
      assignment: {
        id: string;
        status: string;
        waiterUserId: string | null;
        problemNote: string | null;
      } | null;
    }[];
  const taskOf = async (orderId: string) =>
    (await board()).find((o) => o.orderId === orderId)!.assignment!;

  it('queues READY orders as unassigned while no waiter is clocked in', async () => {
    const id = await readyOrder('Q1');
    const t = await taskOf(id);
    expect(t).toMatchObject({ status: 'unassigned', waiterUserId: null });
    // Any waiter of the branch can take it.
    await call('asha', 'post', `/waiter/assignments/${t.id}/claim`).expect(200);
    expect(await taskOf(id)).toMatchObject({ status: 'accepted', waiterUserId: userIds.asha });
    // …but only once.
    await call('ravi', 'post', `/waiter/assignments/${t.id}/claim`).expect(409);
    await call('asha', 'post', `/waiter/orders/${id}/served`).expect(200);
    expect((await board()).some((o) => o.orderId === id)).toBe(false);
  });

  it('assigns clocked-in waiters by workload, never supervisors or absent staff', async () => {
    await call('asha', 'post', '/attendance/clock-in').send({ branchId: main }).expect(201);
    await call('ravi', 'post', '/attendance/clock-in').send({ branchId: main }).expect(201);
    await call('manager', 'post', '/attendance/clock-in').send({ branchId: main }).expect(201);

    const a = await taskOf(await readyOrder('A1'));
    const b = await taskOf(await readyOrder('A2'));
    // Both clocked-in waiters get one each (fewest open tasks first), not the same person twice.
    expect(new Set([a.waiterUserId, b.waiterUserId])).toEqual(
      new Set([userIds.asha, userIds.ravi]),
    );
    const c = await taskOf(await readyOrder('A3'));
    expect([userIds.asha, userIds.ravi]).toContain(c.waiterUserId);
    for (const t of [a, b, c]) {
      expect(t.waiterUserId).not.toBe(userIds.manager); // supervisor holds waiter:assign
      expect(t.waiterUserId).not.toBe(userIds.neha); // not clocked in
    }
  });

  it('lets only the assigned waiter accept; a problem sends it back to the queue', async () => {
    const id = await readyOrder('P1');
    const t = await taskOf(id);
    const mine = t.waiterUserId === userIds.asha ? 'asha' : 'ravi';
    const other = mine === 'asha' ? 'ravi' : 'asha';
    await call(other, 'post', `/waiter/assignments/${t.id}/accept`).expect(409);
    await call(mine, 'post', `/waiter/assignments/${t.id}/accept`).expect(200);
    expect((await taskOf(id)).status).toBe('accepted');

    await call(mine, 'post', `/waiter/assignments/${t.id}/problem`)
      .send({ reason: 'Table moved to patio' })
      .expect(200);
    const back = await taskOf(id);
    expect(back).toMatchObject({ status: 'unassigned', problemNote: 'Table moved to patio' });
    await call(mine, 'post', `/waiter/assignments/${t.id}/accept`).expect(409); // old task is closed
  });

  it('lets a supervisor assign and reassign, with history kept', async () => {
    const id = await readyOrder('S1');
    const first = await taskOf(id);
    const target = first.waiterUserId === userIds.asha ? 'neha' : 'neha';
    // Waiters cannot assign.
    await call('asha', 'post', `/waiter/assignments/${first.id}/assign`)
      .send({ waiterUserId: userIds[target] })
      .expect(403);
    const staff = (await call('manager', 'get', `/waiter/staff?branchId=${main}`).expect(200)).body
      .data as { userId: string; clockedIn: boolean; openTasks: number }[];
    expect(staff.find((s) => s.userId === userIds.neha)).toMatchObject({ clockedIn: false });
    expect(staff.some((s) => s.userId === userIds.sam)).toBe(false); // other branch

    const r = await call('manager', 'post', `/waiter/assignments/${first.id}/assign`)
      .send({ waiterUserId: userIds.neha })
      .expect(200);
    expect(await taskOf(id)).toMatchObject({ status: 'assigned', waiterUserId: userIds.neha });
    // A waiter of another branch cannot be chosen.
    await call('manager', 'post', `/waiter/assignments/${r.body.data.id}/assign`)
      .send({ waiterUserId: userIds.sam })
      .expect(409);
    const rows = (await migrator.query(
      `SELECT status FROM waiter_assignments WHERE order_id = $1 ORDER BY created_at`,
      [id],
    )) as { status: string }[];
    expect(rows.map((x) => x.status)).toEqual(['reassigned', 'assigned']);
  });

  it('never double-assigns an order, even with concurrent ready calls', async () => {
    const o = (
      await call('owner', 'post', '/orders')
        .set('Idempotency-Key', `o-${suffix()}${suffix()}`)
        .send({
          branchId: main,
          channel: 'dine_in',
          tableLabel: 'C1',
          lines: [{ menuItemId: chai, quantity: 1 }],
        })
        .expect(201)
    ).body.data as { id: string };
    await call('cook', 'post', `/kitchen/tickets/${o.id}/status`)
      .send({ to: 'preparing' })
      .expect(200);
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        call('cook', 'post', `/kitchen/tickets/${o.id}/status`).send({ to: 'ready' }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const open = (await migrator.query(
      `SELECT count(*)::int AS n FROM waiter_assignments
        WHERE order_id = $1 AND status IN ('unassigned', 'assigned', 'accepted')`,
      [o.id],
    )) as { n: number }[];
    expect(open[0]!.n).toBe(1);
  });

  it('keeps branches and restaurants apart; served orders appear in history', async () => {
    const otherBranch = await readyOrder('X1', second);
    expect((await board('asha')).some((o) => o.orderId === otherBranch)).toBe(false);
    const t = (await board('sam', second)).find((o) => o.orderId === otherBranch)!.assignment!;
    await call('asha', 'post', `/waiter/assignments/${t.id}/claim`).expect(403);
    const foreign = await call('bravoWaiter', 'post', `/waiter/assignments/${t.id}/claim`);
    expect([403, 404]).toContain(foreign.status);

    const id = await readyOrder('H1');
    const mine = await taskOf(id);
    const who = mine.waiterUserId === userIds.asha ? 'asha' : 'ravi';
    await call(who, 'post', `/waiter/orders/${id}/served`).expect(200);
    const history = (await call(who, 'get', `/waiter/history?branchId=${main}`).expect(200)).body
      .data as { orderId: string; status: string }[];
    expect(history.find((h) => h.orderId === id)).toMatchObject({ status: 'served' });
  });
});
