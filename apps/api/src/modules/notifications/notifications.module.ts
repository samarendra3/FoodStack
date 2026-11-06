import { Global, Module } from '@nestjs/common';
import { DbContext } from '../../core/db/db-context';
import { EmailDeliveryService } from './email-delivery.service';
import { EmailOutboxService } from './email-outbox.service';
import { MailService } from './mail.service';
import { QueueMonitorService } from './queue-monitor.service';

/**
 * Email: EmailOutboxService (producer, used by business code inside its transactions),
 * EmailDeliveryService (consumer logic, run by the worker), MailService (SMTP transport) and
 * QueueMonitorService (Super Admin metrics). The BullMQ worker itself lives in src/worker.
 */
@Global()
@Module({
  providers: [
    DbContext,
    MailService,
    EmailOutboxService,
    EmailDeliveryService,
    QueueMonitorService,
  ],
  exports: [DbContext, MailService, EmailOutboxService, EmailDeliveryService, QueueMonitorService],
})
export class NotificationsModule {}
