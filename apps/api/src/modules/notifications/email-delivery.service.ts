import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { DbContext } from '../../core/db/db-context';
import { type EmailJobData, EmailOutboxService, outboxScope } from './email-outbox.service';
import { MailService } from './mail.service';

/** The row is gone or belongs to another tenant than the job claims: never retried. */
export class EmailOwnershipError extends Error {
  constructor() {
    super('Outbox row not found in the job tenant scope');
    this.name = 'EmailOwnershipError';
  }
}

/** Another worker holds the row (claim not expired): retry later. */
export class EmailBusyError extends Error {
  constructor() {
    super('Outbox row is being processed by another worker');
    this.name = 'EmailBusyError';
  }
}

/** A sanitized delivery failure: safe to store and log (no address, subject or body). */
export class EmailDeliveryError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'EmailDeliveryError';
  }
}

export type DeliveryResult = 'sent' | 'already_sent' | 'already_failed';

/**
 * Error description without SMTP server text, which can echo the recipient address.
 * Examples: "MailTimeoutError", "Error:ECONNREFUSED", "Error:EENVELOPE:550".
 */
export function describeMailError(error: unknown): string {
  const e = error as { name?: string; code?: string; responseCode?: number };
  return [e?.name ?? 'Error', e?.code, e?.responseCode].filter(Boolean).join(':').slice(0, 120);
}

/**
 * Consumer side of the outbox: claim → decrypt → send → mark sent. Used by the BullMQ worker
 * (and by tests and operators to drain the outbox synchronously, same code path).
 *
 * Idempotency: a row is claimed with one conditional UPDATE (pending, or processing with an
 * expired claim). A row already `sent` is never sent again. The one unavoidable duplicate: the
 * SMTP server accepted the message and the worker died before recording `sent`; after the claim
 * expires the email is sent again (at-least-once, not exactly-once).
 */
@Injectable()
export class EmailDeliveryService {
  private readonly logger = new Logger('EmailDelivery');
  private readonly claimSeconds: number;

  constructor(
    private readonly db: DbContext,
    private readonly outbox: EmailOutboxService,
    private readonly mail: MailService,
    config: AppConfigService,
  ) {
    // Long enough for one send attempt plus bookkeeping; a crashed worker's claim expires after it.
    this.claimSeconds = Math.ceil((config.get('EMAIL_SEND_TIMEOUT_MS') * 2) / 1000) + 30;
  }

  async deliver(job: EmailJobData, opts: { finalAttempt: boolean }): Promise<DeliveryResult> {
    const scope = outboxScope(job.tenantId);
    // Ownership: the row must belong to exactly the tenant the job names (RLS + explicit filter).
    const owner = (n: number) => (job.tenantId ? `tenant_id = $${n}` : 'tenant_id IS NULL');
    const ownerParam = job.tenantId ? [job.tenantId] : [];
    const claimed = await this.db.run(scope, (db) =>
      db.one<{ payload: Buffer; kind: string; attempts: number }>(
        `UPDATE email_outbox
            SET status = 'processing', attempts = attempts + 1,
                locked_until = now() + make_interval(secs => $2)
          WHERE id = $1 AND ${owner(3)}
            AND (status = 'pending' OR (status = 'processing' AND locked_until < now()))
          RETURNING payload, kind, attempts`,
        [job.outboxId, this.claimSeconds, ...ownerParam],
      ),
    );
    if (!claimed) {
      const row = await this.db.run(scope, (db) =>
        db.one<{ status: string }>(
          `SELECT status FROM email_outbox WHERE id = $1 AND ${owner(2)}`,
          [job.outboxId, ...ownerParam],
        ),
      );
      if (!row) throw new EmailOwnershipError();
      if (row.status === 'sent') return 'already_sent';
      if (row.status === 'failed') return 'already_failed';
      throw new EmailBusyError();
    }

    try {
      await this.mail.deliver(this.outbox.decrypt(claimed.payload));
    } catch (error) {
      const reason = describeMailError(error);
      await this.db.run(scope, (db) =>
        opts.finalAttempt
          ? db.query(
              `UPDATE email_outbox SET status = 'failed', failed_at = now(), payload = NULL,
                      locked_until = NULL, last_error = $2
                WHERE id = $1 AND status = 'processing'`,
              [job.outboxId, reason],
            )
          : db.query(
              `UPDATE email_outbox SET status = 'pending', locked_until = NULL, last_error = $2
                WHERE id = $1 AND status = 'processing'`,
              [job.outboxId, reason],
            ),
      );
      if (opts.finalAttempt) {
        this.logger.error(
          `Email ${job.outboxId} (${claimed.kind}) failed permanently after ${claimed.attempts} attempts: ${reason}`,
        );
      }
      throw new EmailDeliveryError(reason);
    }

    // Delivered: erase the payload (recipient, links, tokens) and record it.
    await this.db.run(scope, (db) =>
      db.query(
        `UPDATE email_outbox SET status = 'sent', sent_at = now(), payload = NULL,
                locked_until = NULL, last_error = NULL
          WHERE id = $1 AND status = 'processing'`,
        [job.outboxId],
      ),
    );
    return 'sent';
  }

  /**
   * Delivers every pending row now, in this process (tests, and operators without a worker).
   * Same claim/send/mark path as the worker; failures leave rows for the worker to retry.
   */
  async deliverPending(limit = 500): Promise<{ sent: number; failed: number }> {
    const rows = await this.db.run({ platform: true }, (db) =>
      db.query<{ id: string; tenant_id: string | null }>(
        `SELECT id, tenant_id FROM email_outbox WHERE status = 'pending'
          ORDER BY created_at LIMIT $1`,
        [limit],
      ),
    );
    let sent = 0;
    let failed = 0;
    for (const r of rows) {
      try {
        if (
          (await this.deliver(
            { outboxId: r.id, tenantId: r.tenant_id },
            { finalAttempt: false },
          )) === 'sent'
        )
          sent++;
      } catch {
        failed++;
      }
    }
    return { sent, failed };
  }
}
