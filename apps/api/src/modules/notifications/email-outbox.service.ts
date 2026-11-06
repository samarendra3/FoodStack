import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';
import { AppConfigService } from '../../config/app-config.service';
import { type Db, DbContext, type DbScope } from '../../core/db/db-context';
import { decryptSecret, encryptSecret } from '../../core/security/crypto';
import { EMAIL_JOB, QueueName } from '../../queues/queue.constants';
import type { MailMessage } from './mail.service';

/** What a job carries: a reference only. The message itself stays encrypted in PostgreSQL. */
export interface EmailJobData {
  outboxId: string;
  tenantId: string | null;
}

/** Stable identifiers for the kind of email (metrics and support; never the content). */
export type EmailKind =
  | 'auth.password_reset'
  | 'auth.account_locked'
  | 'team.invitation'
  | 'access_request.received'
  | 'access_request.approved'
  | 'access_request.rejected';

/** Bound on `queue.add` while Redis is unreachable; the recovery pass publishes later. */
const PUBLISH_TIMEOUT_MS = 3_000;

/** Transaction scope that can see an outbox row: its tenant, or the platform for untenanted mail. */
export function outboxScope(tenantId: string | null): DbScope {
  return tenantId ? { tenantId } : { platform: true };
}

/**
 * Producer side of the transactional email outbox (docs/PHASE_5_BULLMQ_REPORT.md).
 *
 * `queue()` inserts the encrypted message in the caller's transaction, so it commits or rolls
 * back with the business change. After COMMIT the row is published to BullMQ with
 * `jobId = outbox id` (BullMQ ignores a second add with the same id). If Redis is down the row
 * simply stays unpublished and the worker's recovery pass publishes it later.
 */
@Injectable()
export class EmailOutboxService {
  private readonly logger = new Logger('EmailOutbox');
  private readonly key: Buffer | undefined;
  private readonly jobOptions: JobsOptions;
  private publishFailing = false;

  constructor(
    @InjectQueue(QueueName.Notifications) private readonly bull: Queue<EmailJobData>,
    private readonly db: DbContext,
    config: AppConfigService,
  ) {
    const key = config.get('MFA_ENCRYPTION_KEY');
    this.key = key ? Buffer.from(key, 'base64') : undefined;
    this.jobOptions = {
      attempts: config.get('EMAIL_MAX_ATTEMPTS'),
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { age: 24 * 3600, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 3600, count: 5_000 },
    };
  }

  /**
   * Queues `message` inside `db`'s transaction. `tenantId` must come from the server-side
   * context of that transaction (never from request input); null for account/platform mail.
   */
  async queue(
    db: Db,
    kind: EmailKind,
    message: MailMessage,
    tenantId: string | null,
  ): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO email_outbox (id, tenant_id, kind, payload) VALUES ($1, $2, $3, $4)`,
      [id, tenantId, kind, this.encrypt(message)],
    );
    // Not awaited: publishing must never delay or fail the committed request.
    db.afterCommit(`email-outbox:${id}`, () => {
      void this.publish({ outboxId: id, tenantId });
    });
    return id;
  }

  /** Adds the job (idempotent by job id) and records publication. False when Redis is unavailable. */
  async publish(data: EmailJobData): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.bull.add(EMAIL_JOB, data, { ...this.jobOptions, jobId: data.outboxId }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('queue unavailable')), PUBLISH_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
    } catch (error) {
      if (!this.publishFailing) {
        this.publishFailing = true;
        this.logger.warn(
          `Email publishing paused (${(error as Error).message}); the outbox keeps it for recovery`,
        );
      }
      return false;
    } finally {
      clearTimeout(timer);
    }
    if (this.publishFailing) {
      this.publishFailing = false;
      this.logger.log('Email publishing resumed');
    }
    await this.db
      .run(outboxScope(data.tenantId), (db) =>
        db.query(
          `UPDATE email_outbox SET published_at = coalesce(published_at, now()) WHERE id = $1`,
          [data.outboxId],
        ),
      )
      .catch(() => undefined); // only bookkeeping: recovery re-checks the queue itself
    return true;
  }

  encrypt(message: MailMessage): Buffer {
    return encryptSecret(JSON.stringify(message), this.requireKey());
  }

  decrypt(payload: Buffer): MailMessage {
    return JSON.parse(decryptSecret(payload, this.requireKey())) as MailMessage;
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new InternalServerErrorException(
        'MFA_ENCRYPTION_KEY is not configured; it also encrypts queued email (pnpm --filter @foodstack/api keys:generate)',
      );
    }
    return this.key;
  }
}
