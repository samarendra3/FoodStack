import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

@Injectable()
export class RedisHealthIndicator {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key = 'redis', timeoutMs = 2_000) {
    const indicator = this.healthIndicatorService.check(key);
    try {
      // The client already fails fast (no offline queue, command timeout); this bound is a backstop.
      const pong = await Promise.race([
        this.redis.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs).unref(),
        ),
      ]);
      return pong === 'PONG'
        ? indicator.up()
        : indicator.down({ message: `Unexpected reply: ${pong}` });
    } catch (error) {
      return indicator.down({
        message: error instanceof Error ? error.message : 'Redis unavailable',
      });
    }
  }
}
