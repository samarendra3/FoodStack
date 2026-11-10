import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AuthModule } from '../auth/auth.module';
import { AnnouncementController, PlatformAdminController } from './platform-admin.controller';
import { PlatformController } from './platform.controller';

@Module({
  imports: [AuthModule, AnalyticsModule],
  controllers: [PlatformController, PlatformAdminController, AnnouncementController],
})
export class PlatformModule {}
