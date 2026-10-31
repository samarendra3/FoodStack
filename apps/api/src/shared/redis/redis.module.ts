import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../../config/app-config.service';
import { logRedisErrorsOncePerOutage } from './redis-error-logging';
import { REDIS_CLIENT } from './redis.constants';
import { buildCacheRedisOptions } from './redis.options';

const logger = new Logger('Redis');

/**
 * Shared request-path Redis connection (cache, rate limiting, health checks). It fails fast
 * while Redis is down; BullMQ keeps its own retry-forever connections (see QueueModule).
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => {
        const client = new Redis({
          ...buildCacheRedisOptions(config),
          lazyConnect: false,
          connectionName: 'foodstack-api',
        });
        const { recovered } = logRedisErrorsOncePerOutage(client, logger, 'shared client');
        client.on('ready', recovered);
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
