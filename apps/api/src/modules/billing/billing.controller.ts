import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
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
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { requestMeta } from '../../common/http/request-meta';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AuthContext } from '../auth/auth.types';
import {
  AllowAudience,
  AllowInactiveSubscription,
  CurrentAuth,
  Public,
  RequirePermission,
} from '../auth/decorators';
import {
  type AdminActivateInput,
  adminActivateSchema,
  type CheckoutFailedInput,
  checkoutFailedSchema,
  type CreatePlanInput,
  createPlanSchema,
  type ExtendTrialInput,
  extendTrialSchema,
  type InvoicesQuery,
  invoicesQuerySchema,
  type MarkPaidInput,
  markPaidSchema,
  type PlansQuery,
  plansQuerySchema,
  type PlatformInvoicesQuery,
  platformInvoicesQuerySchema,
  type PlatformSubscriptionsQuery,
  platformSubscriptionsQuerySchema,
  type RequestChangeInput,
  requestChangeSchema,
  type SuspendInput,
  suspendSchema,
  type UpdatePlanInput,
  updatePlanSchema,
  type VerifyCheckoutInput,
  verifyCheckoutSchema,
} from './billing.schemas';
import { BillingService } from './billing.service';
import { PlatformBillingService } from './platform-billing.service';

/**
 * The restaurant's subscription, plan usage and billing history. Reachable when the subscription
 * has lapsed, so an owner can always see plans and pay.
 */
@ApiTags('Billing')
@AllowInactiveSubscription()
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('entitlement')
  @ApiOperation({ summary: 'Access status, trial dates and reminders (any member)' })
  entitlement(@CurrentAuth() auth: AuthContext) {
    return this.billing.entitlement(auth);
  }

  @Post('subscription/checkout')
  @RequirePermission('restaurant:manage')
  @ApiOperation({ summary: 'Start an online payment for a plan (pending invoice + gateway order)' })
  checkout(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(requestChangeSchema)) body: RequestChangeInput,
    @Req() req: Request,
  ) {
    return this.billing.checkout(auth, body, requestMeta(req));
  }

  @Post('subscription/checkout/verify')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('restaurant:manage')
  @ApiOperation({ summary: 'Verify the gateway signature and activate the plan' })
  verify(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(verifyCheckoutSchema)) body: VerifyCheckoutInput,
    @Req() req: Request,
  ) {
    return this.billing.verifyCheckout(auth, body, requestMeta(req));
  }

  @Post('subscription/checkout/failed')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('restaurant:manage')
  @ApiOperation({ summary: 'Record a failed or abandoned payment attempt' })
  async failed(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(checkoutFailedSchema)) body: CheckoutFailedInput,
    @Req() req: Request,
  ) {
    await this.billing.checkoutFailed(auth, body, requestMeta(req));
  }

  @Get('subscription')
  @RequirePermission('restaurant:read')
  @ApiOperation({ summary: 'Current subscription, remaining days, plan usage and available plans' })
  overview(@CurrentAuth() auth: AuthContext) {
    return this.billing.overview(auth);
  }

  @Post('subscription/requests')
  @RequirePermission('restaurant:manage')
  @ApiOperation({ summary: 'Request a plan, renewal or cycle change (creates a pending invoice)' })
  request(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(requestChangeSchema)) body: RequestChangeInput,
    @Req() req: Request,
  ) {
    return this.billing.requestChange(auth, body, requestMeta(req));
  }

  @Post('invoices/:id/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('restaurant:manage')
  @ApiOperation({ summary: 'Cancel a request that is awaiting payment' })
  async cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    await this.billing.cancelPending(auth, id, requestMeta(req));
  }

  @Get('invoices')
  @RequirePermission('restaurant:read')
  @ApiOperation({ summary: 'Billing history, paged' })
  invoices(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(invoicesQuerySchema)) query: InvoicesQuery,
  ) {
    return this.billing.invoices(auth, query);
  }
}

/** Payment gateway callbacks: no session, authenticated by the gateway's HMAC signature. */
@ApiTags('Billing')
@Public()
@Controller('billing/webhooks')
export class BillingWebhookController {
  constructor(private readonly billing: BillingService) {}

  @Post('razorpay')
  @HttpCode(HttpStatus.OK)
  @RawResponse()
  @ApiOperation({ summary: 'Razorpay payment webhook' })
  async razorpay(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-razorpay-signature') signature: string | undefined,
    @Headers('x-razorpay-event-id') eventId: string | undefined,
  ) {
    await this.billing.webhook(req.rawBody, signature ?? '', eventId ?? '');
    return { ok: true };
  }
}

/** Super Admin: plan catalogue, payment verification and subscription controls. */
@ApiTags('Platform billing')
@AllowAudience('platform')
@Controller('platform/billing')
export class PlatformBillingController {
  constructor(private readonly billing: PlatformBillingService) {}

  @Get('plans')
  @RequirePermission('platform:billing_manage')
  @ApiOperation({ summary: 'All plans, including inactive ones' })
  plans(@CurrentAuth() auth: AuthContext) {
    return this.billing.listPlans(auth);
  }

