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
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { requestMeta } from '../../common/http/request-meta';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AuthContext } from '../auth/auth.types';
import { AllowInactiveSubscription, CurrentAuth, RequirePermission } from '../auth/decorators';
import {
  AccountService,
  type ChangePasswordInput,
  changePasswordSchema,
  type UpdateMeInput,
  type UpdateRestaurantInput,
  updateMeSchema,
  updateRestaurantSchema,
} from './account.service';

/** My Profile: restaurant profile, own details, password and sessions. */
@ApiTags('Account')
@AllowInactiveSubscription()
@Controller('account')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Get('profile')
  @RequirePermission('restaurant:read')
  @ApiOperation({ summary: 'Restaurant profile, owner and the signed-in member' })
  profile(@CurrentAuth() auth: AuthContext) {
    return this.account.profile(auth);
  }

  @Patch('restaurant')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('restaurant:manage')
  @ApiOperation({ summary: 'Edit the restaurant profile (logo, contact, address, GSTIN…)' })
  async updateRestaurant(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(updateRestaurantSchema)) body: UpdateRestaurantInput,
    @Req() req: Request,
  ) {
    await this.account.updateRestaurant(auth, body, requestMeta(req));
  }

  @Patch('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('restaurant:read')
  @ApiOperation({ summary: 'Edit my name and phone' })
  async updateMe(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(updateMeSchema)) body: UpdateMeInput,
    @Req() req: Request,
  ) {
    await this.account.updateMe(auth, body, requestMeta(req));
  }

  @Post('password')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('restaurant:read')
  @Throttle({ default: { limit: 10, ttl: 15 * 60_000 } })
  @ApiOperation({ summary: 'Change password (signs out other sessions)' })
  changePassword(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordInput,
    @Req() req: Request,
  ) {
    return this.account.changePassword(auth, body, requestMeta(req));
  }

  @Get('sessions')
  @RequirePermission('restaurant:read')
  @ApiOperation({ summary: 'My active sign-in sessions' })
  sessions(@CurrentAuth() auth: AuthContext) {
    return this.account.sessions(auth);
  }

  @Post('sessions/:id/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('restaurant:read')
  @ApiOperation({ summary: 'Sign out one of my other sessions' })
  async revoke(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    await this.account.revokeSession(auth, id, requestMeta(req));
  }
}
