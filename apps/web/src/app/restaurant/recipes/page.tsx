'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { CookingPot, Plus, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  FormDialog,
  input,
  money,
  Table,
  Toolbar,
  useOps,
  useOpsWrite,
} from '../_kit/ops-kit';
import {
  buttonSecondary,
  Card,
  control,
  EmptyNote,
  ErrorNote,
  PageHeader,
  Skeleton,
  Stat,
  StatGrid,
} from '../_kit/report-kit';

interface RecipeRow {
  menuItemId: string;
  name: string;
  category: string | null;
  priceMinor: number;
  costMinor: number;
  foodCostPct: number | null;
  lines: {
    itemId: string;
    name: string;
    unit: string;
    quantity: number;
    costPerUnitMinor: number;
  }[];
}
interface Recipes {
  currencyCode: string;
  canManage: boolean;
  stockItems: { id: string; name: string; unit: string; costPerUnitMinor: number }[];
  rows: RecipeRow[];
}
/** Food cost above 35% of the price is usually too high for a restaurant dish. */
const tone = (p: number | null) =>
  p === null ? 'slate' : p <= 30 ? 'emerald' : p <= 35 ? 'amber' : 'red';

export default function RecipesPage() {
  const q = useOps<Recipes>('/recipes');
  const d = q.data;
  const m = (v: number) => money(v, d?.currencyCode);
  const [search, setSearch] = useState('');
  const [show, setShow] = useState<'all' | 'with' | 'without'>('all');
  const [edit, setEdit] = useState<RecipeRow | null>(null);
  const rows = (d?.rows ?? []).filter(
    (r) =>
      (!search || r.name.toLowerCase().includes(search.toLowerCase())) &&
      (show === 'all' || (show === 'with' ? r.lines.length > 0 : r.lines.length === 0)),
  );
  const costed = d?.rows.filter((r) => r.foodCostPct !== null) ?? [];
  const avg = costed.length
    ? Math.round((costed.reduce((t, r) => t + r.foodCostPct!, 0) / costed.length) * 10) / 10
    : null;

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Recipes & Ingredients"
        description="What goes into each dish and what it costs you, so you can see the margin on every plate."
      />
      {q.isError ? <ErrorNote error={q.error} /> : null}
      <StatGrid>
        <Stat
          icon={CookingPot}
          label="Dishes with a recipe"
          value={d ? `${costed.length} / ${d.rows.length}` : undefined}
          loading={q.isPending}
        />
        <Stat
          label="Average food cost"
          value={avg === null ? (d ? '—' : undefined) : `${avg}%`}
          hint="Aim for 25–35%"
          loading={q.isPending}
        />
        <Stat
          label="Over 35% food cost"
          value={d ? costed.filter((r) => r.foodCostPct! > 35).length : undefined}
          hint="Consider repricing"
          loading={q.isPending}
        />
        <Stat
          label="Ingredients"
          value={d?.stockItems.length}
          hint="Stock items"
          loading={q.isPending}
        />
      </StatGrid>
      <Toolbar>
        <label className="relative col-span-2 sm:w-72">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
          <input
            aria-label="Search dishes"
            placeholder="Search dishes"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`${control} w-full pl-9`}
          />
        </label>
        <select
          aria-label="Show"
          className={control}
          value={show}
          onChange={(e) => setShow(e.target.value as typeof show)}
        >
          <option value="all">All dishes</option>
          <option value="with">With recipe</option>
          <option value="without">Without recipe</option>
        </select>
      </Toolbar>
      <Card>
        {q.isPending ? (
          <Skeleton className="h-48" />
        ) : rows.length === 0 ? (
          <EmptyNote
            icon={CookingPot}
            title="No dishes match"
            text="Add dishes on the Menu screen and stock items on the Inventory screen, then build recipes here."
          />
        ) : (
          <Table
            rows={rows}
            rowKey={(r) => r.menuItemId}
            onRow={d?.canManage ? setEdit : undefined}
            cols={[
              {
                key: 'n',
                header: 'Dish',
                cell: (r) => <span className="font-medium">{r.name}</span>,
              },
              { key: 'c', header: 'Category', hideOnMobile: true, cell: (r) => r.category ?? '—' },
              {
                key: 'i',
                header: 'Ingredients',
                hideOnMobile: true,
                cell: (r) =>
                  r.lines.length ? (
                    r.lines.map((l) => l.name).join(', ')
                  ) : (
                    <span className="text-muted-foreground">No recipe</span>
                  ),
              },
              { key: 'p', header: 'Price', align: 'right', cell: (r) => m(r.priceMinor) },
              {
                key: 'k',
                header: 'Cost',
                align: 'right',
                cell: (r) => (r.lines.length ? m(r.costMinor) : '—'),
              },
              {
                key: 'g',
                header: 'Margin',
                align: 'right',
                hideOnMobile: true,
                cell: (r) => (r.lines.length ? m(r.priceMinor - r.costMinor) : '—'),
              },
              {
                key: 'f',
                header: 'Food cost',
                align: 'right',
                cell: (r) =>
                  r.foodCostPct === null ? (
                    '—'
                  ) : (
                    <Badge tone={tone(r.foodCostPct)}>{r.foodCostPct}%</Badge>
                  ),
              },
            ]}
          />
        )}
      </Card>
      {d && !d.canManage ? (
        <p className="text-xs text-muted-foreground">View only — menu managers can edit recipes.</p>
      ) : null}
      {edit && d ? (
        <RecipeForm row={edit} stock={d.stockItems} money={m} onClose={() => setEdit(null)} />
      ) : null}
    </div>
  );
}

