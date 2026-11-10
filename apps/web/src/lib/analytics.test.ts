import { describe, expect, it } from 'vitest';
import type { Trend } from './analytics';
import { trendCsvRows } from './analytics-export';

describe('trendCsvRows', () => {
  it('exports one row per bucket with money in major units and the currency in the header', () => {
    const t = {
      currencyCode: 'INR ',
      granularity: 'day',
      points: [
        {
          bucket: '2026-11-01T00',
          netSales: 123456,
          collected: 100000,
          refunds: 5,
          ordersPlaced: 12,
          completedOrders: 10,
          cancelled: 1,
        },
        {
          bucket: '2026-11-02T00',
          netSales: 0,
          collected: 0,
          refunds: 0,
          ordersPlaced: 0,
          completedOrders: 0,
          cancelled: 0,
        },
      ],
    } as unknown as Trend;
    const rows = trendCsvRows(t);
    expect(rows[0]).toEqual([
      'Period',
      'Net sales (INR)',
      'Collected (INR)',
      'Refunds (INR)',
      'Orders placed',
      'Completed orders',
      'Cancelled orders',
    ]);
    expect(rows[1]).toEqual(['2026-11-01T00', '1234.56', '1000.00', '0.05', 12, 10, 1]);
    expect(rows).toHaveLength(3);
  });
});
