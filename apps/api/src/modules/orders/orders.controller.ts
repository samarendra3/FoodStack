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
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
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
import { OrderEventsService } from './order-events';
import { OrdersService } from './orders.service';

const HEARTBEAT_MS = 15_000;
const STREAM_TTL_MS = 10 * 60_000;

const idempotencyKey = (v: string | undefined) => (v && /^[A-Za-z0-9_-]{8,80}$/.test(v) ? v : null);

/**
 * Orders, bills and payments. The decorators check a permission exists in some scope; the
 * service checks the exact branch (pos/waiter/kds access, order:void, order:refund).
 */
@ApiTags('Orders')
@Controller()
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly events: OrderEventsService,
  ) {}

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

  // ---- waiter pickup (kitchen → waiter "order ready") ----

  @Get('waiter/ready-orders')
  @RequirePermission('waiter:access')
  @ApiOperation({ summary: 'Orders ready for pickup in a branch (backlog after reconnect)' })
  readyOrders(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(kitchenQuerySchema)) query: KitchenQuery,
  ) {
    return this.orders.readyOrders(auth, query.branchId);
  }

  /**
   * Server-Sent Events: `order.ready` / `order.served` for one branch. Authenticated like any
   * request (Bearer token), so clients read it with fetch streaming, not EventSource. The stream
   * ends after STREAM_TTL_MS so a revoked session or expired token stops receiving within minutes;
   * the client reconnects (with a fresh token) and re-fetches the backlog.
   */
  @Get('waiter/ready-orders/stream')
  @RequirePermission('waiter:access')
  @ApiOperation({ summary: 'Live ready-order events for a branch (text/event-stream)' })
  async readyStream(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(kitchenQuerySchema)) query: KitchenQuery,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const tenantId = await this.orders.authorizeWaiterFeed(auth, query.branchId);
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx: don't buffer the stream
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const send = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('hello', { branchId: query.branchId });
    const unsubscribe = this.events.subscribe(tenantId, query.branchId, (e) => {
      const { tenantId: _t, ...payload } = e;
      send(e.type, payload);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    const ttl = setTimeout(() => res.end(), STREAM_TTL_MS);
    req.on('close', () => {
      clearInterval(heartbeat);
      clearTimeout(ttl);
      unsubscribe();
    });
  }

  @Post('waiter/orders/:id/served')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('waiter:access')
  @ApiOperation({ summary: 'Mark a ready order as served' })
  served(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.orders.markServed(auth, id, requestMeta(req));
  }
}
