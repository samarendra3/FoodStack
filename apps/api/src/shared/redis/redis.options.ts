import { AppConfigService } from '../../config/app-config.service';

/** Connection settings accepted by both ioredis and BullMQ (which ships its own option types). */
export type RedisConnectionSettings = {
  host: string;
  port: number;
  password?: string;
  tls?: Record<string, never>;
  maxRetriesPerRequest: null;
  enableReadyCheck: boolean;
};

export function buildRedisOptions(config: AppConfigService): RedisConnectionSettings {
  const password = config.get('REDIS_PASSWORD');
  return {
    host: config.get('REDIS_HOST'),
    port: config.get('REDIS_PORT'),
    ...(password ? { password } : {}),
    ...(config.get('REDIS_TLS') ? { tls: {} } : {}),
    // Required by BullMQ for blocking connections; harmless for the cache client.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };
}
