'use client';

import { Button } from '@foodstack/ui/components/button';
import { cn } from '@foodstack/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDownToLine,
  BookOpen,
  Boxes,
  Download,
  Lock,
  MapPin,
  MinusCircle,
  PackageX,
  ReceiptText,
  ShoppingCart,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { authErrorMessage } from '@/lib/auth/errors';
import { formatQty } from '@/lib/inventory';
import { DIET_LABEL, type Diet, formatMoney, useMenu } from '@/lib/menu';
import { BarChart, type Series } from './bar-chart';

// ---------- data ----------

type Move = 'purchase' | 'usage' | 'wastage' | 'count';

interface InventoryReport {
  branch: { id: string; name: string; timezone: string };
  branches: { id: string; name: string }[];
  currencyCode: string;
  range: { from: string; to: string };
  valuation: 'current_cost';
  totals: Record<Move, { movements: number; valueMinor: number }>;
  daily: { day: string; type: Exclude<Move, 'count'>; valueMinor: number }[];
  items: {
    id: string;
    name: string;
    unit: string;
    category: string | null;
    purchased: number;
    used: number;
    wasted: number;
    countAdjustment: number;
    wastedValueMinor: number | null;
  }[];
  stock: {
    totalValueMinor: number;
    itemsWithoutCost: number;
    rows: {
      id: string;
      name: string;
      unit: string;
      category: string | null;
      quantity: number;
      lowStockThreshold: number;
      costPerUnitMinor: number | null;
      valueMinor: number | null;
      status: 'ok' | 'low' | 'out';
    }[];
  };
}

function useInventoryReport(branchId: string | null, from: string, to: string) {
  const { client } = useAuth();
  const profile = useProfile();
  return useQuery({
    queryKey: ['reports', 'inventory', profile.activeTenant?.id, branchId, from, to],
    queryFn: () => {
      const q = new URLSearchParams({ from, to });
      if (branchId) q.set('branchId', branchId);
      return client.request<InventoryReport>(`/reports/inventory?${q}`);
    },
    placeholderData: (prev) => prev,
  });
}

// ---------- dates ----------

const iso = (d: Date) => new Intl.DateTimeFormat('en-CA').format(d);
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return iso(d);
};
const PRESETS = [
  { id: '7d', label: 'Last 7 days', from: () => daysAgo(6) },
  { id: '30d', label: 'Last 30 days', from: () => daysAgo(29) },
  {
    id: 'month',
    label: 'This month',
    from: () => iso(new Date(new Date().getFullYear(), new Date().getMonth(), 1)),
  },
  { id: '90d', label: 'Last 90 days', from: () => daysAgo(89) },
] as const;

// Validated 3-slot categorical palette (light/dark), fixed order: stock in, usage, wastage.
const SERIES: Series[] = [
  { key: 'purchase', label: 'Stock in', light: '#2a78d6', dark: '#3987e5' },
  { key: 'usage', label: 'Usage', light: '#eb6834', dark: '#d95926' },
  { key: 'wastage', label: 'Wastage', light: '#1baf7a', dark: '#199e70' },
];

type Tab = 'inventory' | 'menu' | 'sales';

