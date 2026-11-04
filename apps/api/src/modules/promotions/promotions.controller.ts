import {
  Body,
  Controller,
  Delete,
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
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { requestMeta } from '../../common/http/request-meta';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import {
  type CreatePromotionInput,
  type ListPromotionsQuery,
  listPromotionsSchema,
  createPromotionSchema,
  type QuoteInput,
  quoteSchema,
  type UpdatePromotionInput,
  updatePromotionSchema,
} from './promotions.schemas';
import { PromotionsService } from './promotions.service';

/** Promotions, coupon codes and the server-side discount quote. */
@ApiTags('Promotions')
@Controller('promotions')
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  @Get()
  @RequirePermission('promotion:read')
  @ApiOperation({ summary: 'Promotions, paged: search name/coupon; filter state, type, coupon' })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listPromotionsSchema)) query: ListPromotionsQuery,
  ) {
    return this.promotions.listPaged(auth, query);
  }

  @Get('summary')
  @RequirePermission('promotion:read')
  @ApiOperation({ summary: 'Promotion counts by state' })
  summary(@CurrentAuth() auth: AuthContext) {
    return this.promotions.summary(auth);
  }

  /** Any order-taking staff may price a cart; the service checks the branch. */
  @Post('quote')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('menu:read')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'Price a cart: discounts calculated on the server' })
  quote(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(quoteSchema)) body: QuoteInput,
  ) {
    return this.promotions.quote(auth, body);
  }

  @Get(':id')
  @RequirePermission('promotion:read')
  @ApiOperation({ summary: 'One promotion' })
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.promotions.get(auth, id);
  }

  @Post()
  @RequirePermission('promotion:manage')
  @ApiOperation({ summary: 'Create a promotion' })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createPromotionSchema)) body: CreatePromotionInput,
    @Req() req: Request,
  ) {
    return this.promotions.create(auth, body, requestMeta(req));
  }

  @Patch(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('promotion:manage')
  @ApiOperation({ summary: 'Edit, pause or resume a promotion' })
  async update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updatePromotionSchema)) body: UpdatePromotionInput,
    @Req() req: Request,
  ) {
    await this.promotions.update(auth, id, body, requestMeta(req));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('promotion:manage')
  @ApiOperation({ summary: 'Delete a promotion' })
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    await this.promotions.remove(auth, id, requestMeta(req));
  }
}
