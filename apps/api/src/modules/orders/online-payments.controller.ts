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
  Put,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';
import { requestMeta } from '../../common/http/request-meta';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth, Public, RequirePermission } from '../auth/decorators';
import {
  BillingDeskService,
  billingListSchema,
  reconciliationSchema,
  resolveSchema,
} from './billing-desk';
import { OnlinePaymentsService } from './online-payments';

export { BillingDeskService, OnlinePaymentsService };

const restaurantQuery = z.strictObject({ restaurantId: z.uuid() });
const connectSchema = z.strictObject({
  restaurantId: z.uuid(),
  keyId: z.string().trim().min(8).max(64),
  keySecret: z.string().trim().min(8).max(128),
  webhookSecret: z.string().trim().min(8).max(128),
});

/**
 * Restaurant-owned online payments: connect the restaurant's Razorpay account (restaurant
 * settings) and receive its signed webhooks. Guest payment endpoints live with the guest flow.
 */
@ApiTags('Online payments')
@Controller()
export class OnlinePaymentsController {
  constructor(
    private readonly payments: OnlinePaymentsService,
    private readonly desk: BillingDeskService,
  ) {}

  // ---- billing desk ----

  @Get('billing/bills')
  @RequirePermission('menu:read')
  @ApiOperation({ summary: 'Bills of a branch and day by payment status, with totals' })
  bills(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(billingListSchema)) q: z.infer<typeof billingListSchema>,
  ) {
    return this.desk.list(auth, q);
  }

  @Get('billing/reconciliation')
  @RequirePermission('menu:read')
  @ApiOperation({ summary: 'Collections by method, refunds, review queue and integrity checks' })
  reconciliation(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(reconciliationSchema)) q: z.infer<typeof reconciliationSchema>,
  ) {
    return this.desk.reconciliation(auth, q);
  }

  @Post('billing/payment-reviews/:intentId/resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('order:refund')
  @ApiOperation({ summary: 'Close an online payment parked for review (after handling it)' })
  resolve(
    @CurrentAuth() auth: AuthContext,
    @Param('intentId', ParseUUIDPipe) intentId: string,
    @Body(new ZodValidationPipe(resolveSchema)) body: z.infer<typeof resolveSchema>,
    @Req() req: Request,
  ) {
    return this.desk.resolveReview(auth, intentId, body.note, requestMeta(req));
  }

  @Get('payments/gateway-account')
  @RequirePermission('restaurant:manage')
  @ApiOperation({ summary: "The restaurant's connected payment gateway (no secrets)" })
  account(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(restaurantQuery)) q: z.infer<typeof restaurantQuery>,
  ) {
    return this.payments.getAccount(auth, q.restaurantId);
  }

  @Put('payments/gateway-account')
  @RequirePermission('restaurant:manage')
  @ApiOperation({ summary: "Connect the restaurant's own Razorpay account (keys are verified)" })
  connect(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(connectSchema)) body: z.infer<typeof connectSchema>,
    @Req() req: Request,
  ) {
    return this.payments.connect(auth, body, requestMeta(req));
  }

  @Delete('payments/gateway-account')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('restaurant:manage')
  @ApiOperation({ summary: 'Turn off online payments for the restaurant' })
  async disconnect(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(restaurantQuery)) q: z.infer<typeof restaurantQuery>,
    @Req() req: Request,
  ) {
    await this.payments.disconnect(auth, q.restaurantId, requestMeta(req));
  }

  @Post('public/payments/razorpay/:webhookKey')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiOperation({ summary: "Razorpay webhook for one restaurant's account (signed)" })
  webhook(
    @Param('webhookKey') webhookKey: string,
    @Headers('x-razorpay-signature') signature: string | undefined,
    @Headers('x-razorpay-event-id') eventId: string | undefined,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    return this.payments.webhook(
      webhookKey,
      req.rawBody,
      signature ?? '',
      eventId ?? '',
      requestMeta(req),
    );
  }
}
