import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import type { AppConfigService } from '../src/config/app-config.service';
import { RedisThrottlerStorage } from '../src/shared/rate-limit/redis-throttler.storage';
import { buildCacheRedisOptions } from '../src/shared/redis/redis.options';
import { testEnv } from './helpers';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Redis (integration)', () => {
  const env = testEnv();
  const config = { get: (key: keyof typeof env) => env[key] } as unknown as AppConfigService;
  const prefix = `it-${randomUUID()}`;
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis({ ...buildCacheRedisOptions(config), lazyConnect: true });
    await redis.connect();
  });

  afterAll(async () => {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });

  it('counts hits, blocks over the limit, then starts a fresh window after the block', async () => {
    const storage = new RedisThrottlerStorage(redis, prefix);
    const hit = () => storage.increment('client-1', 2_000, 3, 1_000, 'default');

    for (const expected of [1, 2, 3]) {
      expect(await hit()).toMatchObject({ totalHits: expected, isBlocked: false });
    }
    expect(await hit()).toMatchObject({ isBlocked: true, timeToBlockExpire: 1 });
    expect((await hit()).isBlocked).toBe(true);

    await sleep(1_100);
    expect(await hit()).toMatchObject({ totalHits: 1, isBlocked: false });
  });

  it('keeps counters per client and per throttler, one cluster slot per counter', async () => {
    const storage = new RedisThrottlerStorage(redis, prefix);
    await storage.increment('client-2', 60_000, 10, 0, 'default');
    await storage.increment('client-2', 60_000, 10, 0, 'login');
    expect((await storage.increment('client-3', 60_000, 10, 0, 'default')).totalHits).toBe(1);

    const keys = await redis.keys(`${prefix}:throttle:{default:client-2}*`);
    expect(keys).toEqual([`${prefix}:throttle:{default:client-2}:hits`]);
  });

  it('reports over-limit hits without a block period when blockDuration is 0', async () => {
    const storage = new RedisThrottlerStorage(redis, prefix);
    await storage.increment('client-4', 60_000, 1, 0, 'default');
    expect(await storage.increment('client-4', 60_000, 1, 0, 'default')).toMatchObject({
      totalHits: 2,
      isBlocked: true,
    });
  });
});
