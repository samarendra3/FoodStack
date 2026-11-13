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
import { z } from 'zod';
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
  type ItemStatusInput,
  itemStatusSchema,
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
import { type OrderEvent, OrderEventsService } from './order-events';
import { WaiterAssignmentsService } from './waiter-assignments';

const assignSchema = z.strictObject({ waiterUserId: z.uuid() });
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
    private readonly assignments: WaiterAssignmentsService,
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

  @Get('orders/:id/timeline')
  @RequirePermission('menu:read')
  @ApiOperation({ summary: "An order's event timeline (created, kitchen steps, payments…)" })
  timeline(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.timeline(auth, id);
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
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.orders.addPayment(auth, id, body, requestMeta(req), idempotencyKey(key));
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

  @Post('kitchen/tickets/:id/items/:itemId/status')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('kds:access')
  @ApiOperation({ summary: 'Move one dish on a ticket: pending → preparing → ready' })
  itemStatus(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body(new ZodValidationPipe(itemStatusSchema)) body: ItemStatusInput,
    @Req() req: Request,
  ) {
    return this.orders.setItemStatus(auth, id, itemId, body.to, requestMeta(req));
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
    const tenantId = await this.orders.authorizeFeed(auth, query.branchId, 'waiter:access');
    this.pipeEvents(req, res, tenantId, query.branchId, [
      'order.ready',
      'order.served',
      'waiter.assigned',
      'waiter.accepted',
      'waiter.unassigned',
    ]);
  }

  /**
   * Live kitchen events for a branch (text/event-stream): `order.created` for every new order
   * (POS, waiter and QR alike) and `order.status` / `order.ready` / `order.served` when another
   * screen moves a ticket. Kitchens re-read /kitchen/tickets on each event and on (re)connect.
   */
  @Get('kitchen/tickets/stream')
  @RequirePermission('kds:access')
  @ApiOperation({ summary: 'Live kitchen events for a branch (text/event-stream)' })
  async kitchenStream(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(kitchenQuerySchema)) query: KitchenQuery,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const tenantId = await this.orders.authorizeFeed(auth, query.branchId, 'kds:access');
    this.pipeEvents(req, res, tenantId, query.branchId, [
      'order.created',
      'order.status',
      'order.item_status',
      'order.ready',
      'order.served',
      'order.cancelled',
      'order.item_voided',
    ]);
  }

  /** Streams one tenant branch's order events of the given types as Server-Sent Events. */
  private pipeEvents(
    req: Request,
    res: Response,
    tenantId: string,
    branchId: string,
    types: OrderEvent['type'][],
  ) {
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx: don't buffer the stream
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const send = (e: OrderEvent) => {
      const { tenantId: _t, ...payload } = e; // routing only; never sent to browsers
      res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    res.write(`event: hello\ndata: ${JSON.stringify({ branchId })}\n\n`);

    // Live events are buffered while missed ones are replayed from the outbox (Last-Event-ID),
    // then flushed in order; ids already sent are skipped, so each event arrives exactly once.
    const sent = new Set<string>();
    let buffer: OrderEvent[] | null = [];
    const emit = (e: OrderEvent) => {
      if (!types.includes(e.type) || sent.has(e.id)) return;
      sent.add(e.id);
      send(e);
    };
    const unsubscribe = this.events.subscribe(tenantId, branchId, (e) => {
      if (buffer) buffer.push(e);
      else emit(e);
    });
    const lastId = String(req.headers['last-event-id'] ?? '');
    void (async () => {
      const missed = lastId
        ? await this.events.replay(tenantId, branchId, lastId).catch(() => [])
        : [];
      for (const e of [...missed, ...(buffer ?? [])]) emit(e);
      buffer = null;
    })();
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    const ttl = setTimeout(() => res.end(), STREAM_TTL_MS);
    req.on('close', () => {
      clearInterval(heartbeat);
      clearTimeout(ttl);
      unsubscribe();
    });
  }

  // ---- waiter assignment (who takes a ready order to the table) ----

  @Post('waiter/assignments/:id/accept')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('waiter:access')
  @ApiOperation({ summary: 'Accept the ready order assigned to you' })
  acceptTask(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.assignments.accept(auth, id, requestMeta(req));
  }

  @Post('waiter/assignments/:id/claim')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('waiter:access')
  @ApiOperation({ summary: 'Take an order from the unassigned queue' })
  claimTask(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.assignments.claim(auth, id, requestMeta(req));
  }

  @Post('waiter/assignments/:id/problem')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('waiter:access')
  @ApiOperation({ summary: 'Report a serving problem; the order returns to the queue' })
  problemTask(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: ReasonInput,
    @Req() req: Request,
  ) {
    return this.assignments.problem(auth, id, body.reason, requestMeta(req));
  }

  @Post('waiter/assignments/:id/assign')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('waiter:assign')
  @ApiOperation({ summary: 'Assign or reassign a ready order to a waiter (supervisors)' })
  assignTask(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(assignSchema)) body: { waiterUserId: string },
    @Req() req: Request,
  ) {
    return this.assignments.assign(auth, id, body.waiterUserId, requestMeta(req));
  }

  @Get('waiter/staff')
  @RequirePermission('waiter:assign')
  @ApiOperation({ summary: 'Waiters of a branch with open workload (supervisors)' })
  waiterStaff(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(kitchenQuerySchema)) query: KitchenQuery,
  ) {
    return this.assignments.staff(auth, query.branchId);
  }

  @Get('waiter/history')
  @RequirePermission('waiter:access')
  @ApiOperation({ summary: 'Your serving history (last 24 hours)' })
  waiterHistory(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(kitchenQuerySchema)) query: KitchenQuery,
  ) {
    return this.assignments.history(auth, query.branchId);
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
