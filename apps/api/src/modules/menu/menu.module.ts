import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { MenuController } from './menu.controller';
import { MenuImagesController } from './menu-images.controller';
import { MenuService } from './menu.service';

@Module({
  imports: [AuthModule, BillingModule],
  controllers: [MenuController, MenuImagesController],
  providers: [MenuService],
})
export class MenuModule {}
