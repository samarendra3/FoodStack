import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import type { AppConfigService } from '../src/config/app-config.service';
import { DbContext } from '../src/core/db/db-context';
import { PasswordHasher } from '../src/core/security/password-hasher';
import type { AuthContext } from '../src/modules/auth/auth.types';
import { PlatformBillingService } from '../src/modules/billing/platform-billing.service';
import { CacheEntry, CacheNs, seg } from '../src/shared/cache/cache.keys';
import { CacheService } from '../src/shared/cache/cache.service';
import { buildCacheRedisOptions } from '../src/shared/redis/redis.options';
import { connect, testEnv } from './helpers';

/**
 * Phase 4 cache (docs/PHASE_4_REDIS_REPORT.md): cache-aside behaviour against a real Redis,
 * outage and recovery, post-commit invalidation, and every invalidation rule plus tenant and
 * branch isolation through the HTTP API.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PASSWORD = 'Correct-Horse-42';
const API = '/api/v1';
const suffix = () => randomBytes(4).toString('hex');
const freshIp = () => `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function cacheConfig(overrides: Record<string, unknown> = {}): AppConfigService {
  const env = {
    ...testEnv(),
    QUEUE_PREFIX: `it-${randomUUID()}`,
    CACHE_BREAKER_MS: 200,
    ...overrides,
  };
  return { get: (key: string) => (env as Record<string, unknown>)[key] } as AppConfigService;
}

/** A loader that counts calls and returns a fresh value each time. */
function counter(label = 'v') {
  let calls = 0;
  const load = async () => {
    calls += 1;
    await sleep(20);
    return { label, calls };
  };
  return { load, calls: () => calls };
}

