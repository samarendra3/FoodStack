import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { requestMeta } from '../../common/http/request-meta';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AuthContext } from '../auth/auth.types';
import {
  AllowAudience,
  AllowInactiveSubscription,
  CurrentAuth,
  RequirePermission,
} from '../auth/decorators';
import {
  type AddonsQuery,
  addonsQuerySchema,
  type CreateAddonInput,
  createAddonSchema,
  type RefundInput,
  refundSchema,
  type UpdateAddonInput,
  updateAddonSchema,
} from './addons.schemas';
import { AddonsService } from './addons.service';
import { BillingService } from './billing.service';

/**
 * Restaurant add-on marketplace. Reachable at the limit (and with a lapsed plan, so the screen
 * can explain that the plan must be renewed first).
 */
@ApiTags('Billing')
@AllowInactiveSubscription()
@Controller('billing')
export class AddonsController {
  constructor(
    private readonly addons: AddonsService,
    private readonly billing: BillingService,
  ) {}

  @Get('addons')
  @RequirePermission('restaurant:read')
  @ApiOperation({ summary: 'Add-ons on sale, purchased packs and the monthly order allowance' })
  marketplace(@CurrentAuth() auth: AuthContext) {
    return this.addons.marketplace(auth);
  }

  @Get('usage')
  @RequirePermission('restaurant:read')
  @ApiOperation({ summary: 'Monthly order allowance and warning level (for the usage banner)' })
  usage(@CurrentAuth() auth: AuthContext) {
    return this.addons.usageSummary(auth);
  }

  @Post('addons/:id/requests')
  @RequirePermission('restaurant:manage')
  @ApiOperation({ summary: 'Request an add-on (pending invoice; granted only after payment)' })
  request(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.addons.request(auth, id, requestMeta(req));
  }

  @Post('invoices/:id/checkout')
  @RequirePermission('restaurant:manage')
  @ApiOperation({ summary: 'Pay a pending request online (gateway order for its server amount)' })
  checkout(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.billing.checkoutInvoice(auth, id);
  }
}

/** Super Admin: add-on catalogue and refunds. */
@ApiTags('Platform billing')
@AllowAudience('platform')
@Controller('platform/billing')
export class PlatformAddonsController {
  constructor(private readonly addons: AddonsService) {}

  @Get('addons')
  @RequirePermission('platform:billing_manage')
  @ApiOperation({ summary: 'Add-on packages: search, filter, sort, paged' })
  page(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(addonsQuerySchema)) query: AddonsQuery,
  ) {
    return this.addons.page(auth, query);
  }

  @Post('addons')
  @RequirePermission('platform:billing_manage')
  @ApiOperation({ summary: 'Create an add-on package' })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createAddonSchema)) body: CreateAddonInput,
    @Req() req: Request,
  ) {
    return this.addons.create(auth, body, requestMeta(req));
  }

  @Patch('addons/:id')
  @RequirePermission('platform:billing_manage')
  @ApiOperation({ summary: 'Edit an add-on (applies to new purchases only)' })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateAddonSchema)) body: UpdateAddonInput,
    @Req() req: Request,
  ) {
    return this.addons.update(auth, id, body, requestMeta(req));
  }

  @Post('addons/:id/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('platform:billing_manage')
  @ApiOperation({ summary: 'Archive an add-on (purchased packs stay valid until they expire)' })
  archive(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.addons.archive(auth, id, requestMeta(req));
  }

  @Post('addons/:id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('platform:billing_manage')
  @ApiOperation({ summary: 'Restore an archived add-on (as disabled)' })
  restore(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.addons.restore(auth, id, requestMeta(req));
  }

  @Post('invoices/:id/refund')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('platform:billing_manage')
  @ApiOperation({ summary: 'Refund a paid add-on and revoke its capacity' })
  refund(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(refundSchema)) body: RefundInput,
    @Req() req: Request,
  ) {
    return this.addons.refund(auth, id, body.reason, requestMeta(req));
  }
}
