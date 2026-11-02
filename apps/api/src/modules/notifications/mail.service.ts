import { Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { AppConfigService } from '../../config/app-config.service';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Sends email over SMTP (Mailpit locally, SES SMTP in AWS). In tests nothing leaves the process:
 * messages are kept in `outbox` so tests can read links from them.
 *
 * Sent inline for now; moving delivery onto the BullMQ notifications queue (design D5) only
 * changes this class.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transport: Transporter;
  private readonly from: string;
  readonly outbox: MailMessage[] = [];

  constructor(private readonly config: AppConfigService) {
    this.from = config.get('MAIL_FROM');
    const user = config.get('SMTP_USER');
    this.transport =
      config.get('NODE_ENV') === 'test'
        ? createTransport({ jsonTransport: true })
        : createTransport({
            host: config.get('SMTP_HOST'),
            port: config.get('SMTP_PORT'),
            secure: config.get('SMTP_SECURE'),
            ...(user ? { auth: { user, pass: config.get('SMTP_PASSWORD') } } : {}),
          });
  }

  /** Never throws: a mail outage must not turn into an account-enumeration signal. */
  async send(message: MailMessage): Promise<void> {
    if (this.config.get('NODE_ENV') === 'test') this.outbox.push(message);
    try {
      await this.transport.sendMail({ from: this.from, ...message });
    } catch (error) {
      this.logger.error(`Email to recipient failed: ${(error as Error).message}`);
    }
  }
}
