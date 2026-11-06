import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { PlatformAnalyticsService } from './platform-analytics.service';

/** CacheService comes from the global CacheModule (the one shared Redis client). */
@Module({
  imports: [AuthModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, PlatformAnalyticsService],
  exports: [PlatformAnalyticsService],
})
export class AnalyticsModule {}
