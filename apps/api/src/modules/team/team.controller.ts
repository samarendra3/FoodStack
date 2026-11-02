import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { type AuthedRequest, CurrentAuth, RequirePermission } from '../auth/decorators';
import {
  type ChangeRoleInput,
  changeRoleSchema,
  type InviteInput,
  inviteSchema,
} from './team.schemas';
import { TeamService } from './team.service';

const MINUTE = 60_000;

/**
 * Team management for restaurant staff. The decorator checks the permission exists in some
 * scope; TeamService then checks it for the exact branch and role involved.
 */
@ApiTags('Team')
@Controller('team')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get()
  @RequirePermission('member:read')
  @ApiOperation({ summary: 'Team members the caller can see, with the roles they may give' })
  list(@CurrentAuth() auth: AuthContext) {
    return this.team.list(auth);
  }

  @Post('invite')
  @RequirePermission('member:invite')
  @Throttle({ default: { limit: 30, ttl: 60 * MINUTE } })
  @ApiOperation({ summary: 'Add someone to the team and email them a set-password link' })
  invite(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(inviteSchema)) body: InviteInput,
    @Req() req: Request,
  ) {
    return this.team.invite(auth, body, requestMeta(req));
  }

  @Post(':id/role')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('member:manage')
  @ApiOperation({ summary: "Replace a member's role" })
  async changeRole(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(changeRoleSchema)) body: ChangeRoleInput,
    @Req() req: Request,
  ) {
    await this.team.changeRole(auth, id, body, requestMeta(req));
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('member:manage')
  @ApiOperation({ summary: 'Block a member from this business and end their sessions' })
  async suspend(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    await this.team.setSuspended(auth, id, true, requestMeta(req));
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('member:manage')
  @ApiOperation({ summary: 'Let a suspended member back in' })
  async reactivate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    await this.team.setSuspended(auth, id, false, requestMeta(req));
  }

  @Post(':id/resend-invite')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('member:invite')
  @Throttle({ default: { limit: 10, ttl: 60 * MINUTE } })
  @ApiOperation({ summary: 'Email a fresh set-password link to someone who has not joined yet' })
  async resendInvite(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    await this.team.resendInvite(auth, id, requestMeta(req));
  }
}

function requestMeta(req: Request): RequestMeta {
  const ua = req.headers['user-agent'];
  const id = (req as AuthedRequest).id;
  return {
    ip: req.ip ?? null,
    userAgent: typeof ua === 'string' ? ua : null,
    requestId: id === undefined ? null : String(id),
  };
}
