import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import { AppConfigService } from '../config/app-config.service';
import {
  type DeliveryResult,
  describeMailError,
  EmailBusyError,
  EmailDeliveryError,
  EmailDeliveryService,
  EmailOwnershipError,
} from '../modules/notifications/email-delivery.service';
import type { EmailJobData } from '../modules/notifications/email-outbox.service';
import { EMAIL_JOB, QueueName } from '../queues/queue.constants';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The one email worker. A job carries only { outboxId, tenantId }; EmailDeliveryService loads
 * the row under that tenant's RLS scope (or the platform scope for untenanted mail), so a job
 * naming the wrong tenant finds nothing and fails without retry.
 *
 * Stalled jobs (worker crashed or was killed mid-job) are re-run by BullMQ after the lock
 * expires; the outbox claim and "sent" check make the re-run safe.
 */
@Processor(QueueName.Notifications, {
  lockDuration: 60_000,
  stalledInterval: 30_000,
  maxStalledCount: 2,
})
export class EmailProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger('EmailWorker');
  processed = 0;
  failed = 0;

  constructor(
    private readonly delivery: EmailDeliveryService,
    private readonly config: AppConfigService,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    this.worker.concurrency = this.config.get('EMAIL_WORKER_CONCURRENCY');
    this.logger.log(`Email worker started (concurrency ${this.worker.concurrency})`);
  }

  async process(job: Job<EmailJobData>): Promise<DeliveryResult> {
    const { outboxId, tenantId } = job.data ?? ({} as EmailJobData);
    const valid =
      job.name === EMAIL_JOB &&
      UUID.test(outboxId ?? '') &&
      (tenantId === null || UUID.test(tenantId ?? ''));
    if (!valid) throw new UnrecoverableError('Malformed email job');
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    try {
      return await this.delivery.deliver({ outboxId, tenantId }, { finalAttempt });
    } catch (error) {
      if (error instanceof EmailOwnershipError) throw new UnrecoverableError(error.message);
      if (error instanceof EmailDeliveryError || error instanceof EmailBusyError) throw error;
      // Database or other errors: keep only a sanitized description in the job record.
      throw new Error(describeMailError(error));
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(): void {
    this.processed++;
  }

  /** Job id, attempt and sanitized reason only: no recipient, subject or body. */
  @OnWorkerEvent('failed')
  onFailed(job: Job<EmailJobData> | undefined, error: Error): void {
    this.failed++;
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    const final = job.attemptsMade >= attempts || error instanceof UnrecoverableError;
    const line = `Email job ${job.id} attempt ${job.attemptsMade}/${attempts} failed: ${error.message}`;
    if (final) this.logger.error(line);
    else this.logger.warn(line);
  }
}
