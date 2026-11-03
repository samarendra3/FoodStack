import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import { type InventoryReportQuery, inventoryReportQuerySchema } from './reports.schemas';
import { ReportsService } from './reports.service';

/** Business reports. ReportsService checks `report:view` for the exact branch. */
@ApiTags('Reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('inventory')
  @RequirePermission('report:view')
  @ApiOperation({ summary: 'Stock in, usage, wastage and valuation for a branch and date range' })
  inventory(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(inventoryReportQuerySchema)) query: InventoryReportQuery,
  ) {
    return this.reports.inventory(auth, query);
  }
}
