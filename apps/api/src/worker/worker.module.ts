import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { REDACTED_LOG_PATHS } from '../common/logging/request-id';
import { AppConfigService } from '../config/app-config.service';
import { AppConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { QueueModule } from '../queues/queue.module';
import { RedisModule } from '../shared/redis/redis.module';
import { EmailProcessor } from './email.processor';
import { OutboxRecoveryService } from './outbox-recovery.service';
import { WorkerHeartbeatService } from './worker-heartbeat.service';

/**
 * Worker process (src/worker.ts): no HTTP, no auth, no business modules. Same configuration,
 * database role (RLS applies) and Redis settings as the API.
 */
@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          redact: { paths: REDACTED_LOG_PATHS, censor: '[REDACTED]' },
        },
      }),
    }),
    DatabaseModule,
    RedisModule,
    QueueModule,
    NotificationsModule,
  ],
  providers: [EmailProcessor, OutboxRecoveryService, WorkerHeartbeatService],
})
export class WorkerModule {}
