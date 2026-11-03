import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { DbContext } from '../../core/db/db-context';
import { accessibleBranches, hasPermission } from '../auth/access';
import { AccessService } from '../auth/access.service';
import type { AuthContext } from '../auth/auth.types';
import type { InventoryReportQuery } from './reports.schemas';

const MAX_DAYS = 366;

/**
 * Read-only reports over existing modules. Movement values use each item's current cost per
 * unit (cost is not snapshotted per movement), which the response states as `valuation`.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly db: DbContext,
    private readonly access: AccessService,
  ) {}

  inventory(auth: AuthContext, query: InventoryReportQuery) {
    if (query.from > query.to) {
      throw new BadRequestException({ code: 'BAD_RANGE', message: '“From” must be before “To”.' });
    }
    const days = (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000 + 1;
    if (days > MAX_DAYS) {
      throw new BadRequestException({ code: 'RANGE_TOO_LONG', message: 'Pick at most one year.' });
    }

    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, async (db) => {
      const access = await this.access.tenantAccess(db, auth.membershipId!);
      const branches = accessibleBranches(access).filter((b) =>
        hasPermission(access, 'report:view', { branchId: b.id }),
      );
      if (branches.length === 0) {
        throw new ForbiddenException({
          code: 'REPORT_FORBIDDEN',
          message: 'You cannot view reports.',
        });
      }
      const branch = query.branchId ? branches.find((b) => b.id === query.branchId) : branches[0];
      if (!branch) {
        throw new ForbiddenException({
          code: 'REPORT_FORBIDDEN',
          message: 'You cannot view reports for this branch.',
        });
      }

      const meta = await db.one<{ timezone: string; currency_code: string }>(
        `SELECT b.timezone, r.currency_code FROM branches b
           JOIN restaurants r ON r.id = b.restaurant_id WHERE b.id = $1`,
        [branch.id],
      );
      const tz = meta!.timezone;
      // Movements whose local (branch timezone) date falls within [from, to].
      // Local (branch timezone) day boundaries for [from, to].
      const bounds = await db.one<{ start: Date; end: Date }>(
        `SELECT (($1::text)::date)::timestamp AT TIME ZONE $3::text AS start,
                (($2::text)::date + 1)::timestamp AT TIME ZONE $3::text AS end`,
        [query.from, query.to, tz],
      );
      const range = `m.branch_id = $1 AND m.created_at >= $2::timestamptz AND m.created_at < $3::timestamptz`;
      const params = [branch.id, bounds!.start, bounds!.end];

      const totals = await db.query<{ type: string; movements: string; value_minor: string }>(
        `SELECT m.type, count(*) AS movements,
                coalesce(sum(abs(m.quantity_delta) * coalesce(i.cost_per_unit_minor, 0)), 0) AS value_minor
           FROM inventory_movements m JOIN inventory_items i ON i.id = m.item_id
          WHERE ${range}
          GROUP BY m.type`,
        params,
      );

      const daily = await db.query<{ day: string; type: string; value_minor: string }>(
        `SELECT to_char((m.created_at AT TIME ZONE $4::text)::date, 'YYYY-MM-DD') AS day, m.type,
                sum(abs(m.quantity_delta) * coalesce(i.cost_per_unit_minor, 0)) AS value_minor
           FROM inventory_movements m JOIN inventory_items i ON i.id = m.item_id
          WHERE ${range} AND m.type IN ('purchase', 'usage', 'wastage')
          GROUP BY 1, 2 ORDER BY 1`,
        [...params, tz],
      );

      const byItem = await db.query<{
        id: string;
        name: string;
        unit: string;
        category: string | null;
        purchased: string;
        used: string;
        wasted: string;
        counted_delta: string;
        cost_per_unit_minor: string | null;
      }>(
        `SELECT i.id, i.name, i.unit, i.category, i.cost_per_unit_minor,
                coalesce(sum(m.quantity_delta) FILTER (WHERE m.type = 'purchase'), 0) AS purchased,
                coalesce(-sum(m.quantity_delta) FILTER (WHERE m.type = 'usage'), 0) AS used,
                coalesce(-sum(m.quantity_delta) FILTER (WHERE m.type = 'wastage'), 0) AS wasted,
                coalesce(sum(m.quantity_delta) FILTER (WHERE m.type = 'count'), 0) AS counted_delta
           FROM inventory_movements m JOIN inventory_items i ON i.id = m.item_id
          WHERE ${range}
          GROUP BY i.id ORDER BY lower(i.name)`,
        params,
      );

      const stock = await db.query<{
        id: string;
        name: string;
        unit: string;
        category: string | null;
        quantity: string | null;
        low_stock_threshold: string;
        cost_per_unit_minor: string | null;
      }>(
        `SELECT i.id, i.name, i.unit, i.category, s.quantity, i.low_stock_threshold,
                i.cost_per_unit_minor
           FROM inventory_items i
           LEFT JOIN inventory_stock s ON s.item_id = i.id AND s.branch_id = $1
          WHERE i.restaurant_id = $2 AND i.deleted_at IS NULL
          ORDER BY lower(i.name)`,
        [branch.id, branch.restaurantId],
      );

      const sum = (type: string) => totals.find((t) => t.type === type);
      const totalOf = (type: string) => ({
        movements: Number(sum(type)?.movements ?? 0),
        valueMinor: Math.round(Number(sum(type)?.value_minor ?? 0)),
      });

      const stockRows = stock.map((s) => {
        const quantity = Number(s.quantity ?? 0);
        const cost = s.cost_per_unit_minor === null ? null : Number(s.cost_per_unit_minor);
        const threshold = Number(s.low_stock_threshold);
        return {
          id: s.id,
          name: s.name,
          unit: s.unit,
          category: s.category,
          quantity,
          lowStockThreshold: threshold,
          costPerUnitMinor: cost,
          valueMinor: cost === null ? null : Math.round(cost * quantity),
          status: quantity <= 0 ? 'out' : quantity <= threshold ? 'low' : 'ok',
        };
      });

      return {
        branch: { id: branch.id, name: branch.name, timezone: tz },
        branches: branches.map((b) => ({ id: b.id, name: b.name })),
        currencyCode: meta!.currency_code.trim(),
        range: { from: query.from, to: query.to },
        valuation: 'current_cost',
        totals: {
          purchase: totalOf('purchase'),
          usage: totalOf('usage'),
          wastage: totalOf('wastage'),
          count: totalOf('count'),
        },
        daily: daily.map((d) => ({
          day: d.day,
          type: d.type,
          valueMinor: Math.round(Number(d.value_minor)),
        })),
        items: byItem.map((r) => {
          const cost = r.cost_per_unit_minor === null ? null : Number(r.cost_per_unit_minor);
          const wasted = Number(r.wasted);
          return {
            id: r.id,
            name: r.name,
            unit: r.unit,
            category: r.category,
            purchased: Number(r.purchased),
            used: Number(r.used),
            wasted,
            countAdjustment: Number(r.counted_delta),
            wastedValueMinor: cost === null ? null : Math.round(cost * wasted),
          };
        }),
        stock: {
          totalValueMinor: stockRows.reduce((n, s) => n + (s.valueMinor ?? 0), 0),
          itemsWithoutCost: stockRows.filter((s) => s.costPerUnitMinor === null).length,
          rows: stockRows,
        },
      };
    });
  }
}
