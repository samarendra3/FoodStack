import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type Redis from 'ioredis';
import { AppConfigService } from '../../config/app-config.service';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { RedisThrottlerStorage } from './redis-throttler.storage';

/**
 * Global per-client-IP rate limit (Redis-backed, shared by all instances). Exceeding it returns
 * 429 Problem Details with Retry-After. Stricter limits for sensitive routes (login, OTP, PIN)
 * are set per route with `@Throttle()`; probes opt out with `@SkipThrottle()`.
 *
 * Client IPs come from `req.ip`, so set TRUST_PROXY=true behind the load balancer.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [AppConfigService, REDIS_CLIENT],
      useFactory: (config: AppConfigService, redis: Redis) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.get('RATE_LIMIT_WINDOW_MS'),
            limit: config.get('RATE_LIMIT_MAX'),
          },
        ],
        storage: new RedisThrottlerStorage(redis, config.get('QUEUE_PREFIX')),
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class RateLimitModule {}
