import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { Inject, Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type Redis from 'ioredis';
import { AppConfigService } from '../config/app-config.service';
import {
  heartbeatKeyPrefix,
  type WorkerHeartbeat,
} from '../modules/notifications/queue-monitor.service';
import { REDIS_CLIENT } from '../shared/redis/redis.constants';
import { EmailProcessor } from './email.processor';

const BEAT_MS = 5_000;

/**
 * Liveness for the worker container, which has no HTTP listener:
 * - touches WORKER_HEARTBEAT_FILE while the BullMQ worker is running (Docker health check);
 * - publishes a heartbeat to Redis (30 s TTL) for GET /platform/queues.
 */
@Injectable()
export class WorkerHeartbeatService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly id = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private readonly startedAt = new Date().toISOString();
  private readonly key: string;
  private readonly file: string;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly processor: EmailProcessor,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: AppConfigService,
  ) {
    this.key = `${heartbeatKeyPrefix(config.get('QUEUE_PREFIX'))}${this.id}`;
    this.file = config.get('WORKER_HEARTBEAT_FILE');
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.beat(), BEAT_MS);
    this.timer.unref();
    void this.beat();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    rmSync(this.file, { force: true });
    await this.redis.del(this.key).catch(() => undefined);
  }

  async beat(): Promise<void> {
    const running = this.processor.worker?.isRunning() ?? false;
    if (running) {
      try {
        writeFileSync(this.file, String(Date.now()));
      } catch {
        // Unwritable path: the container health check then reports unhealthy, which is correct.
      }
    }
    const beat: WorkerHeartbeat = {
      id: this.id,
      startedAt: this.startedAt,
      beatAt: new Date().toISOString(),
      concurrency: this.processor.worker?.concurrency ?? 0,
      running,
      processed: this.processor.processed,
      failed: this.processor.failed,
    };
    // Redis down: the file still shows the process is alive; BullMQ reconnects on its own.
    await this.redis.set(this.key, JSON.stringify(beat), 'EX', 30).catch(() => undefined);
  }
}
