import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type Redis from 'ioredis';

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/**
 * Fixed-window counter with an optional block period, atomically in one round trip.
 * KEYS: hits, block · ARGV: window ms, limit, block ms
 * Returns: { hits, window ms left, blocked (0/1), block ms left }
 */
const INCREMENT_SCRIPT = `
local blockLeft = redis.call('PTTL', KEYS[2])
if blockLeft > 0 then
  return { tonumber(ARGV[2]) + 1, blockLeft, 1, blockLeft }
end
local hits = redis.call('INCR', KEYS[1])
local windowLeft = redis.call('PTTL', KEYS[1])
if windowLeft < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  windowLeft = tonumber(ARGV[1])
end
if hits > tonumber(ARGV[2]) then
  local blockMs = tonumber(ARGV[3])
  if blockMs > 0 then
    redis.call('SET', KEYS[2], '1', 'PX', blockMs)
    redis.call('DEL', KEYS[1])
    return { hits, blockMs, 1, blockMs }
  end
  return { hits, windowLeft, 1, windowLeft }
end
return { hits, windowLeft, 0, 0 }
`;

const toSeconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000));

/**
 * Shares rate-limit counters across API instances through Redis.
 *
 * Fails open: if Redis is unreachable the request is allowed (and the outage logged), because
 * locking every restaurant out of the API is worse than briefly losing rate limiting. Account
 * lockout for credentials is enforced separately in the database.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger('RateLimit');
  private lastFailureLog = 0;

  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    // The {hash tag} keeps both keys in one Redis Cluster slot, as the script requires.
    const base = `${this.prefix}:throttle:{${throttlerName}:${key}}`;
    try {
      const [hits, windowLeft, blocked, blockLeft] = (await this.redis.eval(
        INCREMENT_SCRIPT,
        2,
        `${base}:hits`,
        `${base}:block`,
        ttl,
        limit,
        blockDuration,
      )) as [number, number, number, number];
      return {
        totalHits: hits,
        timeToExpire: toSeconds(windowLeft),
        isBlocked: blocked === 1,
        timeToBlockExpire: toSeconds(blockLeft),
      };
    } catch (error) {
      this.logFailure(error as Error);
      return { totalHits: 0, timeToExpire: toSeconds(ttl), isBlocked: false, timeToBlockExpire: 0 };
    }
  }

  private logFailure(error: Error): void {
    const now = Date.now();
    if (now - this.lastFailureLog < 60_000) return;
    this.lastFailureLog = now;
    this.logger.error(`Rate limiting disabled while Redis is unavailable: ${error.message}`);
  }
}