describe('CacheService (Redis)', () => {
  let redis: Redis;
  let config: AppConfigService;
  let cache: CacheService;
  const t1 = randomUUID();
  const t2 = randomUUID();
  const r1 = randomUUID();

  beforeAll(async () => {
    config = cacheConfig();
    redis = new Redis({ ...buildCacheRedisOptions(config), lazyConnect: true });
    redis.on('error', () => undefined);
    await redis.connect();
  });

  beforeEach(() => {
    cache = new CacheService(redis, config);
    jest
      .spyOn((cache as unknown as { logger: { error: () => void } }).logger, 'error')
      .mockImplementation(() => undefined);
  });

  afterAll(async () => {
    const keys = await redis.keys(`${config.get('QUEUE_PREFIX')}:*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });

  it('misses, then hits without calling the loader', async () => {
    const c = counter();
    const ns = CacheNs.menu(t1, r1);
    expect(await cache.getOrLoad(ns, 'a', 60, c.load)).toEqual({ label: 'v', calls: 1 });
    expect(await cache.getOrLoad(ns, 'a', 60, c.load)).toEqual({ label: 'v', calls: 1 });
    expect(c.calls()).toBe(1);
    const m = cache.metrics.snapshot().entries['menu:a']!;
    expect(m).toMatchObject({ hits: 1, misses: 1, fallbacks: 0 });
  });

  it('expires entries after their TTL (with at most 10% jitter)', async () => {
    const c = counter();
    const ns = CacheNs.menu(t1, r1);
    await cache.getOrLoad(ns, 'ttl', 1, c.load);
    const keys = await redis.keys(`${config.get('QUEUE_PREFIX')}:cache:*:ttl`);
    expect(await redis.pttl(keys[0]!)).toBeLessThanOrEqual(1_000);
    await sleep(1_150);
    await cache.getOrLoad(ns, 'ttl', 1, c.load);
    expect(c.calls()).toBe(2);
  });

  it('invalidation retires every entry of the namespace and nothing else', async () => {
    const menu = CacheNs.menu(t1, r1);
    const inventory = CacheNs.inventory(t1, r1);
    const a = counter();
    const b = counter();
    await cache.getOrLoad(menu, 'x', 60, a.load);
    await cache.getOrLoad(inventory, 'x', 60, b.load);
    await cache.invalidate(menu);
    await cache.getOrLoad(menu, 'x', 60, a.load);
    await cache.getOrLoad(inventory, 'x', 60, b.load);
    expect(a.calls()).toBe(2);
    expect(b.calls()).toBe(1);
    expect(cache.metrics.snapshot().invalidations).toMatchObject({ menu: 1 });
  });

  it('keeps tenants and branches apart', async () => {
    const one = await cache.getOrLoad(CacheNs.menu(t1, r1), 'iso', 60, async () => 'tenant-1');
    const two = await cache.getOrLoad(CacheNs.menu(t2, r1), 'iso', 60, async () => 'tenant-2');
    expect([one, two]).toEqual(['tenant-1', 'tenant-2']);
    const ns = CacheNs.inventory(t1, r1);
    const b1 = randomUUID();
    const b2 = randomUUID();
    await cache.getOrLoad(ns, CacheEntry.inventorySummary(b1), 60, async () => 'branch-1');
    expect(
      await cache.getOrLoad(ns, CacheEntry.inventorySummary(b2), 60, async () => 'branch-2'),
    ).toBe('branch-2');
  });

  it('rejects key segments that could change a key shape', () => {
    for (const bad of ['', 'a:b', 'a*', 'a b', '../x', 'x'.repeat(81)]) {
      expect(() => seg(bad)).toThrow();
    }
    expect(() => CacheNs.menu('t:1', r1)).toThrow();
  });

  it('never serves an entry whose stored key does not match (envelope check)', async () => {
    const ns = CacheNs.menu(t1, r1);
    await cache.getOrLoad(ns, 'env', 60, async () => 'real');
    const [key] = await redis.keys(`${config.get('QUEUE_PREFIX')}:cache:*:env`);
    await redis.set(key!, JSON.stringify({ k: 'other|env', d: 'forged' }), 'EX', 60);
    expect(await cache.getOrLoad(ns, 'env', 60, async () => 'reloaded')).toBe('reloaded');
  });

  it('runs one load for concurrent identical requests (single-flight)', async () => {
    const c = counter();
    const ns = CacheNs.menu(t1, randomUUID());
    const results = await Promise.all(
      Array.from({ length: 25 }, () => cache.getOrLoad(ns, 'burst', 60, c.load)),
    );
    expect(c.calls()).toBe(1);
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(cache.metrics.snapshot().entries['menu:burst']!.coalesced).toBe(24);
  });

  it('a follower loads on its own when the leader load fails', async () => {
    const ns = CacheNs.menu(t1, randomUUID());
    const leader = cache.getOrLoad(ns, 'fail', 60, async () => {
      await sleep(20);
      throw new Error('leader transaction failed');
    });
    const follower = cache.getOrLoad(ns, 'fail', 60, async () => 'own');
    await expect(leader).rejects.toThrow('leader transaction failed');
    expect(await follower).toBe('own');
  });

  it('a version read before a racing write keeps the stale load out of the new version', async () => {
    const ns = CacheNs.menu(t1, randomUUID());
    // Reader starts (reads version 0), writer commits and invalidates mid-load.
    const stale = cache.getOrLoad(ns, 'race', 60, async () => {
      await cache.invalidate(ns);
      return 'old';
    });
    expect(await stale).toBe('old');
    expect(await cache.getOrLoad(ns, 'race', 60, async () => 'new')).toBe('new');
  });

  it('falls back to the loader while Redis is unreachable, with the breaker limiting attempts', async () => {
    const down = new Redis({
      ...buildCacheRedisOptions(cacheConfig({ REDIS_PORT: await closedPort() })),
      host: '127.0.0.1',
      port: await closedPort(),
      retryStrategy: () => 50,
    });
    down.on('error', () => undefined);
    const offline = new CacheService(down, config);
    jest
      .spyOn((offline as unknown as { logger: { error: () => void } }).logger, 'error')
      .mockImplementation(() => undefined);
    const get = jest.spyOn(down, 'mget');
    try {
      const c = counter();
      for (let i = 0; i < 5; i++) {
        await offline.getOrLoad(CacheNs.menu(t1, r1), 'down', 60, c.load);
      }
      expect(c.calls()).toBe(5);
      expect(get).toHaveBeenCalledTimes(1); // breaker open after the first failure
      expect(offline.metrics.snapshot().totals.fallbacks).toBe(5);
      await offline.invalidate(CacheNs.menu(t1, r1)); // must not throw
      expect(offline.metrics.snapshot().invalidationErrors).toBe(1);
    } finally {
      down.disconnect();
    }
  });

  it('after an outage that lost an invalidation, recovery retires pre-outage entries', async () => {
    const svc = new CacheService(redis, config);
    const logger = (svc as unknown as { logger: Record<string, () => void> }).logger;
    for (const level of ['error', 'warn', 'log']) {
      jest.spyOn(logger, level as 'error').mockImplementation(() => undefined);
    }
    const ns = CacheNs.menu(t1, randomUUID());
    const epochKey = `${config.get('QUEUE_PREFIX')}:cache:epoch`;
    const epochBefore = Number((await redis.get(epochKey)) ?? 0);
    await svc.getOrLoad(ns, 'rec', 60, async () => 'before');

    // Outage: every command the cache sends fails, as with ECONNREFUSED / timeouts.
    const refused = () => Promise.reject(new Error('connect ECONNREFUSED'));
    const outage = [
      jest.spyOn(redis, 'mget').mockImplementation(refused as never),
      jest.spyOn(redis, 'multi').mockImplementation((() => ({
        incr: () => ({ expire: () => ({ exec: refused }) }),
      })) as never),
    ];
    await svc.invalidate(ns); // a write committed during the outage: the bump is lost
    expect(await svc.getOrLoad(ns, 'rec', 60, async () => 'during')).toBe('during');

    // Recovery.
    outage.forEach((m) => m.mockRestore());
    await sleep(250); // breaker window (CACHE_BREAKER_MS = 200)
    expect(await svc.getOrLoad(ns, 'rec', 60, async () => 'after')).toBe('after');
    expect(await svc.getOrLoad(ns, 'rec', 60, async () => 'unused')).toBe('after');
    expect(Number(await redis.get(epochKey))).toBe(epochBefore + 1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('epoch advanced'));
  });
});

describe('DbContext post-commit hooks', () => {
  let ds: DataSource;
  beforeAll(async () => {
    ds = await connect('app');
  });
  afterAll(() => ds?.destroy());

  it('runs hooks after commit, once per key', async () => {
    const ctx = new DbContext(ds);
    const fired: string[] = [];
    await ctx.run({}, async (db) => {
      db.afterCommit('a', () => void fired.push('a'));
      db.afterCommit('a', () => void fired.push('a-again'));
      await db.query('SELECT 1');
      expect(fired).toEqual([]); // not before commit
    });
    expect(fired).toEqual(['a']);
  });

  it('never runs hooks when the transaction rolls back', async () => {
    const ctx = new DbContext(ds);
    const fired: string[] = [];
    await expect(
      ctx.run({}, async (db) => {
        db.afterCommit('a', () => void fired.push('a'));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    await expect(
      ctx.run({}, async (db) => {
        db.afterCommit('b', () => void fired.push('b'));
        await db.query('SELECT 1/0');
      }),
    ).rejects.toThrow();
    expect(fired).toEqual([]);
  });

  it('a failing hook does not fail the committed request', async () => {
    const ctx = new DbContext(ds);
    await expect(
      ctx.run({}, async (db) => {
        db.afterCommit('x', () => Promise.reject(new Error('redis down')));
        return 42;
      }),
    ).resolves.toBe(42);
  });
});

describe('Cached endpoints (integration)', () => {
  let app: NestExpressApplication;
  let migrator: DataSource;
  let passwordHash: string;
  const tenants: string[] = [];
  const plans: string[] = [];
  const emails: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  let alpha: { id: string; restaurant: string; main: string; second: string };
  let bravo: { id: string; restaurant: string; main: string; second: string };

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
      restaurant: r.id as string,
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
    passwordHash = await new PasswordHasher().hash(PASSWORD);
    alpha = await createTenant('cachealpha');
    bravo = await createTenant('cachebravo');
    await addMember('owner', alpha.id, 'owner');
    await addMember('manager', alpha.id, 'branch_manager', alpha.main);
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
        'menu_item_variants',
        'menu_items',
        'menu_categories',
        'user_role_assignments',
      ]) {
        await migrator.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
      }
      if (plans.length)
        await migrator.query('DELETE FROM plans WHERE id = ANY($1::uuid[])', [plans]);
      await migrator.destroy();
    }
  });

  const hits = () => app.get(CacheService).metrics.snapshot().entries;

  let category: string;

  it('menu: second read is a cache hit; category and item writes invalidate it', async () => {
    category = (
      await call('owner', 'post', '/menu/categories').send({ name: 'Starters' }).expect(201)
    ).body.data.id;
    const first = (await call('owner', 'get', '/menu').expect(200)).body.data;
    const before = hits()['menu:catalogue']?.hits ?? 0;
    const second = (await call('owner', 'get', '/menu').expect(200)).body.data;
    expect(second).toEqual(first);
    expect(hits()['menu:catalogue']!.hits).toBe(before + 1);

    await call('owner', 'post', '/menu/items')
      .send({ categoryId: category, name: 'Samosa', priceMinor: 4000, diet: 'veg' })
      .expect(201);
    const afterCreate = (await call('owner', 'get', '/menu').expect(200)).body.data;
    expect(afterCreate.items.map((i: { name: string }) => i.name)).toEqual(['Samosa']);
    expect(afterCreate.categories[0].itemCount).toBe(1);

    const item = afterCreate.items[0].id;
    await call('owner', 'patch', `/menu/items/${item}`).send({ isAvailable: false }).expect(204);
    expect((await call('owner', 'get', '/menu').expect(200)).body.data.items[0].isAvailable).toBe(
      false,
    );

    await call('owner', 'patch', `/menu/categories/${category}`)
      .send({ name: 'Snacks' })
      .expect(204);
    const cats = (await call('owner', 'get', '/menu/categories').expect(200)).body.data;
    expect(cats.categories[0].name).toBe('Snacks');
    expect((await call('owner', 'get', '/menu').expect(200)).body.data.categories[0].name).toBe(
      'Snacks',
    );
  });

  it('menu: a failed (rolled back) write leaves the cached menu valid and unchanged', async () => {
    await call('owner', 'get', '/menu').expect(200);
    const before = hits()['menu:catalogue']!.hits;
    // Duplicate category name: 409, transaction rolled back, no invalidation.
    await call('owner', 'post', '/menu/categories').send({ name: 'Snacks' }).expect(409);
    await call('owner', 'get', '/menu').expect(200);
    expect(hits()['menu:catalogue']!.hits).toBe(before + 1);
  });

  it('menu: per-caller fields are not cached (canManage differs by caller)', async () => {
    const owner = (await call('owner', 'get', '/menu').expect(200)).body.data;
    const manager = (await call('manager', 'get', '/menu').expect(200)).body.data;
    expect(owner.canManage).toBe(true);
    expect(manager.items).toEqual(owner.items);
    expect(manager.canManage).toBe(
      (await call('manager', 'get', '/menu/categories').expect(200)).body.data.canManage,
    );
  });

  it('tenant isolation: another tenant cannot read a cached menu by passing its restaurant id', async () => {
    await call('owner', 'get', `/menu?restaurantId=${alpha.restaurant}`).expect(200); // cached
    await call('bravoOwner', 'get', `/menu?restaurantId=${alpha.restaurant}`).expect(403);
    const own = (await call('bravoOwner', 'get', '/menu').expect(200)).body.data;
    expect(own.restaurant.id).toBe(bravo.restaurant);
    expect(own.items).toEqual([]);
  });

  it('restaurant profile update invalidates menu and inventory payloads', async () => {
    await call('owner', 'get', '/menu').expect(200);
    await call('owner', 'get', '/inventory/summary').expect(200);
    await call('owner', 'patch', '/account/restaurant').send({ name: 'Alpha Renamed' }).expect(204);
    expect((await call('owner', 'get', '/menu').expect(200)).body.data.restaurant.name).toBe(
      'Alpha Renamed',
    );
    expect(
      (await call('owner', 'get', '/inventory/summary').expect(200)).body.data.restaurant.name,
    ).toBe('Alpha Renamed');
  });

  it('inventory: item and movement writes invalidate the branch summary', async () => {
    const s0 = (await call('owner', 'get', `/inventory/summary?branchId=${alpha.main}`).expect(200))
      .body.data;
    const id = (
      await call('owner', 'post', '/inventory/items')
        .send({
          name: 'Rice',
          unit: 'kg',
          category: 'Grains',
          lowStockThreshold: 5,
          costPerUnitMinor: 100,
        })
        .expect(201)
    ).body.data.id;
    const s1 = (await call('owner', 'get', `/inventory/summary?branchId=${alpha.main}`).expect(200))
      .body.data;
    expect(s1.counts.total).toBe(s0.counts.total + 1);
    expect(s1.counts.out).toBe(s0.counts.out + 1);

    await call('owner', 'post', `/inventory/items/${id}/movements`)
      .send({ branchId: alpha.main, type: 'purchase', quantity: 10 })
      .expect(201);
    const s2 = (await call('owner', 'get', `/inventory/summary?branchId=${alpha.main}`).expect(200))
      .body.data;
    expect(s2.counts.out).toBe(s0.counts.out);
    expect(s2.stockValueMinor).toBe(s0.stockValueMinor + 1000);
    // The other branch's summary is its own entry: still no stock there.
    const other = (
      await call('owner', 'get', `/inventory/summary?branchId=${alpha.second}`).expect(200)
    ).body.data;
    expect(other.stockValueMinor).toBe(0);
  });

  it('branch isolation: a branch manager cannot read another branch summary the owner cached', async () => {
    await call('owner', 'get', `/inventory/summary?branchId=${alpha.second}`).expect(200);
    await call('manager', 'get', `/inventory/summary?branchId=${alpha.second}`).expect(403);
    const own = (await call('manager', 'get', '/inventory/summary').expect(200)).body.data;
    expect(own.branch.id).toBe(alpha.main);
    expect(own.branches.map((b: { id: string }) => b.id)).toEqual([alpha.main]);
  });

  it('public plans: cached, and plan writes invalidate the list and the slug entry', async () => {
    const code = `cache-${suffix()}`;
    const [plan] = await migrator.query(
      `INSERT INTO plans (code, name, plan_type, currency_code, price_monthly_minor, is_active, is_public, sort_order)
       VALUES ($1, $2, 'paid', 'INR', 99900, true, true, 999) RETURNING id`,
      [code, `Cache ${code}`],
    );
    plans.push(plan.id);
    // Out-of-band insert (like the seed script): visible once the list is next loaded.
    await app.get(CacheService).invalidate(CacheNs.plans());
    const listed = (await request(app.getHttpServer()).get(`${API}/plans`).expect(200)).body.data;
    expect(listed.map((p: { code: string }) => p.code)).toContain(code);
    await request(app.getHttpServer()).get(`${API}/plans/${code}`).expect(200);

    const platformAuth = {
      userId: userIds.owner!,
      sessionId: null,
      audience: 'platform',
      tenantId: null,
      membershipId: null,
      mfaVerified: true,
    } as unknown as AuthContext;
    await app
      .get(PlatformBillingService)
      .archivePlan(platformAuth, plan.id, { ip: null, userAgent: null, requestId: null });

    const after = (await request(app.getHttpServer()).get(`${API}/plans`).expect(200)).body.data;
    expect(after.map((p: { code: string }) => p.code)).not.toContain(code);
    await request(app.getHttpServer()).get(`${API}/plans/${code}`).expect(404);
  });

  it('exposes cache metrics to Super Admin only', async () => {
    await call('owner', 'get', '/platform/cache').expect(403);
    const stats = await app.get(CacheService).stats();
    expect(stats.totals.hits).toBeGreaterThan(0);
    expect(stats.redis).toHaveProperty('used_memory');
    expect(JSON.stringify(stats)).not.toContain('Samosa'); // no values
  });
});
