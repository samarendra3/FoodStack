import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { encodeCursor } from '../src/common/pagination/paged';
import { PasswordHasher } from '../src/core/security/password-hasher';
import type { AuthContext } from '../src/modules/auth/auth.types';
import { platformInvoicesQuerySchema } from '../src/modules/billing/billing.schemas';
import { PlatformBillingService } from '../src/modules/billing/platform-billing.service';
import { connect } from './helpers';

/**
 * Keyset (cursor) pagination for orders, payments, stock movements and platform invoices:
 * first/next/previous pages, no duplicates or gaps (including equal timestamps and
 * microsecond-distinct ones), concurrent inserts, filters, sorts, invalid cursors, empty
 * lists, tenant and branch isolation, and offset mode unchanged.
 */

const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;
const ORDERS = 37; // not a multiple of the page size

interface Page {
  data: { id: string; orderNumber?: number; totalMinor?: number; status?: string }[];
  meta: {
    pagination: 'cursor';
    limit: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    nextCursor: string | null;
    prevCursor: string | null;
  };
}

describe('Cursor pagination (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  const tenants: string[] = [];
  const emails: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  let alpha: { id: string; restaurant: string; main: string; second: string };
  let bravo: { id: string; restaurant: string; main: string; second: string };
  let invoiceTenantName: string;
  let adminId: string;

  const get = (who: string, url: string) =>
    request(app.getHttpServer())
      .get(`${API}${url}`)
      .set('X-Forwarded-For', freshIp())
      .set('Authorization', `Bearer ${tokens[who]}`);
  const page = async (who: string, url: string): Promise<Page> =>
    (await get(who, url).expect(200)).body as Page;
  const withCursor = (url: string, cursor: string) =>
    `${url}${url.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`;

  /** Follows nextCursor to the end; returns every id in order. */
  async function walk(
    who: string,
    url: string,
    start?: string,
  ): Promise<{ ids: string[]; pages: Page[] }> {
    const pages: Page[] = [await page(who, start ? withCursor(url, start) : url)];
    while (pages.at(-1)!.meta.nextCursor) {
      pages.push(await page(who, withCursor(url, pages.at(-1)!.meta.nextCursor!)));
      if (pages.length > 100) throw new Error('runaway pagination');
    }
    return { ids: pages.flatMap((p) => p.data.map((r) => r.id)), pages };
  }

  async function tenant(label: string) {
    const [t] = await migrator.query(
      `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
      [`${label}-${suffix()}`, `${label}-${suffix()}`],
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
    return {
      id: t.id as string,
      restaurant: r.id as string,
      main: await branch('MAIN'),
      second: await branch('SECOND'),
    };
  }

  async function member(
    key: string,
    tenantId: string,
    role: string,
    hash: string,
    branch?: string,
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
      [tenantId, m.id, role, branch ? 'branch' : 'tenant', branch ?? null],
    );
    return u.id as string;
  }

  /**
   * Orders 1..n: groups of three share one created_at exactly (tie-break by id); within the
   * series, timestamps differ by microseconds only every fourth order (precision trap).
   */
  async function seedOrders(t: typeof alpha, n: number, startNumber = 1) {
    await migrator.query(
      `INSERT INTO orders (tenant_id, restaurant_id, branch_id, order_number, channel, status,
                           kitchen_status, currency_code, tax_rate_bp, subtotal_minor,
                           discount_minor, tax_minor, total_minor, paid_minor, refunded_minor,
                           created_at, completed_at)
       SELECT $1, $2, CASE WHEN g % 4 = 0 THEN $4::uuid ELSE $3::uuid END, g, 'takeaway',
              CASE WHEN g % 5 = 0 THEN 'open' ELSE 'completed' END, 'served', 'INR', 0,
              (g % 7) * 1000 + 1000, 0, 0, (g % 7) * 1000 + 1000,
              CASE WHEN g % 5 = 0 THEN 0 ELSE (g % 7) * 1000 + 1000 END, 0,
              timestamptz '2026-01-01 10:00:00+00' + ((g / 3) * interval '1 minute')
                + ((g % 4) * interval '1 microsecond'),
              CASE WHEN g % 5 = 0 THEN NULL
                   ELSE timestamptz '2026-01-01 10:00:00+00' + ((g / 3) * interval '1 minute') END
         FROM generate_series($5::int, $6::int) g`,
      [t.id, t.restaurant, t.main, t.second, startNumber, startNumber + n - 1],
    );
    await migrator.query(
      `INSERT INTO payments (tenant_id, order_id, branch_id, method, amount_minor, created_at)
       SELECT tenant_id, id, branch_id, CASE WHEN order_number % 2 = 0 THEN 'cash' ELSE 'upi' END,
              total_minor, created_at
         FROM orders WHERE tenant_id = $1 AND status = 'completed'
          AND order_number BETWEEN $2 AND $3`,
      [t.id, startNumber, startNumber + n - 1],
    );
  }

  beforeAll(async () => {
    migrator = await connect('migration');
    await migrator.runMigrations({ transaction: 'each' });
    const hash = await new PasswordHasher().hash(PASSWORD);
    alpha = await tenant('curalpha');
    bravo = await tenant('curbravo');
    await member('owner', alpha.id, 'owner', hash);
    await member('manager', alpha.id, 'branch_manager', hash, alpha.main);
    await member('bravoOwner', bravo.id, 'owner', hash);
    await seedOrders(alpha, ORDERS);
    await seedOrders(bravo, 5);

    const [item] = await migrator.query(
      `INSERT INTO inventory_items (tenant_id, restaurant_id, name, unit, currency_code)
       VALUES ($1, $2, 'Rice', 'kg', 'INR') RETURNING id`,
      [alpha.id, alpha.restaurant],
    );
    await migrator.query(
      `INSERT INTO inventory_movements (tenant_id, branch_id, item_id, type, quantity_delta,
                                        quantity_after, created_at)
       SELECT $1, $2, $3, 'purchase', g, g * 10, timestamptz '2026-02-01 08:00+00' + (g / 2) * interval '1 hour'
         FROM generate_series(1, 23) g`,
      [alpha.id, alpha.main, item.id],
    );

    invoiceTenantName = (
      await migrator.query('SELECT name FROM tenants WHERE id = $1', [alpha.id])
    )[0].name;
    await migrator.query(
      `INSERT INTO subscription_invoices (tenant_id, plan_id, plan_name, kind, billing_cycle,
                                          amount_minor, currency_code, status, created_at, cancelled_at)
       SELECT $1, (SELECT id FROM plans ORDER BY created_at LIMIT 1), 'Plan', 'renewal', 'monthly',
              g * 100, 'INR', 'cancelled', timestamptz '2026-03-01 00:00+00' + (g / 3) * interval '1 day', now()
         FROM generate_series(1, 14) g`,
      [alpha.id],
    );
    const [admin] = await migrator.query(
      `INSERT INTO users (email, full_name, password_hash, email_verified_at)
       VALUES ($1, 'Admin', $2, now()) RETURNING id`,
      [`curadmin-${suffix()}@example.test`, hash],
    );
    adminId = admin.id;

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
        'payments',
        'orders',
        'inventory_movements',
        'inventory_items',
        'subscription_invoices',
        'user_role_assignments',
      ]) {
        await migrator.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
      }
      await migrator.destroy();
    }
  });

  const ORDERS_URL = '/orders?pagination=cursor&limit=10';

  describe('orders', () => {
    it('returns a first page with cursor metadata and no total', async () => {
      const first = await page('owner', ORDERS_URL);
      expect(first.data).toHaveLength(10);
      expect(first.meta).toMatchObject({
        pagination: 'cursor',
        limit: 10,
        hasNextPage: true,
        hasPreviousPage: false,
        prevCursor: null,
      });
      expect(first.meta.nextCursor).toEqual(expect.any(String));
      expect(first.meta).not.toHaveProperty('total');
    });

    it('walks every order exactly once in the same order as offset paging', async () => {
      const { ids, pages } = await walk('owner', ORDERS_URL);
      expect(ids).toHaveLength(ORDERS);
      expect(new Set(ids).size).toBe(ORDERS);
      expect(pages.map((p) => p.data.length)).toEqual([10, 10, 10, 7]);
      expect(pages.at(-1)!.meta).toMatchObject({ hasNextPage: false, nextCursor: null });
      const offset = await get('owner', '/orders?limit=100').expect(200);
      expect(ids).toEqual(offset.body.data.map((r: { id: string }) => r.id));
    });

    it('goes back with prevCursor to exactly the previous page', async () => {
      const { pages } = await walk('owner', ORDERS_URL);
      for (let i = pages.length - 1; i > 0; i -= 1) {
        const back = await page('owner', withCursor(ORDERS_URL, pages[i]!.meta.prevCursor!));
        expect(back.data.map((r) => r.id)).toEqual(pages[i - 1]!.data.map((r) => r.id));
        expect(back.meta.hasNextPage).toBe(true);
        expect(back.meta.hasPreviousPage).toBe(i - 1 > 0);
      }
    });

    it('supports every whitelisted sort in both directions without gaps', async () => {
      for (const sortBy of ['createdAt', 'orderNumber', 'totalMinor', 'status']) {
        for (const sortOrder of ['asc', 'desc']) {
          const url = `/orders?pagination=cursor&limit=10&sortBy=${sortBy}&sortOrder=${sortOrder}`;
          const { ids } = await walk('owner', url);
          const offset = await get(
            'owner',
            `/orders?limit=100&sortBy=${sortBy}&sortOrder=${sortOrder}`,
          );
          expect({ sortBy, sortOrder, ids }).toEqual({
            sortBy,
            sortOrder,
            ids: offset.body.data.map((r: { id: string }) => r.id),
          });
        }
      }
    });

    it('keeps filters across pages', async () => {
      const { ids, pages } = await walk('owner', `${ORDERS_URL}&status=open`);
      const open = Math.floor(ORDERS / 5);
      expect(ids).toHaveLength(open);
      expect(pages.flatMap((p) => p.data).every((r) => r.status === 'open')).toBe(true);
    });

    it('does not duplicate or skip rows when orders are inserted while paging', async () => {
      const first = await page('owner', `${ORDERS_URL}&sortOrder=desc`);
      // New orders are newer than everything: with offset paging they would shift page 2.
      await seedOrders(alpha, 5, 1000);
      try {
        const rest = await walk('owner', `${ORDERS_URL}&sortOrder=desc`, first.meta.nextCursor!);
        const ids = [...first.data.map((r) => r.id), ...rest.ids];
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toHaveLength(ORDERS);
        // Going back from page 2 now reaches the new orders: page 1 is no longer the start.
        const back = await page(
          'owner',
          withCursor(`${ORDERS_URL}&sortOrder=desc`, rest.pages[0]!.meta.prevCursor!),
        );
        expect(back.data.map((r) => r.id)).toEqual(first.data.map((r) => r.id));
        expect(back.meta.hasPreviousPage).toBe(true);
      } finally {
        await migrator.query(
          `DELETE FROM payments WHERE tenant_id = $1 AND order_id IN (SELECT id FROM orders WHERE tenant_id = $1 AND order_number >= 1000)`,
          [alpha.id],
        );
        await migrator.query(`DELETE FROM orders WHERE tenant_id = $1 AND order_number >= 1000`, [
          alpha.id,
        ]);
      }
    });

    it('rejects malformed, tampered and mismatched cursors with 400 INVALID_CURSOR', async () => {
      const first = await page('owner', ORDERS_URL);
      const cursor = first.meta.nextCursor!;
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      const bad = [
        'not-base64-json',
        encodeCursor({ ...decoded, f: '0000000000000000' }),
        Buffer.from(JSON.stringify({ ...decoded, k: { $gt: 1 } })).toString('base64url'),
        Buffer.from(JSON.stringify({ ...decoded, i: "x' OR 1=1 --" })).toString('base64url'),
      ];
      for (const c of bad) {
        const res = await get('owner', withCursor(ORDERS_URL, c)).expect(400);
        expect(res.body.code).toBe('INVALID_CURSOR');
      }
      // Same cursor with another filter or sort is a different list.
      for (const url of [`${ORDERS_URL}&status=open`, `${ORDERS_URL}&sortBy=totalMinor`]) {
        const res = await get('owner', withCursor(url, cursor)).expect(400);
        expect(res.body.code).toBe('INVALID_CURSOR');
      }
      await get('owner', `${ORDERS_URL}&cursor=${'a'.repeat(600)}`).expect(400);
      await get('owner', `${ORDERS_URL}&cursor=bad%20chars!`).expect(400);
    });

    it('returns an empty page for an empty list', async () => {
      const empty = await page('owner', `${ORDERS_URL}&from=2030-01-01`);
      expect(empty.data).toEqual([]);
      expect(empty.meta).toMatchObject({
        hasNextPage: false,
        hasPreviousPage: false,
        nextCursor: null,
        prevCursor: null,
      });
    });

    it('scopes cursor pages to the caller’s branches and tenant', async () => {
      const manager = await walk('manager', ORDERS_URL);
      const mainOnly = await walk('owner', `${ORDERS_URL}&branchId=${alpha.main}`);
      expect(manager.ids).toEqual(mainOnly.ids);
      expect(manager.ids.length).toBeLessThan(ORDERS);
      // The manager cannot replay the owner's cursor (different authorised branch set).
      const owner = await page('owner', ORDERS_URL);
      const replay = await get('manager', withCursor(ORDERS_URL, owner.meta.nextCursor!)).expect(
        400,
      );
      expect(replay.body.code).toBe('INVALID_CURSOR');
      await get('manager', `${ORDERS_URL}&branchId=${alpha.second}`).expect(403);
      // Another tenant sees only its own orders and cannot use alpha's cursor.
      const b = await walk('bravoOwner', ORDERS_URL);
      expect(b.ids).toHaveLength(5);
      expect(b.ids.some((id) => manager.ids.includes(id))).toBe(false);
      await get('bravoOwner', withCursor(ORDERS_URL, owner.meta.nextCursor!)).expect(400);
    });

    it('leaves offset paging unchanged', async () => {
      const res = await get('owner', '/orders?page=2&limit=10').expect(200);
      expect(res.body.meta).toMatchObject({ page: 2, limit: 10, total: ORDERS, totalPages: 4 });
    });

    it('answers 400 for lists without cursor support', async () => {
      const res = await get('owner', '/customers?pagination=cursor').expect(400);
      expect(res.body.code).toBe('CURSOR_UNSUPPORTED');
    });
  });

  it('pages payments with filters, both directions', async () => {
    const url = '/payments?pagination=cursor&limit=10&method=cash';
    const { ids, pages } = await walk('owner', url);
    const offset = await get('owner', '/payments?limit=100&method=cash').expect(200);
    expect(ids).toEqual(offset.body.data.map((r: { id: string }) => r.id));
    expect(new Set(ids).size).toBe(ids.length);
    const back = await page('owner', withCursor(url, pages[1]!.meta.prevCursor!));
    expect(back.data.map((r) => r.id)).toEqual(pages[0]!.data.map((r) => r.id));
  });

  it('pages stock movements for one branch, by date and by quantity', async () => {
    for (const sortBy of ['createdAt', 'quantity']) {
      const url = `/inventory/movements?branchId=${alpha.main}&pagination=cursor&limit=10&sortBy=${sortBy}`;
      const { ids } = await walk('owner', url);
      const offset = await get(
        'owner',
        `/inventory/movements?branchId=${alpha.main}&limit=100&sortBy=${sortBy}`,
      ).expect(200);
      expect(ids).toHaveLength(23);
      expect(ids).toEqual(offset.body.data.map((r: { id: string }) => r.id));
    }
  });

  it('pages platform invoices', async () => {
    const service = app.get(PlatformBillingService);
    const auth = { userId: adminId } as AuthContext;
    const q = (extra: Record<string, string>) =>
      platformInvoicesQuerySchema.parse({
        pagination: 'cursor',
        limit: '10',
        search: invoiceTenantName,
        ...extra,
      });
    const first = await service.invoices(auth, q({}));
    expect(first.items).toHaveLength(10);
    const meta = first.meta as Page['meta'];
    const second = await service.invoices(auth, q({ cursor: meta.nextCursor! }));
    expect(second.items).toHaveLength(4);
    const all = [...first.items, ...second.items].map((r) => (r as { id: string }).id);
    expect(new Set(all).size).toBe(14);
    const back = await service.invoices(
      auth,
      q({ cursor: (second.meta as Page['meta']).prevCursor! }),
    );
    expect(back.items.map((r) => (r as { id: string }).id)).toEqual(
      first.items.map((r) => (r as { id: string }).id),
    );
  });
});