  @Get('plans/page')
  @RequirePermission('platform:billing_manage')
  @ApiOperation({ summary: 'Plans for the admin table: search, filter, sort, paged' })
  plansPage(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(plansQuerySchema)) query: PlansQuery,
  ) {
    return this.billing.plansPage(auth, query);
  }

  @Get('plans/:id')
  @RequirePermission('platform:billing_manage')
  @ApiOperation({ summary: 'One plan, including internal notes' })
  plan(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.billing.plan(auth, id);
  }

  @Post('plans/:id/duplicate')
  @RequirePermission('platform:billing_manage')
  @ApiOperation({ summary: 'Copy a plan as a hidden, inactive draft' })
  duplicatePlan(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.billing.duplicatePlan(auth, id, requestMeta(req));
  }

  @Post('plans')
  @RequirePermission('platform:billing_manage')
  @ApiOperation({ summary: 'Create a plan' })
  createPlan(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createPlanSchema)) body: CreatePlanInput,
    @Req() req: Request,
  ) {
    return this.billing.createPlan(auth, body, requestMeta(req));
  }

  @Patch('plans/:id')
  @RequirePermission('platform:billing_manage')
  @ApiOperation({ summary: 'Edit a plan (price changes apply to new invoices only)' })
  updatePlan(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updatePlanSchema)) body: UpdatePlanInput,
    @Req() req: Request,
  ) {
    return this.billing.updatePlan(auth, id, body, requestMeta(req));
  }

  @Post('plans/:id/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('platform:billing_manage')
  @ApiOperation({ summary: 'Archive a plan (hidden from new customers; subscribers keep terms)' })
  archivePlan(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.billing.archivePlan(auth, id, requestMeta(req));
  }

  @Post('plans/:id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('platform:billing_manage')
  @ApiOperation({ summary: 'Restore an archived plan (as inactive and hidden)' })
  restorePlan(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.billing.restorePlan(auth, id, requestMeta(req));
  }

  @Delete('plans/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('platform:billing_manage')
  @ApiOperation({ summary: 'Delete a never-used plan (409 PLAN_IN_USE otherwise: archive it)' })
  async deletePlan(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    await this.billing.deletePlan(auth, id, requestMeta(req));
  }

  @Get('invoices')
  @RequirePermission('platform:billing_manage')
  @ApiOperation({ summary: 'Subscription invoices across restaurants, paged' })
  invoices(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(platformInvoicesQuerySchema)) query: PlatformInvoicesQuery,
  ) {
    return this.billing.invoices(auth, query);
  }

  @Post('invoices/:id/mark-paid')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('platform:billing_manage')
  @ApiOperation({ summary: 'Record a verified payment and start or extend the subscription' })
  markPaid(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(markPaidSchema)) body: MarkPaidInput,
    @Req() req: Request,
  ) {
    return this.billing.markPaid(auth, id, body, requestMeta(req));
  }

  @Post('invoices/:id/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('platform:billing_manage')
  @ApiOperation({ summary: 'Cancel a pending invoice' })
  async cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    await this.billing.cancelInvoice(auth, id, requestMeta(req));
  }

  @Get('subscriptions')
  @RequirePermission('platform:billing_manage')
  @ApiOperation({ summary: 'Restaurant subscriptions (trials, active, expired, ...), paged' })
  subscriptions(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(platformSubscriptionsQuerySchema))
    query: PlatformSubscriptionsQuery,
  ) {
    return this.billing.subscriptions(auth, query);
  }

  @Get('subscriptions/:tenantId')
  @RequirePermission('platform:billing_manage')
  @ApiOperation({ summary: 'One subscription with status history and payments' })
  subscription(
    @CurrentAuth() auth: AuthContext,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
  ) {
    return this.billing.subscription(auth, tenantId);
  }

  @Post('subscriptions/:tenantId/extend-trial')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('platform:billing_manage')
  @ApiOperation({ summary: 'Extend or restart the free trial' })
  extendTrial(
    @CurrentAuth() auth: AuthContext,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body(new ZodValidationPipe(extendTrialSchema)) body: ExtendTrialInput,
    @Req() req: Request,
  ) {
    return this.billing.extendTrial(auth, tenantId, body, requestMeta(req));
  }

  @Post('subscriptions/:tenantId/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('platform:billing_manage')
  @ApiOperation({ summary: 'Grant a plan for one billing cycle without payment' })
  activate(
    @CurrentAuth() auth: AuthContext,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body(new ZodValidationPipe(adminActivateSchema)) body: AdminActivateInput,
    @Req() req: Request,
  ) {
    return this.billing.activate(auth, tenantId, body, requestMeta(req));
  }

  @Post('subscriptions/:tenantId/suspend')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('platform:billing_manage')
  @ApiOperation({ summary: 'Suspend the subscription (blocks operations; data is kept)' })
  suspend(
    @CurrentAuth() auth: AuthContext,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body(new ZodValidationPipe(suspendSchema)) body: SuspendInput,
    @Req() req: Request,
  ) {
    return this.billing.suspend(auth, tenantId, body, requestMeta(req));
  }

  @Post('subscriptions/:tenantId/reinstate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('platform:billing_manage')
  @ApiOperation({ summary: 'Lift a suspension' })
  reinstate(
    @CurrentAuth() auth: AuthContext,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Req() req: Request,
  ) {
    return this.billing.reinstate(auth, tenantId, requestMeta(req));
  }
}
