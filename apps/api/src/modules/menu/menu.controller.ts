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
  type CreateCategoryInput,
  type CreateItemInput,
  createCategorySchema,
  createItemSchema,
  type ImportInput,
  importSchema,
  type MenuQuery,
  menuQuerySchema,
  type UpdateCategoryInput,
  type UpdateItemInput,
  updateCategorySchema,
  updateItemSchema,
} from './menu.schemas';
import { MenuService } from './menu.service';

/**
 * Menu categories and items for a restaurant. The decorator checks the permission exists in
 * some scope; MenuService then checks it for the exact restaurant.
 */
@ApiTags('Menu')
@Controller('menu')
export class MenuController {
  constructor(private readonly menu: MenuService) {}

  @Get()
  @RequirePermission('menu:read')
  @ApiOperation({ summary: "A restaurant's categories and items" })
  get(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(menuQuerySchema)) query: MenuQuery,
  ) {
    return this.menu.get(auth, query.restaurantId);
  }

  @Post('categories')
  @RequirePermission('menu:manage')
  @ApiOperation({ summary: 'Add a menu category' })
  createCategory(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createCategorySchema)) body: CreateCategoryInput,
    @Req() req: Request,
  ) {
    return this.menu.createCategory(auth, body, requestMeta(req));
  }

  @Patch('categories/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('menu:manage')
  @ApiOperation({ summary: 'Rename, reorder, show or hide a category' })
  async updateCategory(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateCategorySchema)) body: UpdateCategoryInput,
    @Req() req: Request,
  ) {
    await this.menu.updateCategory(auth, id, body, requestMeta(req));
  }

  @Delete('categories/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('menu:manage')
  @ApiOperation({ summary: 'Delete an empty category' })
  async deleteCategory(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    await this.menu.deleteCategory(auth, id, requestMeta(req));
  }

  @Post('items')
  @RequirePermission('menu:manage')
  @ApiOperation({ summary: 'Add a menu item' })
  createItem(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createItemSchema)) body: CreateItemInput,
    @Req() req: Request,
  ) {
    return this.menu.createItem(auth, body, requestMeta(req));
  }

  @Patch('items/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('menu:manage')
  @ApiOperation({ summary: 'Edit a menu item (price, availability, category…)' })
  async updateItem(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateItemSchema)) body: UpdateItemInput,
    @Req() req: Request,
  ) {
    await this.menu.updateItem(auth, id, body, requestMeta(req));
  }

  @Delete('items/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('menu:manage')
  @ApiOperation({ summary: 'Remove a menu item' })
  async deleteItem(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    await this.menu.deleteItem(auth, id, requestMeta(req));
  }

  @Post('import')
  @RequirePermission('menu:manage')
  @Throttle({ default: { limit: 20, ttl: 60 * 60_000 } })
  @ApiOperation({ summary: 'Import many items at once (creates missing categories)' })
  import(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(importSchema)) body: ImportInput,
    @Req() req: Request,
  ) {
    return this.menu.importItems(auth, body, requestMeta(req));
  }
}
