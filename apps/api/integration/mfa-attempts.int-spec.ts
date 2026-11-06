import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import type { AppConfigService } from '../src/config/app-config.service';
import { MFA_ATTEMPT_WINDOW_SECONDS, MfaService } from '../src/modules/auth/mfa.service';
import { buildCacheRedisOptions } from '../src/shared/redis/redis.options';
import { testEnv } from './helpers';

/** Regression tests for the atomic MFA failure counter (Phase 4 follow-up). */
describe('MFA attempt counter (integration)', () => {
  const env = testEnv();
  const prefix = `it-mfa-${randomUUID()}`;
  const values: Record<string, unknown> = { ...env, QUEUE_PREFIX: prefix };
  const config = { get: (key: string) => values[key] } as unknown as AppConfigService;
  let redis: Redis;
  let mfa: MfaService;
  const keyOf = (challenge: string) => `${prefix}:auth:mfa-attempts:${challenge}`;

  beforeAll(async () => {
    redis = new Redis({ ...buildCacheRedisOptions(config), lazyConnect: true });
    await redis.connect();
    mfa = new MfaService(config, redis);
  });

  afterAll(async () => {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });

  it('counts failures and reports exhaustion exactly at the limit', async () => {
    const challenge = randomUUID();
    const results: boolean[] = [];
    for (let i = 0; i < 6; i += 1) results.push(await mfa.registerFailure(challenge, 5));
    expect(results).toEqual([false, false, false, false, true, true]);
    expect(await redis.get(keyOf(challenge))).toBe('6');
  });

  it('sets the expiry on the first failure and never extends it', async () => {
    const challenge = randomUUID();
    await mfa.registerFailure(challenge);
    const ttl1 = await redis.ttl(keyOf(challenge));
    expect(ttl1).toBeGreaterThan(MFA_ATTEMPT_WINDOW_SECONDS - 5);
    expect(ttl1).toBeLessThanOrEqual(MFA_ATTEMPT_WINDOW_SECONDS);
    await redis.expire(keyOf(challenge), 100);
    await mfa.registerFailure(challenge);
    // A later failure keeps the original window instead of resetting it.
    expect(await redis.ttl(keyOf(challenge))).toBeLessThanOrEqual(100);
  });

  it('repairs a counter left without a TTL by the old two-command version', async () => {
    const challenge = randomUUID();
    await redis.set(keyOf(challenge), '3'); // no TTL: the bug this change fixes
    expect(await redis.ttl(keyOf(challenge))).toBe(-1);
    await mfa.registerFailure(challenge);
    expect(await redis.get(keyOf(challenge))).toBe('4');
    expect(await redis.ttl(keyOf(challenge))).toBeGreaterThan(0);
  });

  it('keeps challenges independent', async () => {
    const a = randomUUID();
    const b = randomUUID();
    for (let i = 0; i < 4; i += 1) await mfa.registerFailure(a, 5);
    expect(await mfa.registerFailure(b, 5)).toBe(false);
    expect(await mfa.registerFailure(a, 5)).toBe(true);
  });

  it('is exact under concurrency: 50 parallel failures, one TTL, exhaustion reported', async () => {
    const challenge = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => mfa.registerFailure(challenge, 5)),
    );
    expect(await redis.get(keyOf(challenge))).toBe('50');
    expect(results.filter((exhausted) => !exhausted)).toHaveLength(4);
    expect(await redis.ttl(keyOf(challenge))).toBeGreaterThan(0);
  });

  it('fails closed when Redis is unavailable', async () => {
    const dead = new Redis({
      ...buildCacheRedisOptions(config),
      port: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    const broken = new MfaService(config, dead);
    await expect(broken.registerFailure(randomUUID())).rejects.toThrow();
    dead.disconnect();
  });
});
