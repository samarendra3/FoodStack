import { z } from 'zod';
import { decodeCursor, encodeCursor, likeTerm, pageMeta, pageQuerySchema } from './paged';

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
      pagination: 'offset',
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

  describe('cursor', () => {
    const payload = {
      v: 1 as const,
      d: 'n' as const,
      k: '2026-01-01 10:00:00.000003+00',
      i: '01a1af83-f19a-786b-9422-073180fd157e',
      f: '0123456789abcdef',
    };

    it('accepts pagination=cursor and a URL-safe cursor only', () => {
      expect(schema.parse({ pagination: 'cursor' })).toMatchObject({ pagination: 'cursor' });
      expect(schema.safeParse({ cursor: encodeCursor(payload) }).success).toBe(true);
      expect(schema.safeParse({ pagination: 'keyset' }).success).toBe(false);
      expect(schema.safeParse({ cursor: 'abc def' }).success).toBe(false);
      expect(schema.safeParse({ cursor: 'a'.repeat(513) }).success).toBe(false);
    });

    it('round-trips and keeps microseconds in the sort key', () => {
      expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
    });

    it.each([
      ['not json', Buffer.from('nope').toString('base64url')],
      ['wrong version', encodeCursor({ ...payload, v: 2 as never })],
      ['bad id', encodeCursor({ ...payload, i: "1' OR 1=1" })],
      ['bad fingerprint', encodeCursor({ ...payload, f: 'XYZ' })],
      ['extra field', Buffer.from(JSON.stringify({ ...payload, x: 1 })).toString('base64url')],
      [
        'object key',
        Buffer.from(JSON.stringify({ ...payload, k: { a: 1 } })).toString('base64url'),
      ],
    ])('rejects a cursor with %s as 400 INVALID_CURSOR', (_label, cursor) => {
      expect(() => decodeCursor(cursor)).toThrow(
        expect.objectContaining({ response: expect.objectContaining({ code: 'INVALID_CURSOR' }) }),
      );
    });
  });
});
