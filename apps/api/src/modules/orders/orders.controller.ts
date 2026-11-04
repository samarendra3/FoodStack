import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { requestMeta } from '../../common/http/request-meta';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import {
  type CreateOrderInput,
  createOrderSchema,
  type KitchenQuery,
  kitchenQuerySchema,
  type KitchenStatusInput,
  kitchenStatusSchema,
  type ListOrdersQuery,
  type ListPaymentsQuery,
  listOrdersSchema,
  listPaymentsSchema,
  type PaymentInput,
  paymentSchema,
  type ReasonInput,
  type RefundInput,
  reasonSchema,
  refundSchema,
} from './orders.schemas';
import { OrdersService } from './orders.service';

const idempotencyKey = (v: string | undefined) => (v && /^[A-Za-z0-9_-]{8,80}$/.test(v) ? v : null);

/**
 * Orders, bills and payments. The decorators check a permission exists in some scope; the
 * service checks the exact branch (pos/waiter/kds access, order:void, order:refund).
 */
@ApiTags('Orders')
@Controller()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post('orders')
  @RequirePermission('menu:read')
  @ApiOperation({
    summary: 'Place an order (priced on the server); send Idempotency-Key to retry safely',
  })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createOrderSchema)) body: CreateOrderInput,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
  ) {
    return this.orders.create(auth, body, idempotencyKey(key), requestMeta(req));
  }

  @Get('orders')
  @RequirePermission('menu:read')
  @ApiOperation({
    summary: 'Orders, paged: search number/phone/table; filter branch, status, channel, dates',
  })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listOrdersSchema)) query: ListOrdersQuery,
  ) {
    return this.orders.list(auth, query);
  }

  @Get('payments')
  @RequirePermission('order:read')
  @ApiOperation({ summary: 'Payments, paged: filter by branch, method, refunded, dates' })
  payments(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listPaymentsSchema)) query: ListPaymentsQuery,
  ) {
    return this.orders.listPayments(auth, query);
  }

  @Get('orders/:id')
  @RequirePermission('menu:read')
  @ApiOperation({ summary: 'An order with items, discounts, payments and refunds' })
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.get(auth, id);
  }

  @Post('orders/:id/items/:itemId/void')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('order:void')
  @ApiOperation({ summary: 'Void one item; the order is re-priced' })
  voidItem(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: ReasonInput,
    @Req() req: Request,
  ) {
    return this.orders.voidItem(auth, id, itemId, body.reason, requestMeta(req));
  }

  @Post('orders/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('order:void')
  @ApiOperation({ summary: 'Cancel an unpaid order' })
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: ReasonInput,
    @Req() req: Request,
  ) {
    return this.orders.cancel(auth, id, body.reason, requestMeta(req));
  }

  @Post('orders/:id/payments')
  @RequirePermission('pos:access')
  @ApiOperation({ summary: 'Take a payment (split and partial payments allowed)' })
  pay(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(paymentSchema)) body: PaymentInput,
    @Req() req: Request,
  ) {
    return this.orders.addPayment(auth, id, body, requestMeta(req));
  }

  @Post('payments/:id/refunds')
  @RequirePermission('order:refund')
  @ApiOperation({ summary: 'Refund part or all of a payment' })
  refund(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(refundSchema)) body: RefundInput,
    @Req() req: Request,
  ) {
    return this.orders.refund(auth, id, body, requestMeta(req));
  }

  @Get('kitchen/tickets')
  @RequirePermission('kds:access')
  @ApiOperation({ summary: 'Kitchen tickets for a branch' })
  tickets(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(kitchenQuerySchema)) query: KitchenQuery,
  ) {
    return this.orders.kitchenTickets(auth, query.branchId);
  }

  @Post('kitchen/tickets/:id/status')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('kds:access')
  @ApiOperation({ summary: 'Move a ticket to its next kitchen status' })
  kitchenStatus(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(kitchenStatusSchema)) body: KitchenStatusInput,
    @Req() req: Request,
  ) {
    return this.orders.setKitchenStatus(auth, id, body.to, requestMeta(req));
  }
}
