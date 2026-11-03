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
import type { Request } from 'express';
import { requestMeta } from '../../common/http/request-meta';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import {
  type CreateStockItemInput,
  createStockItemSchema,
  type HistoryQuery,
  historyQuerySchema,
  type InventoryQuery,
  inventoryQuerySchema,
  type MovementInput,
  movementSchema,
  type UpdateStockItemInput,
  updateStockItemSchema,
} from './inventory.schemas';
import { InventoryService } from './inventory.service';

/**
 * Stock items and per-branch stock levels. The decorator checks the permission exists in some
 * scope; InventoryService checks it for the exact restaurant or branch.
 */
@ApiTags('Inventory')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  @RequirePermission('inventory:read')
  @ApiOperation({ summary: 'Stock items with quantities for one branch' })
  overview(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(inventoryQuerySchema)) query: InventoryQuery,
  ) {
    return this.inventory.overview(auth, query.branchId);
  }

  @Post('items')
  @RequirePermission('inventory:manage')
  @ApiOperation({ summary: 'Add a stock item' })
  createItem(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createStockItemSchema)) body: CreateStockItemInput,
    @Req() req: Request,
  ) {
    return this.inventory.createItem(auth, body, requestMeta(req));
  }

  @Patch('items/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('inventory:manage')
  @ApiOperation({ summary: 'Edit a stock item' })
  async updateItem(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateStockItemSchema)) body: UpdateStockItemInput,
    @Req() req: Request,
  ) {
    await this.inventory.updateItem(auth, id, body, requestMeta(req));
  }

  @Delete('items/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('inventory:manage')
  @ApiOperation({ summary: 'Remove a stock item' })
  async deleteItem(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    await this.inventory.deleteItem(auth, id, requestMeta(req));
  }

  @Post('items/:id/movements')
  @RequirePermission('inventory:manage')
  @ApiOperation({ summary: 'Record stock in, usage, wastage or a physical count' })
  recordMovement(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(movementSchema)) body: MovementInput,
    @Req() req: Request,
  ) {
    return this.inventory.recordMovement(auth, id, body, requestMeta(req));
  }

  @Get('items/:id/movements')
  @RequirePermission('inventory:read')
  @ApiOperation({ summary: 'Recent stock movements of an item at a branch' })
  history(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(historyQuerySchema)) query: HistoryQuery,
  ) {
    return this.inventory.history(auth, id, query.branchId);
  }
}
