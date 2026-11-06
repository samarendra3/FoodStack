import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { AppConfigService } from '../config/app-config.service';
import { DbContext } from '../core/db/db-context';
import {
  type EmailJobData,
  EmailOutboxService,
} from '../modules/notifications/email-outbox.service';
import { QueueName } from '../queues/queue.constants';

/** Job states in which the job will still run: leave those alone. */
const LIVE = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children', 'paused']);
const BATCH = 200;

export interface RecoveryResult {
  locked: boolean;
  republished: number;
  deleted: number;
  skipped: number;
}

/**
 * Periodic outbox recovery in the worker (advisory-locked: one instance at a time):
 * - publishes rows that never reached the queue (Redis down at commit, API crashed after commit);
 * - re-publishes rows whose job is gone or finished while the row is still open (a crash between
 *   sending and recording, a "busy" job that exhausted its attempts);
 * - deletes closed rows after their retention period (their payloads are already erased).
 */
@Injectable()
export class OutboxRecoveryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('OutboxRecovery');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @InjectQueue(QueueName.Notifications) private readonly queue: Queue<EmailJobData>,
    private readonly db: DbContext,
    private readonly outbox: EmailOutboxService,
    private readonly config: AppConfigService,
  ) {}

  onApplicationBootstrap(): void {
    const seconds = this.config.get('OUTBOX_RECOVERY_INTERVAL_SECONDS');
    if (!seconds) return;
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    this.timer.unref();
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.runOnce();
      if (r.republished || r.deleted) {
        this.logger.log(`Recovered ${r.republished} email(s), removed ${r.deleted} closed row(s)`);
      }
    } catch (error) {
      this.logger.error(`Outbox recovery failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** One pass. Does nothing if another instance holds the lock. */
  async runOnce(): Promise<RecoveryResult> {
    const stale = this.config.get('OUTBOX_STALE_SECONDS');
    const unpublishedAfter = Math.min(5, stale);
    return this.db.run({ platform: true }, async (db) => {
      const lock = await db.one<{ ok: boolean }>(
        `SELECT pg_try_advisory_xact_lock(hashtext('foodstack.email_outbox_recovery')) AS ok`,
      );
      if (!lock?.ok) return { locked: false, republished: 0, deleted: 0, skipped: 0 };

      const deleted = await db.query<{ id: string }>(
        `DELETE FROM email_outbox
          WHERE (status = 'sent' AND sent_at < now() - make_interval(days => $1))
             OR (status = 'failed' AND failed_at < now() - make_interval(days => $2))
          RETURNING id`,
        [
          this.config.get('OUTBOX_SENT_RETENTION_DAYS'),
          this.config.get('OUTBOX_FAILED_RETENTION_DAYS'),
        ],
      );

      const rows = await db.query<{ id: string; tenant_id: string | null }>(
        `SELECT id, tenant_id FROM email_outbox
          WHERE (status = 'pending' AND published_at IS NULL
                 AND created_at < now() - make_interval(secs => $1))
             OR (status = 'pending' AND published_at IS NOT NULL
                 AND updated_at < now() - make_interval(secs => $2))
             OR (status = 'processing' AND locked_until < now())
          ORDER BY available_at LIMIT $3`,
        [unpublishedAfter, stale, BATCH],
      );
      let republished = 0;
      let skipped = 0;
      for (const row of rows) {
        const job = await this.queue.getJob(row.id);
        if (job) {
          if (LIVE.has(await job.getState())) {
            skipped++;
            continue;
          }
          await job.remove().catch(() => undefined);
        }
        if (await this.outbox.publish({ outboxId: row.id, tenantId: row.tenant_id })) {
          republished++;
        } else {
          break; // Redis still unavailable: the next pass tries again
        }
      }
      return { locked: true, republished, deleted: deleted.length, skipped };
    });
  }
}
