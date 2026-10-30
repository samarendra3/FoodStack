import { describe, expect, it } from 'vitest';
import { cursorPaginationSchema, moneyAmountSchema } from './common.js';

describe('common schemas', () => {
  it('rejects fractional money', () => {
    expect(moneyAmountSchema.safeParse(10.5).success).toBe(false);
  });

  it('defaults pagination limit', () => {
    expect(cursorPaginationSchema.parse({})).toEqual({ limit: 50 });
  });
});
