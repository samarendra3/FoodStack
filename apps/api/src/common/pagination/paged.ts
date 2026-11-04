import { z } from 'zod';
import type { Db } from '../../core/db/db-context';

export const PAGE_SIZES = [10, 25, 50, 100] as const;

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/**
 * A page of results. The response envelope serializes it as
 * `{ data: items, meta: { ...pagination, requestId } }`.
 */
export class Paged<T> {
  constructor(
    readonly items: T[],
    readonly meta: PageMeta,
  ) {}
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Not a real date');

/**
 * Query schema for a paged list: page, limit (10/25/50/100), search, a whitelisted sortBy,
 * sortOrder (default `defaultOrder`) and an optional date range, plus list-specific filters.
 */
export function pageQuerySchema<S extends readonly [string, ...string[]], E extends z.ZodRawShape>(
  sortable: S,
  defaultSort: S[number],
  extra: E,
  defaultOrder: 'ASC' | 'DESC' = 'DESC',
) {
  return z
    .strictObject({
      page: z.coerce.number().int().min(1).max(100_000).default(1),
      limit: z.coerce
        .number()
        .int()
        .refine((n) => (PAGE_SIZES as readonly number[]).includes(n), 'Use 10, 25, 50 or 100')
        .default(25),
      search: z.string().trim().max(100).optional(),
      sortBy: z.enum(sortable).default(defaultSort as never),
      sortOrder: z
        .string()
        .transform((v) => v.toUpperCase())
        .pipe(z.enum(['ASC', 'DESC']))
        .default(defaultOrder),
      from: isoDate.optional(),
      to: isoDate.optional(),
      ...extra,
    })
    .refine(
      (q) => {
        const { from, to } = q as { from?: string; to?: string };
        return !from || !to || from <= to;
      },
      {
        message: '“from” must be before “to”',
        path: ['from'],
      },
    );
}

export interface PageQuery {
  page: number;
  limit: number;
  sortBy: string;
  sortOrder: 'ASC' | 'DESC';
}

/**
 * Runs a count and one page of a query. `where` holds SQL conditions using `params` ($1…);
 * `sortColumns` maps each whitelisted sortBy key to a SQL expression (never user text).
 * Ties are broken by `tiebreak` so pages stay stable.
 */
export async function runPaged<Row, T>(
  db: Db,
  opts: {
    select: string;
    from: string;
    where: string[];
    params: unknown[];
    sortColumns: Record<string, string>;
    tiebreak: string;
    query: PageQuery;
    map: (row: Row) => T;
  },
): Promise<Paged<T>> {
  const sort = opts.sortColumns[opts.query.sortBy];
  if (!sort) throw new Error(`sortBy ${opts.query.sortBy} is not whitelisted`);
  const where = opts.where.length ? `WHERE ${opts.where.join(' AND ')}` : '';
  const n = opts.params.length;
  const [count, rows] = await Promise.all([
    db.one<{ total: string }>(`SELECT count(*) AS total FROM ${opts.from} ${where}`, opts.params),
    db.query<Row>(
      `SELECT ${opts.select} FROM ${opts.from} ${where}
        ORDER BY ${sort} ${opts.query.sortOrder} NULLS LAST, ${opts.tiebreak} ${opts.query.sortOrder}
        LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...opts.params, opts.query.limit, (opts.query.page - 1) * opts.query.limit],
    ),
  ]);
  const total = Number(count?.total ?? 0);
  return new Paged(rows.map(opts.map), pageMeta(opts.query.page, opts.query.limit, total));
}

export function pageMeta(page: number, limit: number, total: number): PageMeta {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

/** `%term%` for ILIKE with LIKE wildcards escaped. */
export function likeTerm(search: string): string {
  return `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
