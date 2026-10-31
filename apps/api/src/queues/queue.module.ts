import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Global, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Queue } from 'bullmq';
import { AppConfigService } from '../config/app-config.service';
import { logRedisErrorsOncePerOutage } from '../shared/redis/redis-error-logging';
import { buildRedisOptions } from '../shared/redis/redis.options';
import { ALL_QUEUES } from './queue.constants';

/**
 * BullMQ infrastructure: one shared connection config, sane job defaults, all queues registered.
 * Modules inject queues with `@InjectQueue(QueueName.X)` and add their own processors.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        connection: buildRedisOptions(config),
        prefix: config.get('QUEUE_PREFIX'),
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: { age: 24 * 3600, count: 1_000 },
          removeOnFail: { age: 7 * 24 * 3600 },
        },
      }),
    }),
    BullModule.registerQueue(...ALL_QUEUES.map((name) => ({ name }))),
  ],
  exports: [BullModule],
})
export class QueueModule implements OnModuleInit {
  private readonly logger = new Logger('Queue');

  constructor(private readonly moduleRef: ModuleRef) {}

  onModuleInit(): void {
    for (const name of ALL_QUEUES) {
      const queue = this.moduleRef.get<Queue>(getQueueToken(name), { strict: false });
      const { recovered } = logRedisErrorsOncePerOutage(queue, this.logger, `queue "${name}"`);
      // Not awaited: the client promise waits for a connection, which must not block startup.
      void queue.backend.client.then((client) => client.on('ready', recovered));
    }
  }
}
