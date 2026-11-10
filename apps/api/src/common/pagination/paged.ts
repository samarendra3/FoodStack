import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { Db } from '../../core/db/db-context';

export const PAGE_SIZES = [10, 25, 50, 100] as const;

export interface OffsetPageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/**
 * Keyset (cursor) page. No total: counting is what makes deep offset pages slow. Cursors are
 * opaque; pass `nextCursor` / `prevCursor` back as `cursor` with the same filters and sort.
 */
export interface CursorPageMeta {
  pagination: 'cursor';
  limit: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  nextCursor: string | null;
  prevCursor: string | null;
}

export type PageMeta = OffsetPageMeta | CursorPageMeta;

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
      // Keyset mode (opt-in; offset stays the default for existing clients). A cursor implies it.
      pagination: z.enum(['offset', 'cursor']).default('offset'),
      cursor: z
        .string()
        .max(512)
        .regex(/^[A-Za-z0-9_-]+$/, 'Invalid cursor')
        .optional(),
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
  pagination?: 'offset' | 'cursor';
  cursor?: string;
}

/** PostgreSQL type of a keyset sort expression, used to cast the cursor value back. */
export type CursorType = 'timestamptz' | 'bigint' | 'integer' | 'numeric' | 'text';

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
    /**
     * FROM clause for the count, when `from` carries joins that only add display columns
     * (lateral look-ups per row). Must produce the same rows for the same `where`.
     */
    countFrom?: string;
    where: string[];
    params: unknown[];
    sortColumns: Record<string, string>;
    tiebreak: string;
    query: PageQuery;
    map: (row: Row) => T;
    /**
     * Enables keyset pagination: the type of each sortable expression (all NOT NULL) and of
     * the tiebreak. Lists without it answer `pagination=cursor` with 400.
     */
    cursor?: { types: Record<string, CursorType>; tiebreakType: 'uuid' };
  },
): Promise<Paged<T>> {
  const sort = opts.sortColumns[opts.query.sortBy];
  if (!sort) throw new Error(`sortBy ${opts.query.sortBy} is not whitelisted`);
  if (opts.query.pagination === 'cursor' || opts.query.cursor !== undefined) {
    return runKeyset(db, { ...opts, sort });
  }
  const where = opts.where.length ? `WHERE ${opts.where.join(' AND ')}` : '';
  const n = opts.params.length;
  const [count, rows] = await Promise.all([
    db.one<{ total: string }>(
      `SELECT count(*) AS total FROM ${opts.countFrom ?? opts.from} ${where}`,
      opts.params,
    ),
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

interface CursorPayload {
  v: 1;
  /** n = rows after the key, p = rows before it. */
  d: 'n' | 'p';
  /** Sort key as PostgreSQL text (keeps microseconds that a JS Date would lose). */
  k: string;
  /** Tiebreak id. */
  i: string;
  /** Fingerprint of sort + filters + authorised scope the cursor was issued for. */
  f: string;
}

const invalidCursor = () =>
  new BadRequestException({
    code: 'INVALID_CURSOR',
    message: 'This page link is no longer valid. Go back to the first page.',
  });

const cursorSchema = z.strictObject({
  v: z.literal(1),
  d: z.enum(['n', 'p']),
  k: z.string().max(200),
  i: z.uuid(),
  f: z.string().regex(/^[0-9a-f]{16}$/),
});

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through
  }
  throw invalidCursor();
}

/**
 * Binds a cursor to the query it came from: sort, order and the exact WHERE + parameters.
 * The parameters include the caller's authorised branch ids, so a cursor replayed with
 * other filters, another sort or by a user with a different scope is rejected (400).
 */
function fingerprint(sortBy: string, order: string, where: string[], params: unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify([sortBy, order, where, params]))
    .digest('hex')
    .slice(0, 16);
}

async function runKeyset<Row, T>(
  db: Db,
  opts: Parameters<typeof runPaged<Row, T>>[1] & { sort: string },
): Promise<Paged<T>> {
  const { query, sort } = opts;
  const type = opts.cursor?.types[query.sortBy];
  if (!opts.cursor || !type) {
    throw new BadRequestException({
      code: 'CURSOR_UNSUPPORTED',
      message: 'This list does not support cursor pagination for that sort.',
    });
  }
  const fp = fingerprint(query.sortBy, query.sortOrder, opts.where, opts.params);
  const at = query.cursor ? decodeCursor(query.cursor) : undefined;
  if (at && at.f !== fp) throw invalidCursor();

  const where = [...opts.where];
  const params = [...opts.params];
  const backwards = at?.d === 'p';
  if (at) {
    params.push(at.k, at.i);
    const n = params.length;
    // Rows strictly after (or before) the key in the requested order; (sort, id) is unique.
    const after = (query.sortOrder === 'DESC') !== backwards ? '<' : '>';
    // The scalar bound is redundant but lets the existing (…, created_at) indexes serve the
    // range: PostgreSQL only uses a row comparison as an index bound when the index holds
    // both columns.
    where.push(
      `${sort} ${after}= $${n - 1}::${type}`,
      `(${sort}, ${opts.tiebreak}) ${after} ($${n - 1}::${type}, $${n}::${opts.cursor.tiebreakType})`,
    );
  }
  const order = backwards ? (query.sortOrder === 'DESC' ? 'ASC' : 'DESC') : query.sortOrder;
  params.push(query.limit + 1);
  const rows = await db.query<Row & { __k: string; __i: string }>(
    `SELECT ${opts.select}, (${sort})::text AS __k, (${opts.tiebreak})::text AS __i
       FROM ${opts.from} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${sort} ${order}, ${opts.tiebreak} ${order}
      LIMIT $${params.length}`,
    params,
  );
  const more = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  if (backwards) page.reverse();

  const first = page[0];
  const last = page[page.length - 1];
  const hasNextPage = backwards ? true : more;
  const hasPreviousPage = backwards ? more : at !== undefined;
  const cursorAt = (row: { __k: string; __i: string }, d: 'n' | 'p') =>
    encodeCursor({ v: 1, d, k: row.__k, i: row.__i, f: fp });
  // An empty page after a cursor (rows deleted meanwhile) still lets the user go back.
  const meta: CursorPageMeta = {
    pagination: 'cursor',
    limit: query.limit,
    hasNextPage: page.length > 0 && hasNextPage,
    hasPreviousPage: page.length > 0 ? hasPreviousPage : at !== undefined,
    nextCursor: last && hasNextPage ? cursorAt(last, 'n') : null,
    prevCursor: first && hasPreviousPage ? cursorAt(first, 'p') : null,
  };
  if (page.length === 0 && at) {
    // Nothing left in this direction: offer the way back from the cursor's own position.
    meta.prevCursor = at.d === 'n' ? encodeCursor({ ...at, d: 'p' }) : null;
    meta.nextCursor = at.d === 'p' ? encodeCursor({ ...at, d: 'n' }) : null;
    meta.hasPreviousPage = meta.prevCursor !== null;
    meta.hasNextPage = meta.nextCursor !== null;
  }
  return new Paged(
    page.map(({ __k: _k, __i: _i, ...row }) => opts.map(row as unknown as Row)),
    meta,
  );
}

export function pageMeta(page: number, limit: number, total: number): OffsetPageMeta {
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
