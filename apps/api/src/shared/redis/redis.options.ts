import { AppConfigService } from '../../config/app-config.service';

/** Connection settings common to every Redis client (ioredis and BullMQ accept the same shape). */
export type RedisConnectionSettings = {
  host: string;
  port: number;
  password?: string;
  tls?: Record<string, never>;
  enableReadyCheck: boolean;
};

export type QueueRedisSettings = RedisConnectionSettings & { maxRetriesPerRequest: null };

export type CacheRedisSettings = RedisConnectionSettings & {
  maxRetriesPerRequest: number;
  enableOfflineQueue: boolean;
  commandTimeout: number;
};

/** Upper bound for a single cache/rate-limit command, so a slow Redis cannot stall requests. */
export const CACHE_COMMAND_TIMEOUT_MS = 1_000;

export function buildRedisOptions(config: AppConfigService): RedisConnectionSettings {
  const password = config.get('REDIS_PASSWORD');
  return {
    host: config.get('REDIS_HOST'),
    port: config.get('REDIS_PORT'),
    ...(password ? { password } : {}),
    ...(config.get('REDIS_TLS') ? { tls: {} } : {}),
    enableReadyCheck: true,
  };
}

/**
 * BullMQ connections. Workers use blocking commands, which BullMQ requires to retry forever
 * (`maxRetriesPerRequest: null`); jobs simply wait for Redis to come back.
 */
export function buildQueueRedisOptions(config: AppConfigService): QueueRedisSettings {
  return { ...buildRedisOptions(config), maxRetriesPerRequest: null };
}

/**
 * Request-path client (cache, rate limiting, health). Fails fast while Redis is unreachable
 * instead of queueing commands, so callers can degrade (e.g. skip the cache) rather than hang.
 */
export function buildCacheRedisOptions(config: AppConfigService): CacheRedisSettings {
  return {
    ...buildRedisOptions(config),
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    commandTimeout: CACHE_COMMAND_TIMEOUT_MS,
  };
}