function RecipeForm({
  row,
  stock,
  money: m,
  onClose,
}: {
  row: RecipeRow;
  stock: Recipes['stockItems'];
  money: (v: number) => string;
  onClose: () => void;
}) {
  const w = useOpsWrite();
  const [lines, setLines] = useState(
    row.lines.map((l) => ({ itemId: l.itemId, quantity: String(l.quantity) })),
  );
  const cost = Math.round(
    lines.reduce(
      (t, l) =>
        t + Number(l.quantity || 0) * (stock.find((s) => s.id === l.itemId)?.costPerUnitMinor ?? 0),
      0,
    ),
  );
  const pct =
    row.priceMinor > 0 && lines.some((l) => l.itemId)
      ? Math.round((cost / row.priceMinor) * 1000) / 10
      : null;
  return (
    <FormDialog
      open
      onClose={onClose}
      size="lg"
      title={`Recipe · ${row.name}`}
      description={`Quantities per one serving. Price ${m(row.priceMinor)}.`}
      onSubmit={() =>
        w.send(`/recipes/${row.menuItemId}`, 'PUT', {
          lines: lines
            .filter((l) => l.itemId)
            .map((l) => ({ itemId: l.itemId, quantity: Number(l.quantity) })),
        })
      }
    >
      {lines.map((l, i) => {
        const s = stock.find((x) => x.id === l.itemId);
        return (
          <div key={i} className="grid grid-cols-[1fr_7rem_5rem_2rem] items-center gap-2">
            <select
              aria-label="Ingredient"
              className={input}
              value={l.itemId}
              onChange={(e) =>
                setLines((ls) => ls.map((x, j) => (j === i ? { ...x, itemId: e.target.value } : x)))
              }
            >
              <option value="">Choose ingredient…</option>
              {stock.map((x) => (
                <option
                  key={x.id}
                  value={x.id}
                  disabled={lines.some((y, j) => j !== i && y.itemId === x.id)}
                >
                  {x.name} ({x.unit})
                </option>
              ))}
            </select>
            <input
              aria-label="Quantity"
              type="number"
              min="0.001"
              step="0.001"
              placeholder={s?.unit ?? 'Qty'}
              className={input}
              value={l.quantity}
              onChange={(e) =>
                setLines((ls) =>
                  ls.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)),
                )
              }
            />
            <span className="text-right text-sm tabular-nums text-muted-foreground">
              {s ? m(Math.round(Number(l.quantity || 0) * s.costPerUnitMinor)) : '—'}
            </span>
            <button
              type="button"
              aria-label="Remove"
              onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
              className="text-slate-400 hover:text-red-600"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className={buttonSecondary}
        onClick={() => setLines((ls) => [...ls, { itemId: '', quantity: '' }])}
      >
        <Plus className="size-4" /> Add ingredient
      </button>
      <div className="flex justify-between rounded-lg bg-slate-50 p-3 text-sm dark:bg-white/5">
        <span>
          Cost per plate <strong className="tabular-nums">{m(cost)}</strong> · margin{' '}
          <strong className="tabular-nums">{m(row.priceMinor - cost)}</strong>
        </span>
        {pct !== null ? (
          <span
            className={cn(
              'font-semibold',
              pct > 35 ? 'text-red-600' : pct > 30 ? 'text-amber-700' : 'text-emerald-700',
            )}
          >
            {pct}% food cost
          </span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Costs use each stock item&apos;s latest purchase price. Recipes are for costing; they do not
        deduct stock automatically.
      </p>
    </FormDialog>
  );
}
