import { Injectable } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { AppConfigService } from '../../config/app-config.service';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export class MailTimeoutError extends Error {
  constructor(ms: number) {
    super(`SMTP send timed out after ${ms} ms`);
    this.name = 'MailTimeoutError';
  }
}

/**
 * SMTP transport (Mailpit locally, SES SMTP in AWS). Only the email worker calls it: business
 * code queues mail through EmailOutboxService. In tests nothing leaves the process; delivered
 * messages are kept in `outbox` so tests can read links from them.
 */
@Injectable()
export class MailService {
  private readonly transport: Transporter;
  private readonly from: string;
  private readonly timeoutMs: number;
  readonly outbox: MailMessage[] = [];

  constructor(private readonly config: AppConfigService) {
    this.from = config.get('MAIL_FROM');
    this.timeoutMs = config.get('EMAIL_SEND_TIMEOUT_MS');
    const user = config.get('SMTP_USER');
    this.transport =
      config.get('NODE_ENV') === 'test'
        ? createTransport({ jsonTransport: true })
        : createTransport({
            host: config.get('SMTP_HOST'),
            port: config.get('SMTP_PORT'),
            secure: config.get('SMTP_SECURE'),
            ...(user ? { auth: { user, pass: config.get('SMTP_PASSWORD') } } : {}),
            // Socket-level bounds; the overall bound below covers everything else.
            connectionTimeout: this.timeoutMs,
            greetingTimeout: this.timeoutMs,
            socketTimeout: this.timeoutMs,
          });
  }

  /** Sends one message. Throws on failure or after EMAIL_SEND_TIMEOUT_MS (the worker retries). */
  async deliver(message: MailMessage): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new MailTimeoutError(this.timeoutMs)), this.timeoutMs);
    });
    try {
      await Promise.race([this.transport.sendMail({ from: this.from, ...message }), timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (this.config.get('NODE_ENV') === 'test') this.outbox.push(message);
  }
}
