import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import {
  AccessRequestsController,
  PlatformAccessRequestsController,
} from './access-requests.controller';
import { AccessRequestsService } from './access-requests.service';

@Module({
  imports: [AuthModule],
  controllers: [AccessRequestsController, PlatformAccessRequestsController],
  providers: [AccessRequestsService],
})
export class AccessRequestsModule {}
