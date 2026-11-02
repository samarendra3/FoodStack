import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RestaurantOverviewController } from './restaurant-overview.controller';

@Module({
  imports: [AuthModule],
  controllers: [RestaurantOverviewController],
})
export class TenantsModule {}
