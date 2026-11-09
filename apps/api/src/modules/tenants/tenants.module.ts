import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { BranchesController } from './branches.controller';
import { RestaurantOverviewController } from './restaurant-overview.controller';

@Module({
  imports: [AuthModule, BillingModule],
  controllers: [RestaurantOverviewController, BranchesController],
})
export class TenantsModule {}
