'use client';

import { cn } from '@foodstack/ui/lib/utils';
import {
  ChartColumnIncreasing,
  LayoutGrid,
  PackageX,
  TrendingDown,
  Trophy,
  UtensilsCrossed,
} from 'lucide-react';
import { useState } from 'react';
import {
  count,
  type Filters,
  inr,
  type MenuItemRow,
  type MenuStats,
  useAnalytics,
} from '@/lib/analytics';
import { downloadCsv } from '@/lib/csv';
import { RankedBars } from '../dashboard/charts';
import {
  Card,
  control,
  CsvButton,
  EmptyNote,
  ErrorNote,
  PageHeader,
  ReportFilters,
  Skeleton,
  Stat,
  StatGrid,
} from '../_kit/report-kit';

type Sort = 'revenue' | 'quantity';
const PAGE_SIZE = 20;

export default function ProductPerformancePage() {
  const [filters, setFilters] = useState<Filters>({ preset: 'last30' });
  const [sort, setSort] = useState<Sort>('revenue');
  const [page, setPage] = useState(1);
  const menu = useAnalytics<MenuStats>('menu', filters, { sort, page, pageSize: PAGE_SIZE });
  const m = menu.data;
  const money = (v: number) => inr(v, m?.currencyCode ?? 'INR');
  const pages = m ? Math.max(1, Math.ceil(m.items.total / m.items.pageSize)) : 1;

  const exportCsv = () => {
    if (!m) return;
    downloadCsv(`product-performance-${m.range.from}-to-${m.range.to}.csv`, [
      ['Item', 'Category', 'Quantity', 'Orders', 'Revenue'],
      ...m.topSelling.map((r) => [
        r.name,
        r.categoryName ?? '',
        r.quantity,
        r.orders,
        (r.revenue / 100).toFixed(2),
      ]),
    ]);
  };

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Product Performance"
        description="Which dishes sell, which earn, and which are not moving."
        actions={<CsvButton onClick={exportCsv} disabled={!m} />}
      />
      <ReportFilters
        filters={filters}
        onChange={(f) => {
          setFilters(f);
          setPage(1);
        }}
        meta={m}
      />
      {menu.isError ? <ErrorNote error={menu.error} /> : null}

      <StatGrid>
        <Stat
          icon={UtensilsCrossed}
          label="Items sold"
          value={m ? count(m.totals.itemsSold) : undefined}
          loading={menu.isPending}
        />
        <Stat
          icon={LayoutGrid}
          label="Distinct dishes sold"
          value={m ? count(m.totals.distinctItems) : undefined}
          loading={menu.isPending}
        />
        <Stat
          icon={ChartColumnIncreasing}
          label="Item revenue"
          value={m ? money(m.totals.revenueMinor) : undefined}
          loading={menu.isPending}
        />
        <Stat
          icon={PackageX}
          label="Not sold"
          value={m ? count(m.unsold.length) : undefined}
          hint="Dishes with no sales"
          loading={menu.isPending}
        />
      </StatGrid>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card icon={Trophy} title="Top sellers" subtitle="By quantity">
          <Ranked
            rows={m?.topSelling}
            pending={menu.isPending}
            value={(r) => r.quantity}
            format={count}
            note={(r) => money(r.revenue)}
          />
        </Card>
        <Card icon={ChartColumnIncreasing} title="Top earners" subtitle="By revenue">
          <Ranked
            rows={m?.bestPerforming}
            pending={menu.isPending}
            value={(r) => r.revenue}
            format={money}
            note={(r) => `${count(r.quantity)} sold`}
            colorIndex={1}
          />
        </Card>
        <Card
          icon={TrendingDown}
          title="Slow movers"
          subtitle={m?.lowPerformingNote ?? 'Fewest sales among dishes that sold'}
        >
          <Ranked
            rows={m?.lowPerforming ?? []}
            pending={menu.isPending}
            value={(r) => r.quantity}
            format={count}
            note={(r) => money(r.revenue)}
            colorIndex={2}
          />
        </Card>
        <Card icon={LayoutGrid} title="By category" subtitle="Share of item revenue">
          {m && m.categories.length > 0 ? (
            <RankedBars
              ariaLabel="Revenue by category"
              format={money}
              rows={m.categories.map((c) => ({
                key: c.categoryId,
                label: c.name,
                value: c.revenue,
                note: c.sharePct === null ? undefined : `${c.sharePct}%`,
              }))}
            />
          ) : menu.isPending ? (
            <Skeleton className="h-40" />
          ) : (
            <EmptyNote
              icon={LayoutGrid}
              title="No category sales"
              text="Nothing sold in this period."
            />
          )}
        </Card>
      </div>

      <Card
        icon={UtensilsCrossed}
        title="All dishes"
        subtitle={m ? `${count(m.items.total)} dishes with sales` : undefined}
        aside={
          <select
            aria-label="Sort by"
            className={control}
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as Sort);
              setPage(1);
            }}
          >
            <option value="revenue">Sort: revenue</option>
            <option value="quantity">Sort: quantity</option>
          </select>
        }
      >
        {m && m.items.rows.length > 0 ? (
          <>
            <div className="-mx-4 overflow-x-auto sm:mx-0">
              <table className="w-full min-w-[36rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-muted-foreground uppercase dark:border-white/10">
                    <th className="px-4 py-2 font-medium sm:px-2">Dish</th>
                    <th className="px-2 py-2 font-medium">Category</th>
                    <th className="px-2 py-2 text-right font-medium">Qty</th>
                    <th className="px-2 py-2 text-right font-medium">Orders</th>
                    <th className="px-4 py-2 text-right font-medium sm:px-2">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {m.items.rows.map((r) => (
                    <tr
                      key={r.menuItemId}
                      className="border-b border-slate-100 last:border-0 dark:border-white/5"
                    >
                      <td className="px-4 py-2.5 font-medium sm:px-2">
                        {r.name}
                        {r.deleted ? (
                          <span className="ml-2 text-xs text-muted-foreground">(removed)</span>
                        ) : null}
                      </td>
                      <td className="px-2 py-2.5 text-muted-foreground">{r.categoryName ?? '—'}</td>
                      <td className="px-2 py-2.5 text-right tabular-nums">{count(r.quantity)}</td>
                      <td className="px-2 py-2.5 text-right tabular-nums">{count(r.orders)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums sm:px-2">
                        {money(r.revenue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
              <span>
                Page {page} of {pages}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={cn(control, 'px-3')}
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className={cn(control, 'px-3')}
                  disabled={page >= pages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </>
        ) : menu.isPending ? (
          <Skeleton className="h-40" />
        ) : (
          <EmptyNote icon={UtensilsCrossed} title="No dishes sold" text="Try a wider date range." />
        )}
      </Card>

      {m && m.unsold.length > 0 ? (
        <Card
          icon={PackageX}
          title="Not sold in this period"
          subtitle="Consider promoting, repricing or removing these"
        >
          <ul className="flex flex-wrap gap-2">
            {m.unsold.map((u) => (
              <li
                key={u.id}
                className="rounded-md bg-slate-100 px-2.5 py-1 text-sm dark:bg-white/10"
              >
                {u.name}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function Ranked({
  rows,
  pending,
  value,
  format,
  note,
  colorIndex,
}: {
  rows: MenuItemRow[] | undefined;
  pending: boolean;
  value: (r: MenuItemRow) => number;
  format: (v: number) => string;
  note: (r: MenuItemRow) => string;
  colorIndex?: number;
}) {
  if (pending && !rows) return <Skeleton className="h-40" />;
  if (!rows || rows.length === 0)
    return (
      <EmptyNote
        icon={UtensilsCrossed}
        title="Nothing to rank"
        text="No dishes sold in this period."
      />
    );
  return (
    <RankedBars
      ariaLabel="Dishes"
      format={format}
      colorIndex={colorIndex}
      rows={rows
        .slice(0, 8)
        .map((r) => ({ key: r.menuItemId, label: r.name, value: value(r), note: note(r) }))}
    />
  );
}
