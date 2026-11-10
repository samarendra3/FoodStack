import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { type Db, DbContext } from '../../core/db/db-context';
import { accessibleBranches, hasPermission } from '../auth/access';
import { AccessService } from '../auth/access.service';
import type { AuthContext, BranchRef, RequestMeta, TenantAccess } from '../auth/auth.types';
import { writeAudit } from '../auth/user-tokens';

/*
 * Shared plumbing for the operations modules (finance, procurement, floor, menu extras, people,
 * setup). Every call runs in one tenant transaction under row-level security; permissions are
 * then checked for the exact restaurant or branch the request touches.
 */

export const forbidden = (message = 'You do not have permission for this.') =>
  new ForbiddenException({ code: 'OPS_FORBIDDEN', message });
export const notFound = (what: string) =>
  new NotFoundException({ code: 'OPS_NOT_FOUND', message: `${what} not found.` });
export const invalid = (message: string, code = 'OPS_INVALID') =>
  new BadRequestException({ code, message });

/** Optional text: trims, turns '' into null. */
export const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export const money = z.coerce.number().int().min(0).max(1_000_000_000_00);
export const qty = z.coerce.number().positive().max(1_000_000);
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const branchQuery = z.strictObject({ branchId: z.uuid().optional() });
export const restaurantQuery = z.strictObject({ restaurantId: z.uuid().optional() });

export interface Scope {
  db: Db;
  access: TenantAccess;
  auth: AuthContext;
}

@Injectable()
export class OpsBase {
  constructor(
    private readonly dbc: DbContext,
    private readonly accessService: AccessService,
  ) {}

  run<T>(auth: AuthContext, work: (s: Scope) => Promise<T>) {
    return this.dbc.run({ tenantId: auth.tenantId, userId: auth.userId }, async (db) =>
      work({ db, access: await this.accessService.forRequest(db, auth), auth }),
    );
  }

  /** Branches where the caller holds `permission`. */
  branchesWith(access: TenantAccess, permission: string): BranchRef[] {
    return accessibleBranches(access).filter((b) =>
      hasPermission(access, permission, { branchId: b.id }),
    );
  }

  /** The requested branch (or the first allowed one) where the caller holds `permission`. */
  branch(access: TenantAccess, permission: string, branchId?: string | null): BranchRef {
    const allowed = this.branchesWith(access, permission);
    if (allowed.length === 0) throw forbidden();
    const b = branchId ? allowed.find((x) => x.id === branchId) : allowed[0];
    if (!b) throw forbidden('You do not have access to this branch.');
    return b;
  }

  /** Restaurants where the caller holds `permission` restaurant-wide. */
  restaurantsWith(access: TenantAccess, permission: string): string[] {
    const ids = [...new Set(access.allBranches.map((b) => b.restaurantId))];
    return ids.filter((id) => hasPermission(access, permission, { restaurantId: id }));
  }

  restaurant(access: TenantAccess, permission: string, restaurantId?: string | null): string {
    const allowed = this.restaurantsWith(access, permission);
    if (allowed.length === 0) throw forbidden();
    const id = restaurantId ?? allowed[0]!;
    if (!allowed.includes(id)) throw forbidden('You do not have access to this restaurant.');
    return id;
  }

  /**
   * For reads of restaurant-wide data (menu extras, suppliers, loyalty…): holding the permission
   * at any branch of the restaurant is enough, so branch staff can see what they work with.
   */
  readRestaurant(access: TenantAccess, permission: string, restaurantId?: string | null): string {
    const allowed = [...new Set(this.branchesWith(access, permission).map((b) => b.restaurantId))];
    if (allowed.length === 0) throw forbidden();
    const id = restaurantId ?? allowed[0]!;
    if (!allowed.includes(id)) throw forbidden('You do not have access to this restaurant.');
    return id;
  }

  can(
    access: TenantAccess,
    permission: string,
    target: { branchId?: string; restaurantId?: string },
  ) {
    return hasPermission(access, permission, target);
  }

  async currency(db: Db, restaurantId: string): Promise<string> {
    const r = await db.one<{ currency_code: string }>(
      'SELECT currency_code FROM restaurants WHERE id = $1',
      [restaurantId],
    );
    return r?.currency_code.trim() ?? 'INR';
  }

  branchList(access: TenantAccess, permission: string) {
    return this.branchesWith(access, permission).map((b) => ({
      id: b.id,
      name: b.name,
      restaurantId: b.restaurantId,
    }));
  }

  audit(
    s: Scope,
    meta: RequestMeta,
    action: string,
    entityType: string,
    entityId: string | null,
    metadata: Record<string, unknown> = {},
  ) {
    return writeAudit(s.db, {
      action,
      tenantId: s.auth.tenantId,
      actorUserId: s.auth.userId,
      actorSessionId: s.auth.sessionId,
      actorAudience: 'tenant',
      entityType,
      entityId,
      metadata,
      ...meta,
    });
  }
}

/** Builds `SET a = $n, b = $m` from a partial patch; returns null when nothing to set. */
export function setClause(
  patch: Record<string, unknown>,
  columns: Record<string, string>,
  params: unknown[],
): string | null {
  const parts: string[] = [];
  for (const [key, col] of Object.entries(columns)) {
    if (patch[key] !== undefined) {
      params.push(patch[key]);
      parts.push(`${col} = $${params.length}`);
    }
  }
  return parts.length ? parts.join(', ') : null;
}

export const iso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString());
export const num = (v: string | number | null) => (v === null ? null : Number(v));
