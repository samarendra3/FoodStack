import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../../config/app-config.service';
import { logRedisErrorsOncePerOutage } from './redis-error-logging';
import { REDIS_CLIENT } from './redis.constants';
import { buildRedisOptions } from './redis.options';

const logger = new Logger('Redis');

/** Shared Redis connection for cache, rate limiting and health checks. */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => {
        const client = new Redis({
          ...buildRedisOptions(config),
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
