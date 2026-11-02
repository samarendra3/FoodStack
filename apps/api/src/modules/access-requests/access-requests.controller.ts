import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AppConfigService } from '../../config/app-config.service';
import { CSRF_HEADER } from '../auth/auth.controller';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import {
  AllowAudience,
  type AuthedRequest,
  CurrentAuth,
  Public,
  RequirePermission,
} from '../auth/decorators';
import {
  type AccessRequestInput,
  accessRequestSchema,
  type ApproveInput,
  approveSchema,
  listQuerySchema,
  type RejectInput,
  rejectSchema,
} from './access-requests.schemas';
import { AccessRequestsService } from './access-requests.service';

const MINUTE = 60_000;

/** Public "Get started" form on the website. */
@ApiTags('Access requests')
@Controller('access-requests')
export class AccessRequestsController {
  constructor(
    private readonly requests: AccessRequestsService,
    private readonly config: AppConfigService,
  ) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 60 * MINUTE } })
  @ApiOperation({ summary: 'Ask to join FoodStack (reviewed by a Super Admin)' })
  async submit(
    @Body(new ZodValidationPipe(accessRequestSchema)) body: AccessRequestInput,
    @Req() req: Request,
  ) {
    // Same protection as the sign-in forms: a cross-site form cannot set this header.
    const origin = req.headers.origin;
    const allowed = this.config.get('CORS_ORIGINS');
    const originOk = !origin || allowed.length === 0 || allowed.includes(origin);
    if (req.headers[CSRF_HEADER] !== '1' || !originOk) {
      throw new ForbiddenException({ code: 'AUTH_CSRF_FAILED', message: 'Request blocked.' });
    }
    await this.requests.submit(body, requestMeta(req));
    return { status: 'received' };
  }
}

/** Super Admin review queue. */
@ApiTags('Platform')
@AllowAudience('platform')
@Controller('platform/access-requests')
export class PlatformAccessRequestsController {
  constructor(private readonly requests: AccessRequestsService) {}

  @Get()
  @RequirePermission('platform:tenants_read')
  @ApiOperation({ summary: 'Restaurant requests from the website (newest first)' })
  list(
    @Query(new ZodValidationPipe(listQuerySchema))
    query: { status: 'pending' | 'approved' | 'rejected' | 'all' },
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.requests.list(query.status, auth);
  }

  @Get('pending-count')
  @RequirePermission('platform:tenants_read')
  @ApiOperation({ summary: 'Number of requests waiting for review' })
  async pendingCount(@CurrentAuth() auth: AuthContext) {
    return { pending: await this.requests.pendingCount(auth) };
  }

  @Post(':id/approve')
  @RequirePermission('platform:tenants_manage')
  @ApiOperation({ summary: 'Create the restaurant (trial) and invite its owner' })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(approveSchema)) body: ApproveInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.requests.approve(id, body, auth, requestMeta(req));
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('platform:tenants_manage')
  @ApiOperation({ summary: 'Decline a request; the requester is told by email' })
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(rejectSchema)) body: RejectInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    await this.requests.reject(id, body, auth, requestMeta(req));
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
