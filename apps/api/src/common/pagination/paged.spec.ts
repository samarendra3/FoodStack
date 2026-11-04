import { z } from 'zod';
import { likeTerm, pageMeta, pageQuerySchema } from './paged';

const schema = pageQuerySchema(['createdAt', 'total'] as const, 'createdAt', {
  status: z.enum(['open', 'completed']).optional(),
});

describe('pagination', () => {
  it('applies defaults', () => {
    expect(schema.parse({})).toEqual({
      page: 1,
      limit: 25,
      sortBy: 'createdAt',
      sortOrder: 'DESC',
    });
  });

  it('coerces query strings and normalizes sortOrder', () => {
    expect(
      schema.parse({ page: '3', limit: '50', sortBy: 'total', sortOrder: 'asc', status: 'open' }),
    ).toMatchObject({
      page: 3,
      limit: 50,
      sortBy: 'total',
      sortOrder: 'ASC',
      status: 'open',
    });
  });

  it('rejects page sizes, sort columns and fields outside the whitelist', () => {
    expect(schema.safeParse({ limit: '1000' }).success).toBe(false);
    expect(schema.safeParse({ limit: '7' }).success).toBe(false);
    expect(schema.safeParse({ sortBy: 'password_hash' }).success).toBe(false);
    expect(schema.safeParse({ sortBy: 'createdAt; DROP TABLE orders' }).success).toBe(false);
    expect(schema.safeParse({ sortOrder: 'sideways' }).success).toBe(false);
    expect(schema.safeParse({ page: '0' }).success).toBe(false);
    expect(schema.safeParse({ unknown: 'x' }).success).toBe(false);
  });

  it('validates the date range', () => {
    expect(schema.safeParse({ from: '2026-02-01', to: '2026-01-01' }).success).toBe(false);
    expect(schema.safeParse({ from: 'yesterday' }).success).toBe(false);
    expect(schema.safeParse({ from: '2026-01-01', to: '2026-01-31' }).success).toBe(true);
  });

  it('computes page metadata', () => {
    expect(pageMeta(1, 10, 100)).toEqual({
      page: 1,
      limit: 10,
      total: 100,
      totalPages: 10,
      hasNextPage: true,
      hasPreviousPage: false,
    });
    expect(pageMeta(10, 10, 100)).toMatchObject({ hasNextPage: false, hasPreviousPage: true });
    expect(pageMeta(1, 25, 0)).toMatchObject({ totalPages: 1, hasNextPage: false });
  });

  it('escapes LIKE wildcards in search terms', () => {
    expect(likeTerm('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });
});
