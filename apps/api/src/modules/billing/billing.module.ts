import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import {
  BillingController,
  BillingWebhookController,
  PlatformBillingController,
} from './billing.controller';
import { BillingService } from './billing.service';
import { PAYMENT_GATEWAY, RazorpayGateway } from './payment-gateway';
import { PlatformBillingService } from './platform-billing.service';
import { PublicPlansController } from './public-plans.controller';
import { SubscriptionExpiryScheduler } from './subscription-expiry.scheduler';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';

@Module({
  imports: [AuthModule],
  controllers: [
    BillingController,
    BillingWebhookController,
    PlatformBillingController,
    PublicPlansController,
  ],
  providers: [
    BillingService,
    PlatformBillingService,
    SubscriptionLifecycleService,
    SubscriptionExpiryScheduler,
    { provide: PAYMENT_GATEWAY, useClass: RazorpayGateway },
  ],
  exports: [SubscriptionLifecycleService],
})
export class BillingModule {}
