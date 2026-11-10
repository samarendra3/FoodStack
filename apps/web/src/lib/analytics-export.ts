/** Pure analytics export helpers (no React), shared by the dashboard and tests. */
import type { Trend } from './analytics';

/**
 * Sales report rows for CSV export of a trend (one row per bucket, local time). Money is in
 * major units with two decimals so spreadsheets sum it directly; the header names the currency.
 */
export function trendCsvRows(t: Trend): (string | number)[][] {
  const money = (minor: number) => (minor / 100).toFixed(2);
  const c = t.currencyCode.trim();
  return [
    [
      'Period',
      `Net sales (${c})`,
      `Collected (${c})`,
      `Refunds (${c})`,
      'Orders placed',
      'Completed orders',
      'Cancelled orders',
    ],
    ...t.points.map((p) => [
      p.bucket,
      money(p.netSales),
      money(p.collected),
      money(p.refunds),
      p.ordersPlaced,
      p.completedOrders,
      p.cancelled,
    ]),
  ];
}
