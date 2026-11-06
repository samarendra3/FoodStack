import { granularityFor, localToday, resolveRange } from './analytics-range';
import { compare } from './analytics.service';
import { analyticsQuerySchema } from './analytics.schemas';
import { metricName } from '../../shared/cache/cache.keys';
import { CacheEntry, CacheNs } from '../../shared/cache/cache.keys';

describe('resolveRange', () => {
  const today = '2026-03-15';

  it.each([
    ['today', '2026-03-15', '2026-03-15', '2026-03-14', '2026-03-14', true],
    ['yesterday', '2026-03-14', '2026-03-14', '2026-03-13', '2026-03-13', false],
    ['last7', '2026-03-09', '2026-03-15', '2026-03-02', '2026-03-08', true],
    ['last30', '2026-02-14', '2026-03-15', '2026-01-15', '2026-02-13', true],
    ['thisMonth', '2026-03-01', '2026-03-15', '2026-02-01', '2026-02-15', true],
    ['lastMonth', '2026-02-01', '2026-02-28', '2026-01-01', '2026-01-31', false],
    ['thisYear', '2026-01-01', '2026-03-15', '2025-01-01', '2025-03-15', true],
  ] as const)('%s', (preset, from, to, prevFrom, prevTo, partial) => {
    expect(resolveRange(preset, today)).toMatchObject({ from, to, prevFrom, prevTo, partial });
  });

  it('clamps the comparison month to its length', () => {
    expect(resolveRange('thisMonth', '2026-03-31')).toMatchObject({
      prevFrom: '2026-02-01',
      prevTo: '2026-02-28',
    });
  });

  it('handles January for last month and leap years', () => {
    expect(resolveRange('lastMonth', '2026-01-10')).toMatchObject({
      from: '2025-12-01',
      to: '2025-12-31',
      prevFrom: '2025-11-01',
      prevTo: '2025-11-30',
    });
    expect(resolveRange('lastMonth', '2024-03-05')).toMatchObject({ to: '2024-02-29' });
  });

  it('compares custom ranges with the same number of days before', () => {
    expect(resolveRange('custom', today, { from: '2026-03-01', to: '2026-03-10' })).toMatchObject({
      days: 10,
      prevFrom: '2026-02-19',
      prevTo: '2026-02-28',
      partial: false,
    });
  });

  it('clamps a custom end in the future to today and rejects bad ranges', () => {
    expect(resolveRange('custom', today, { from: '2026-03-10', to: '2026-04-01' })).toMatchObject({
      to: today,
      partial: true,
    });
    expect(() => resolveRange('custom', today, { from: '2026-03-10', to: '2026-03-01' })).toThrow();
    expect(() => resolveRange('custom', today, { from: '2026-04-10', to: '2026-04-11' })).toThrow();
    expect(() => resolveRange('custom', today, { from: '2024-01-01', to: '2026-01-01' })).toThrow();
  });

  it('picks bucket granularity from the length', () => {
    expect(granularityFor(1)).toBe('hour');
    expect(granularityFor(7)).toBe('day');
    expect(granularityFor(92)).toBe('day');
    expect(granularityFor(200)).toBe('month');
  });
});

describe('localToday', () => {
  it('uses the restaurant timezone, not UTC', () => {
    const lateUtc = new Date('2026-03-15T20:00:00Z'); // 01:30 on the 16th in India
    expect(localToday('Asia/Kolkata', lateUtc)).toBe('2026-03-16');
    expect(localToday('UTC', lateUtc)).toBe('2026-03-15');
    expect(localToday('America/New_York', lateUtc)).toBe('2026-03-15');
  });
});

describe('compare', () => {
  it('reports growth and no growth without a base', () => {
    expect(compare(150, 100)).toEqual({ value: 150, previous: 100, changePct: 50 });
    expect(compare(0, 100).changePct).toBe(-100);
    expect(compare(10, 0).changePct).toBeNull();
  });
});

describe('analyticsQuerySchema', () => {
  it('defaults to today and accepts known filters only', () => {
    expect(analyticsQuerySchema.parse({})).toMatchObject({ preset: 'today' });
    expect(analyticsQuerySchema.safeParse({ preset: 'custom', from: '2026-01-01' }).success).toBe(
      false,
    );
    expect(analyticsQuerySchema.safeParse({ from: '2026-01-01', to: '2026-01-02' }).success).toBe(
      false,
    );
    expect(analyticsQuerySchema.safeParse({ tenantId: 'x' }).success).toBe(false);
  });
});

describe('analytics cache keys', () => {
  it('are tenant-scoped and keep metric labels bounded', () => {
    const tenant = '0196a4e2-0000-7000-8000-000000000001';
    expect(CacheNs.analytics(tenant)).toBe(`tenant:${tenant}:analytics`);
    const entry = CacheEntry.analytics('core', 'a'.repeat(32));
    expect(metricName(CacheNs.analytics(tenant), entry)).toBe('analytics:core:scope');
    expect(() => CacheEntry.analytics('core', 'x:y')).toThrow();
  });
});
