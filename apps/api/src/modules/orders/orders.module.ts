import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { OrdersController } from './orders.controller';
import { OrderEventsService } from './order-events';
import { OrdersService } from './orders.service';
import {
  GuestSessionsController,
  GuestSessionsService,
  TableSessionsController,
} from './table-sessions';

@Module({
  imports: [AuthModule, BillingModule, PromotionsModule],
  controllers: [OrdersController, TableSessionsController, GuestSessionsController],
  providers: [OrdersService, OrderEventsService, GuestSessionsService],
})
export class OrdersModule {}
