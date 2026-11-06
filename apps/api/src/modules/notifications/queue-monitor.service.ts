import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import type Redis from 'ioredis';
import { AppConfigService } from '../../config/app-config.service';
import { DbContext } from '../../core/db/db-context';
import { QueueName } from '../../queues/queue.constants';
import { REDIS_CLIENT } from '../../shared/redis/redis.constants';
import type { EmailJobData } from './email-outbox.service';

/** Written by each worker every few seconds (src/worker/worker-heartbeat.ts). */
export interface WorkerHeartbeat {
  id: string;
  startedAt: string;
  beatAt: string;
  concurrency: number;
  running: boolean;
  processed: number;
  failed: number;
}

export const heartbeatKeyPrefix = (queuePrefix: string) => `${queuePrefix}:worker:heartbeat:`;

const SAMPLE = 200;

const pct = (values: number[], p: number) => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const dist = (values: number[]) => ({
  samples: values.length,
  avg: values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null,
  p50: pct(values, 0.5),
  p95: pct(values, 0.95),
  p99: pct(values, 0.99),
});

/**
 * Super Admin queue metrics. Aggregates only: counts, timings, attempt numbers and worker
 * heartbeats. Never job data, outbox payloads, recipients or failure text.
 */
@Injectable()
export class QueueMonitorService {
  private readonly heartbeatPrefix: string;

  constructor(
    @InjectQueue(QueueName.Notifications) private readonly queue: Queue<EmailJobData>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly db: DbContext,
    config: AppConfigService,
  ) {
    this.heartbeatPrefix = heartbeatKeyPrefix(config.get('QUEUE_PREFIX'));
  }

  async snapshot() {
    const [counts, completed, failed, workers, outbox] = await Promise.all([
      this.queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'prioritized'),
      this.queue.getJobs(['completed'], 0, SAMPLE - 1),
      this.queue.getJobs(['failed'], 0, SAMPLE - 1),
      this.workers(),
      this.outbox(),
    ]);
    const timed = completed.filter((j): j is Job & { processedOn: number; finishedOn: number } =>
      Boolean(j?.processedOn && j.finishedOn),
    );
    const retried = completed.filter((j) => (j?.attemptsMade ?? 0) > 1).length;
    return {
      queue: QueueName.Notifications,
      counts,
      recentCompleted: {
        processingMs: dist(timed.map((j) => j.finishedOn - j.processedOn)),
        waitMs: dist(timed.map((j) => j.processedOn - j.timestamp)),
        retried,
        retriedRatio: timed.length ? Math.round((retried / timed.length) * 1000) / 1000 : null,
      },
      recentFailed: {
        samples: failed.filter(Boolean).length,
        attempts: dist(failed.filter(Boolean).map((j) => j.attemptsMade)),
      },
      workers,
      outbox,
    };
  }

  /** Heartbeats younger than 30 s count as healthy. */
  private async workers() {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(
        cursor,
        'MATCH',
        `${this.heartbeatPrefix}*`,
        'COUNT',
        100,
      );
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    const values = keys.length ? await this.redis.mget(...keys) : [];
    const now = Date.now();
    const list = values
      .filter((v): v is string => v !== null)
      .map((v) => JSON.parse(v) as WorkerHeartbeat)
      .map((w) => ({ ...w, healthy: w.running && now - Date.parse(w.beatAt) < 30_000 }));
    return { healthy: list.filter((w) => w.healthy).length, instances: list };
  }

  private outbox() {
    return this.db.run({ platform: true }, async (db) => {
      const rows = await db.query<{ status: string; n: string }>(
        'SELECT status, count(*) AS n FROM email_outbox GROUP BY status',
      );
      const oldest = await db.one<{ age: string | null; unpublished: string }>(
        `SELECT extract(epoch FROM now() - min(created_at))::int AS age,
                count(*) FILTER (WHERE published_at IS NULL) AS unpublished
           FROM email_outbox WHERE status IN ('pending', 'processing')`,
      );
      const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
      return {
        pending: by.pending ?? 0,
        processing: by.processing ?? 0,
        sent: by.sent ?? 0,
        failed: by.failed ?? 0,
        unpublished: Number(oldest?.unpublished ?? 0),
        oldestOpenAgeSeconds:
          oldest?.age === null || oldest?.age === undefined ? null : Number(oldest.age),
      };
    });
  }
}