export default function ReportsPage() {
  const [tab, setTab] = useState<Tab>('inventory');
  const [branchId, setBranchId] = useState<string | null>(null);
  const [preset, setPreset] = useState<string>('30d');
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(iso(new Date()));
  const report = useInventoryReport(branchId, from, to);
  const menu = useMenu();

  const choosePreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id);
    setPreset(id);
    if (p) {
      setFrom(p.from());
      setTo(iso(new Date()));
    }
  };

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
          <p className="text-sm text-muted-foreground">
            Stock movement, wastage and menu insights from your live data.
          </p>
        </div>
        {tab === 'inventory' ? (
          <div className="flex flex-wrap items-center gap-2">
            {report.data && report.data.branches.length > 1 ? (
              <label className="relative flex items-center">
                <MapPin className="pointer-events-none absolute left-3 size-4 text-muted-foreground" />
                <span className="sr-only">Branch</span>
                <select
                  value={report.data.branch.id}
                  onChange={(e) => setBranchId(e.target.value)}
                  className="h-9 rounded-md border bg-card pr-3 pl-9 text-sm"
                >
                  {report.data.branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <select
              aria-label="Date range"
              value={preset}
              onChange={(e) => choosePreset(e.target.value)}
              className="h-9 rounded-md border bg-card px-3 text-sm"
            >
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Custom range</option>
            </select>
            {preset === 'custom' ? (
              <>
                <input
                  type="date"
                  aria-label="From"
                  value={from}
                  max={to}
                  onChange={(e) => setFrom(e.target.value)}
                  className="h-9 rounded-md border bg-card px-2 text-sm"
                />
                <input
                  type="date"
                  aria-label="To"
                  value={to}
                  min={from}
                  max={iso(new Date())}
                  onChange={(e) => setTo(e.target.value)}
                  className="h-9 rounded-md border bg-card px-2 text-sm"
                />
              </>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              disabled={!report.data}
              onClick={() => report.data && exportInventory(report.data)}
            >
              <Download /> Export CSV
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex gap-1 border-b" role="tablist">
        {(
          [
            { id: 'inventory', label: 'Inventory', icon: Boxes },
            { id: 'menu', label: 'Menu', icon: BookOpen },
            { id: 'sales', label: 'Sales & orders', icon: TrendingUp },
          ] as const
        ).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              '-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              tab === id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-4" /> {label}
          </button>
        ))}
      </div>

      {tab === 'inventory' ? (
        <InventoryTab report={report} />
      ) : tab === 'menu' ? (
        <MenuTab menu={menu} />
      ) : (
        <SalesTab />
      )}
    </div>
  );
}

// ---------- inventory ----------

function InventoryTab({ report }: { report: ReturnType<typeof useInventoryReport> }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const r = report.data;

  const buckets = useMemo(() => (r ? bucketDaily(r) : []), [r]);

  if (report.isError) {
    return <ErrorBox message={authErrorMessage(report.error)} />;
  }
  if (!r) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-muted" />
          ))}
        </div>
        <div className="h-72 animate-pulse rounded-2xl bg-muted" />
      </div>
    );
  }

  const money = (minor: number) => formatMoney(minor, r.currencyCode);
  const wastePct =
    r.totals.usage.valueMinor > 0
      ? (r.totals.wastage.valueMinor / r.totals.usage.valueMinor) * 100
      : null;
  const noActivity = Object.values(r.totals).every((t) => t.movements === 0);
  const topWaste = [...r.items]
    .filter((i) => i.wasted > 0)
    .sort((a, b) => (b.wastedValueMinor ?? 0) - (a.wastedValueMinor ?? 0))
    .slice(0, 5);
  const attention = r.stock.rows.filter((s) => s.status !== 'ok');

  return (
    <div className={cn('space-y-6 transition-opacity', report.isFetching && 'opacity-70')}>
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Kpi
          icon={ArrowDownToLine}
          label="Stock in"
          value={money(r.totals.purchase.valueMinor)}
          note={`${r.totals.purchase.movements} deliveries`}
        />
        <Kpi
          icon={MinusCircle}
          label="Usage"
          value={money(r.totals.usage.valueMinor)}
          note={`${r.totals.usage.movements} entries`}
        />
        <Kpi
          icon={PackageX}
          label="Wastage"
          value={money(r.totals.wastage.valueMinor)}
          note={
            wastePct === null
              ? `${r.totals.wastage.movements} entries`
              : `${wastePct.toFixed(1)}% of usage`
          }
        />
        <Kpi
          icon={Wallet}
          label="Stock on hand"
          value={money(r.stock.totalValueMinor)}
          note={
            r.stock.itemsWithoutCost
              ? `${r.stock.itemsWithoutCost} items have no cost`
              : 'At current cost'
          }
        />
      </div>

      <section className="rounded-2xl border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">Stock movement value</h2>
            <p className="text-xs text-muted-foreground">
              {r.branch.name} · {buckets.length > 0 && buckets[0]!.weekly ? 'weekly' : 'daily'} ·
              valued at each item&apos;s current cost
            </p>
          </div>
          <div className="flex rounded-lg border p-0.5 text-xs font-medium">
            {(['chart', 'table'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className={cn(
                  'rounded-md px-2.5 py-1 capitalize',
                  view === v ? 'bg-muted text-foreground' : 'text-muted-foreground',
                )}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
        {noActivity ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            No stock movements in this period. Record stock in, usage or wastage on the Inventory
            page.
          </p>
        ) : view === 'chart' ? (
          <BarChart className="mt-4" series={SERIES} buckets={buckets} format={money} />
        ) : (
          <div className="mt-4 max-h-80 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-2">Period</th>
                  {SERIES.map((s) => (
                    <th key={s.key} className="py-2 text-right">
                      {s.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {buckets
                  .filter((b) => SERIES.some((s) => b.values[s.key]))
                  .map((b) => (
                    <tr key={b.key}>
                      <td className="py-2">{b.label}</td>
                      {SERIES.map((s) => (
                        <td key={s.key} className="py-2 text-right tabular-nums">
                          {money(b.values[s.key] ?? 0)}
                        </td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Top wastage" subtitle="Highest wasted value in this period">
          {topWaste.length === 0 ? (
            <Empty text="No wastage recorded in this period." />
          ) : (
            <ul className="divide-y">
              {topWaste.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="min-w-0 truncate font-medium">{i.name}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatQty(i.wasted)} {i.unit}
                  </span>
                  <span className="w-24 shrink-0 text-right font-semibold tabular-nums">
                    {i.wastedValueMinor === null ? '—' : money(i.wastedValueMinor)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Needs attention" subtitle="Low or out of stock right now">
          {attention.length === 0 ? (
            <Empty text="Everything is above its low-stock alert." />
          ) : (
            <ul className="divide-y">
              {attention.slice(0, 8).map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="min-w-0 truncate font-medium">{s.name}</span>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-xs font-semibold',
                      s.status === 'out'
                        ? 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300'
                        : 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
                    )}
                  >
                    {s.status === 'out' ? 'Out of stock' : 'Low stock'}
                  </span>
                  <span className="w-28 shrink-0 text-right tabular-nums">
                    {formatQty(s.quantity)} / {formatQty(s.lowStockThreshold)} {s.unit}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Item movement" subtitle="Totals per item for the selected period">
        {r.items.length === 0 ? (
          <Empty text="No item had stock movement in this period." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-2">Item</th>
                  <th className="py-2 text-right">Stock in</th>
                  <th className="py-2 text-right">Used</th>
                  <th className="py-2 text-right">Wasted</th>
                  <th className="py-2 text-right">Count adj.</th>
                  <th className="py-2 text-right">Wasted value</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {r.items.map((i) => (
                  <tr key={i.id}>
                    <td className="py-2.5">
                      <span className="font-medium">{i.name}</span>
                      <span className="ml-1.5 text-xs text-muted-foreground">{i.unit}</span>
                    </td>
                    <td className="py-2.5 text-right tabular-nums">{formatQty(i.purchased)}</td>
                    <td className="py-2.5 text-right tabular-nums">{formatQty(i.used)}</td>
                    <td className="py-2.5 text-right tabular-nums">{formatQty(i.wasted)}</td>
                    <td className="py-2.5 text-right tabular-nums">
                      {i.countAdjustment > 0 ? '+' : ''}
                      {formatQty(i.countAdjustment)}
                    </td>
                    <td className="py-2.5 text-right tabular-nums">
                      {i.wastedValueMinor === null ? '—' : money(i.wastedValueMinor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

interface Bucket {
  key: string;
  label: string;
  weekly: boolean;
  values: Partial<Record<string, number>>;
}

/** Every day in range (zeros included); weekly buckets past 45 days. */
function bucketDaily(r: InventoryReport): Bucket[] {
  const start = new Date(`${r.range.from}T00:00:00`);
  const end = new Date(`${r.range.to}T00:00:00`);
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const weekly = days > 45;
  const fmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
  const out = new Map<string, Bucket>();
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + (weekly ? i - (i % 7) : i));
    const key = iso(d);
    if (!out.has(key))
      out.set(key, {
        key,
        label: weekly ? `Wk of ${fmt.format(d)}` : fmt.format(d),
        weekly,
        values: {},
      });
  }
  const keys = [...out.keys()];
  for (const p of r.daily) {
    const idx = Math.round(
      (new Date(`${p.day}T00:00:00`).getTime() - start.getTime()) / 86_400_000,
    );
    const key = keys[weekly ? Math.floor(idx / 7) : idx];
    const b = key ? out.get(key) : undefined;
    if (b) b.values[p.type] = (b.values[p.type] ?? 0) + p.valueMinor;
  }
  return [...out.values()];
}

function exportInventory(r: InventoryReport) {
  const money = (m: number | null) => (m === null ? '' : (m / 100).toFixed(2));
  const rows = [
    [
      `Inventory report — ${r.branch.name}`,
      `${r.range.from} to ${r.range.to}`,
      `Values in ${r.currencyCode} at current cost`,
    ],
    [],
    ['Item', 'Unit', 'Category', 'Stock in', 'Used', 'Wasted', 'Count adjustment', 'Wasted value'],
    ...r.items.map((i) => [
      i.name,
      i.unit,
      i.category ?? '',
      i.purchased,
      i.used,
      i.wasted,
      i.countAdjustment,
      money(i.wastedValueMinor),
    ]),
    [],
    [
      'Current stock',
      'Unit',
      'Category',
      'On hand',
      'Low-stock alert',
      'Cost per unit',
      'Value',
      'Status',
    ],
    ...r.stock.rows.map((s) => [
      s.name,
      s.unit,
      s.category ?? '',
      s.quantity,
      s.lowStockThreshold,
      money(s.costPerUnitMinor),
      money(s.valueMinor),
      s.status,
    ]),
  ];
  const csv = rows
    .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `inventory-report-${r.range.from}-to-${r.range.to}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- menu ----------

function MenuTab({ menu }: { menu: ReturnType<typeof useMenu> }) {
  if (menu.isError) return <ErrorBox message={authErrorMessage(menu.error)} />;
  if (!menu.data) return <div className="h-72 animate-pulse rounded-2xl bg-muted" />;
  const { items, categories, restaurant } = menu.data;
  if (items.length === 0)
    return (
      <Empty text="No menu items yet. Add dishes in Menu Management to see menu insights." boxed />
    );

  const money = (m: number) => formatMoney(m, restaurant.currencyCode);
  const available = items.filter((i) => i.isAvailable).length;
  const avg = Math.round(items.reduce((n, i) => n + i.priceMinor, 0) / items.length);
  const byDiet = (Object.keys(DIET_LABEL) as Diet[]).map((d) => ({
    d,
    n: items.filter((i) => i.diet === d).length,
  }));
  const rows = categories.map((c) => {
    const list = items.filter((i) => i.categoryId === c.id);
    const prices = list.map((i) => i.priceMinor);
    return {
      c,
      count: list.length,
      soldOut: list.filter((i) => !i.isAvailable).length,
      min: prices.length ? Math.min(...prices) : null,
      max: prices.length ? Math.max(...prices) : null,
      avg: prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null,
    };
  });

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Kpi
          icon={BookOpen}
          label="Menu items"
          value={String(items.length)}
          note={`${categories.length} categories`}
        />
        <Kpi
          icon={ShoppingCart}
          label="Available now"
          value={String(available)}
          note={`${items.length - available} sold out`}
        />
        <Kpi icon={Wallet} label="Average price" value={money(avg)} note="Across all items" />
        <Kpi
          icon={Boxes}
          label="Veg / Non-veg / Egg"
          value={byDiet.map((x) => x.n).join(' / ')}
          note="Item count by type"
        />
      </div>
      <Panel title="By category" subtitle="Item counts and price ranges">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2">Category</th>
                <th className="py-2 text-right">Items</th>
                <th className="py-2 text-right">Sold out</th>
                <th className="py-2 text-right">Lowest</th>
                <th className="py-2 text-right">Highest</th>
                <th className="py-2 text-right">Average</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map(({ c, count, soldOut, min, max, avg: a }) => (
                <tr key={c.id}>
                  <td className="py-2.5 font-medium">
                    {c.name}
                    {!c.isActive ? (
                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                        Hidden
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2.5 text-right tabular-nums">{count}</td>
                  <td className="py-2.5 text-right tabular-nums">{soldOut}</td>
                  <td className="py-2.5 text-right tabular-nums">
                    {min === null ? '—' : money(min)}
                  </td>
                  <td className="py-2.5 text-right tabular-nums">
                    {max === null ? '—' : money(max)}
                  </td>
                  <td className="py-2.5 text-right tabular-nums">{a === null ? '—' : money(a)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

// ---------- sales (not yet available) ----------

function SalesTab() {
  const cards = [
    {
      icon: TrendingUp,
      title: 'Sales reports',
      body: 'Revenue by day, hour, branch and order type.',
    },
    {
      icon: ShoppingCart,
      title: 'Order reports',
      body: 'Order volume, average ticket size and prep times.',
    },
    {
      icon: BookOpen,
      title: 'Product performance',
      body: 'Best and worst sellers, by quantity and revenue.',
    },
    {
      icon: ReceiptText,
      title: 'Financial reports',
      body: 'Tax, discounts, payment methods and refunds.',
    },
  ];
  return (
    <div className="space-y-4">
      <p className="rounded-xl border bg-muted/40 p-4 text-sm text-muted-foreground">
        These reports need orders, bills and payments. They switch on automatically once the Orders
        and Billing modules go live — no sample numbers are shown until then.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        {cards.map(({ icon: Icon, title, body }) => (
          <div key={title} className="flex gap-4 rounded-2xl border bg-card p-5">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <Icon className="size-5" />
            </span>
            <div>
              <p className="flex items-center gap-2 font-semibold">
                {title}{' '}
                <Lock className="size-3.5 text-muted-foreground" aria-label="Not available yet" />
              </p>
              <p className="mt-1 text-sm text-muted-foreground">{body}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- pieces ----------

function Kpi({
  icon: Icon,
  label,
  value,
  note,
}: {
  icon: typeof Boxes;
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="rounded-2xl border bg-card p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="size-4" /> {label}
      </div>
      <p className="mt-2 truncate text-2xl font-bold tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border bg-card p-5">
      <h2 className="font-semibold">{title}</h2>
      <p className="mb-3 text-xs text-muted-foreground">{subtitle}</p>
      {children}
    </section>
  );
}

function Empty({ text, boxed }: { text: string; boxed?: boolean }) {
  return (
    <p
      className={cn(
        'py-10 text-center text-sm text-muted-foreground',
        boxed && 'rounded-2xl border bg-card',
      )}
    >
      {text}
    </p>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      {message}
    </p>
  );
}
