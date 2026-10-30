import { describe, expect, it } from 'vitest';
import { formatMoney, slugify } from './index.js';

describe('formatMoney', () => {
  it('formats minor units', () => {
    expect(formatMoney(123450, 'INR')).toBe('₹1,234.50');
  });

  it('rejects non-integers', () => {
    expect(() => formatMoney(1.5, 'INR')).toThrow(RangeError);
  });
});

describe('slugify', () => {
  it('creates url-safe slugs', () => {
    expect(slugify('  Spice Hub — Café ')).toBe('spice-hub-cafe');
  });
});
