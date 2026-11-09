import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FinanceController, FinanceService } from './finance';
import { FloorController, FloorService } from './floor';
import { MenuExtrasController, MenuExtrasService } from './menu-extras';
import { OpsBase } from './ops-base';
import { PeopleController, PeopleService } from './people';
import { PublicMenuController, QrCodesController } from './public-menu';
import { ProcurementController, ProcurementService } from './procurement';
import { SetupController, SetupService } from './setup';

/** Restaurant operations: finance, procurement, floor, menu extras, people and setup. */
@Module({
  imports: [AuthModule],
  controllers: [
    FinanceController,
    ProcurementController,
    FloorController,
    MenuExtrasController,
    PeopleController,
    SetupController,
    PublicMenuController,
    QrCodesController,
  ],
  providers: [
    OpsBase,
    FinanceService,
    ProcurementService,
    FloorService,
    MenuExtrasService,
    PeopleService,
    SetupService,
  ],
})
export class OpsModule {}
