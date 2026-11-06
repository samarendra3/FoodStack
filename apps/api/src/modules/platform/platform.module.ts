import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AuthModule } from '../auth/auth.module';
import { PlatformController } from './platform.controller';

@Module({
  imports: [AuthModule, AnalyticsModule],
  controllers: [PlatformController],
})
export class PlatformModule {}
