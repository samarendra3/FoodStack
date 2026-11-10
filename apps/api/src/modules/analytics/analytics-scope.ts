import { createHash } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import type { Db } from '../../core/db/db-context';
import { accessibleBranches, hasPermission } from '../auth/access';
import type { TenantAccess } from '../auth/auth.types';
import { type LocalRange, localToday, resolveRange } from './analytics-range';
import type { AnalyticsQuery } from './analytics.schemas';

export const REPORT_PERMISSION = 'report:view';
/** Customer-level analytics follow the customers list, which is gated by order:read. */
export const CUSTOMER_PERMISSION = 'order:read';

/** Everything a query needs, derived from the caller's access — never from raw input alone. */
export interface AnalyticsScope {
  restaurant: { id: string; name: string; currencyCode: string; timezone: string };
  /** Branches of this restaurant the caller may report on (for the filter dropdown). */
  branches: { id: string; name: string }[];
  /** Branches the queries cover: the selected one, or all authorised ones. */
  branchIds: string[];
  /** Restaurants the caller may report on (for the filter dropdown). */
  restaurants: { id: string; name: string }[];
  timezone: string;
  range: LocalRange;
  /** Absolute bounds: current [start, end), previous [prevStart, prevEnd). */
  bounds: { start: Date; end: Date; prevStart: Date; prevEnd: Date };
  channel: string | null;
  method: string | null;
}

const forbidden = (message: string) =>
  new ForbiddenException({ code: 'REPORT_FORBIDDEN', message });

/**
 * Resolves filters against access: an id the caller may not report on is a 403 (as in
 * /reports/inventory), not an empty result. Branch Managers therefore only ever get their
 * assigned branches; an owner's "all branches" means all branches of one restaurant.
 */
export async function resolveScope(
  db: Db,
  access: TenantAccess,
  query: AnalyticsQuery,
): Promise<AnalyticsScope> {
  const allowed = accessibleBranches(access).filter((b) =>
    hasPermission(access, REPORT_PERMISSION, { branchId: b.id }),
  );
  if (allowed.length === 0) throw forbidden('You cannot view analytics.');

  const restaurantIds = [...new Set(allowed.map((b) => b.restaurantId))];
  let restaurantId = query.restaurantId;
  if (restaurantId && !restaurantIds.includes(restaurantId)) {
    throw forbidden('You cannot view analytics for this restaurant.');
  }
  if (query.branchId) {
    const branch = allowed.find((b) => b.id === query.branchId);
    if (!branch || (restaurantId && branch.restaurantId !== restaurantId)) {
      throw forbidden('You cannot view analytics for this branch.');
    }
    restaurantId = branch.restaurantId;
  }
  const rows = await db.query<{
    id: string;
    name: string;
    currency_code: string;
    timezone: string;
    branch_timezone: string | null;
  }>(
    `SELECT r.id, r.name, r.currency_code, r.timezone,
            (SELECT b.timezone FROM branches b WHERE b.id = $2 AND b.restaurant_id = r.id) AS branch_timezone
       FROM restaurants r WHERE r.id = ANY($1::uuid[]) ORDER BY lower(r.name), r.id`,
    [restaurantIds, query.branchId ?? null],
  );
  restaurantId ??= rows[0]?.id;
  const meta = rows.find((r) => r.id === restaurantId);
  if (!meta) throw forbidden('You cannot view analytics for this restaurant.');
  const branches = allowed.filter((x) => x.restaurantId === meta.id);
  const branchIds = query.branchId ? [query.branchId] : branches.map((x) => x.id).sort();
  // One branch: its own clock. Several branches: the restaurant's.
  const timezone = (query.branchId && meta.branch_timezone) || meta.timezone;
  const range = resolveRange(query.preset, localToday(timezone), query);

  const b = await db.one<{ start: Date; end: Date; prev_start: Date; prev_end: Date }>(
    `WITH d AS (
       SELECT ($1::date)::timestamp AT TIME ZONE $5::text AS s,
              ($2::date + 1)::timestamp AT TIME ZONE $5::text AS e,
              ($3::date)::timestamp AT TIME ZONE $5::text AS ps,
              ($4::date + 1)::timestamp AT TIME ZONE $5::text AS pe)
     SELECT s AS start,
            CASE WHEN $6 THEN least(e, now()) ELSE e END AS end,
            ps AS prev_start,
            CASE WHEN $6 THEN least(pe, ps + (least(e, now()) - s)) ELSE pe END AS prev_end
       FROM d`,
    [range.from, range.to, range.prevFrom, range.prevTo, timezone, range.partial],
  );

  return {
    restaurant: {
      id: meta.id,
      name: meta.name,
      currencyCode: meta.currency_code.trim(),
      timezone: meta.timezone,
    },
    branches: branches.map((x) => ({ id: x.id, name: x.name })),
    branchIds,
    restaurants: rows.map((r) => ({ id: r.id, name: r.name })),
    timezone,
    range,
    bounds: { start: b!.start, end: b!.end, prevStart: b!.prev_start, prevEnd: b!.prev_end },
    channel: query.channel ?? null,
    method: query.method ?? null,
  };
}

/** 403 unless the caller holds `permission` on every branch the scope covers. */
export function requireOnAllBranches(
  access: TenantAccess,
  scope: AnalyticsScope,
  permission: string,
): void {
  if (!scope.branchIds.every((branchId) => hasPermission(access, permission, { branchId }))) {
    throw forbidden('You cannot view customer analytics for this selection.');
  }
}

/**
 * Cache entry digest. Built from the *authorised* branch set and resolved local dates, so two
 * callers share an entry only when they would get the identical answer.
 */
export function scopeDigest(scope: AnalyticsScope, extra: Record<string, unknown> = {}): string {
  const r = scope.range;
  const canonical = JSON.stringify([
    scope.restaurant.id,
    scope.branchIds,
    scope.timezone,
    r.from,
    r.to,
    r.prevFrom,
    r.prevTo,
    scope.channel,
    scope.method,
    extra,
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}
