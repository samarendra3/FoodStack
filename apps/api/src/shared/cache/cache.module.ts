import { Global, Module } from '@nestjs/common';
import { CacheService } from './cache.service';

/** The one application cache (Redis, cache-aside). Modules inject CacheService; no module opens its own Redis client. */
@Global()
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
