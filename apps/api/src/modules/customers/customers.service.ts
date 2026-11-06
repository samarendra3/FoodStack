import { ForbiddenException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { likeTerm, pageQuerySchema, runPaged } from '../../common/pagination/paged';
import { DbContext } from '../../core/db/db-context';
import { AccessService } from '../auth/access.service';
import type { AuthContext } from '../auth/auth.types';

export const listCustomersSchema = pageQuerySchema(
  ['lastOrderAt', 'orderCount', 'totalSpentMinor', 'name', 'createdAt'] as const,
  'lastOrderAt',
  {},
);
export type ListCustomersQuery = z.infer<typeof listCustomersSchema>;

/**
 * Guests who have ordered (captured at the POS by phone). Customers are business-wide; order
 * statistics count completed orders only, net of refunds.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly db: DbContext,
    private readonly access: AccessService,
  ) {}

  list(auth: AuthContext, query: ListCustomersQuery) {
    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, async (db) => {
      const access = await this.access.forRequest(db, auth);
      // Customer records span every branch, so a business-wide grant is required.
      if (!access.tenant.includes('order:read')) {
        throw new ForbiddenException({
          code: 'CUSTOMERS_FORBIDDEN',
          message: 'You cannot view customers.',
        });
      }
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.search) {
        params.push(likeTerm(query.search.replace(/[\s-]/g, '')), likeTerm(query.search));
        where.push(`(c.phone ILIKE $1 OR c.name ILIKE $2)`);
      }
      if (query.from) {
        params.push(query.from);
        where.push(`s.last_order_at::date >= $${params.length}::date`);
      }
      if (query.to) {
        params.push(query.to);
        where.push(`s.last_order_at::date <= $${params.length}::date`);
      }
      return runPaged<
        {
          id: string;
          name: string | null;
          phone: string;
          created_at: Date;
          order_count: string | null;
          total_spent_minor: string | null;
          last_order_at: Date | null;
        },
        unknown
      >(db, {
        select:
          'c.id, c.name, c.phone, c.created_at, s.order_count, s.total_spent_minor, s.last_order_at',
        from: `customers c LEFT JOIN LATERAL (
                 SELECT count(*) AS order_count,
                        sum(o.total_minor - o.refunded_minor) AS total_spent_minor,
                        max(o.created_at) AS last_order_at
                   FROM orders o WHERE o.customer_id = c.id AND o.status = 'completed'
               ) s ON true`,
        where,
        params,
        sortColumns: {
          lastOrderAt: 's.last_order_at',
          orderCount: 's.order_count',
          totalSpentMinor: 's.total_spent_minor',
          name: 'lower(c.name)',
          createdAt: 'c.created_at',
        },
        tiebreak: 'c.id',
        query,
        map: (r) => ({
          id: r.id,
          name: r.name,
          phone: r.phone,
          createdAt: new Date(r.created_at).toISOString(),
          orderCount: Number(r.order_count ?? 0),
          totalSpentMinor: Number(r.total_spent_minor ?? 0),
          lastOrderAt: r.last_order_at ? new Date(r.last_order_at).toISOString() : null,
        }),
      });
    });
  }
}
