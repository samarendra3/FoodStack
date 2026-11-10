import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  NotFoundException,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { requestMeta } from '../../common/http/request-meta';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { DbContext } from '../../core/db/db-context';
import { hasPermission } from '../auth/access';
import { AccessService } from '../auth/access.service';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import { writeAudit } from '../auth/user-tokens';
import { SubscriptionLifecycleService } from '../billing/subscription-lifecycle.service';

export const createBranchSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{1,32}$/, 'Use 1–32 letters, numbers, - or _'),
  /** Defaults to the restaurant's only (or first) restaurant. */
  restaurantId: z.uuid().optional(),
});
export type CreateBranchInput = z.infer<typeof createBranchSchema>;

@ApiTags('Restaurant')
@Controller('branches')
export class BranchesController {
  constructor(
    private readonly db: DbContext,
    private readonly access: AccessService,
    private readonly subscriptions: SubscriptionLifecycleService,
  ) {}

  @Post()
  @RequirePermission('branch:manage')
  @ApiOperation({ summary: 'Add a branch (within the plan branch limit)' })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createBranchSchema)) body: CreateBranchInput,
    @Req() req: Request,
  ) {
    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, async (db) => {
      const access = await this.access.forRequest(db, auth);
      const restaurant = await db.one<{ id: string; timezone: string }>(
        body.restaurantId
          ? 'SELECT id, timezone FROM restaurants WHERE id = $1'
          : 'SELECT id, timezone FROM restaurants ORDER BY created_at LIMIT 1',
        body.restaurantId ? [body.restaurantId] : [],
      );
      if (!restaurant) {
        throw new NotFoundException({
          code: 'RESTAURANT_NOT_FOUND',
          message: 'Restaurant not found.',
        });
      }
      if (!hasPermission(access, 'branch:manage', { restaurantId: restaurant.id })) {
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: 'You cannot add branches to this restaurant.',
        });
      }
      await this.subscriptions.assertCanAddBranch(db, auth.tenantId!);
      const taken = await db.one('SELECT 1 FROM branches WHERE code = $1', [body.code]);
      if (taken) {
        throw new ConflictException({
          code: 'BRANCH_CODE_TAKEN',
          message: `Another branch already uses the code ${body.code}.`,
        });
      }
      const branch = await db.one<{ id: string; name: string; code: string }>(
        `INSERT INTO branches (tenant_id, restaurant_id, code, name, timezone)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, name, code::text AS code`,
        [auth.tenantId, restaurant.id, body.code, body.name, restaurant.timezone],
      );
      await writeAudit(db, {
        action: 'branch.created',
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorSessionId: auth.sessionId,
        actorAudience: 'tenant',
        entityType: 'branch',
        entityId: branch!.id,
        metadata: { code: branch!.code },
        ...requestMeta(req),
      });
      return { ...branch!, restaurantId: restaurant.id };
    });
  }
}
