import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import {
  type AnalyticsQuery,
  analyticsQuerySchema,
  type MenuAnalyticsQuery,
  menuAnalyticsQuerySchema,
} from './analytics.schemas';
import { AnalyticsService } from './analytics.service';

/**
 * Sales analytics. The guard checks that the caller holds `report:view` somewhere; the service
 * then checks it for every branch it reads (Branch Managers get their branches only).
 */
@ApiTags('Analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('summary')
  @RequirePermission('report:view')
  @ApiOperation({
    summary: 'KPI cards, revenue breakdown, order status, channel and payment splits',
  })
  summary(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(analyticsQuerySchema)) query: AnalyticsQuery,
  ) {
    return this.analytics.summary(auth, query);
  }

  @Get('trend')
  @RequirePermission('report:view')
  @ApiOperation({ summary: 'Revenue and order trend in local-time buckets' })
  trend(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(analyticsQuerySchema)) query: AnalyticsQuery,
  ) {
    return this.analytics.trend(auth, query);
  }

  @Get('menu')
  @RequirePermission('report:view')
  @ApiOperation({ summary: 'Top, best and low performing items, categories, paged item table' })
  menu(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(menuAnalyticsQuerySchema)) query: MenuAnalyticsQuery,
  ) {
    return this.analytics.menu(auth, query);
  }

  @Get('customers')
  @RequirePermission('report:view')
  @ApiOperation({ summary: 'Identified customers: new, returning, repeat rate, average spend' })
  customers(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(analyticsQuerySchema)) query: AnalyticsQuery,
  ) {
    return this.analytics.customers(auth, query);
  }

  @Get('branches')
  @RequirePermission('report:view')
  @ApiOperation({ summary: 'Per-branch revenue, orders and average order value, ranked' })
  branches(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(analyticsQuerySchema)) query: AnalyticsQuery,
  ) {
    return this.analytics.branches(auth, query);
  }
}
