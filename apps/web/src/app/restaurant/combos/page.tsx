'use client';

import { DeleteConfirmDialog } from '@foodstack/ui/components/confirm-dialog';
import { Pencil, Plus, SquareStack, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  Field,
  FormDialog,
  input,
  money,
  Switch,
  toMinor,
  toRupees,
  useOps,
  useOpsWrite,
} from '../_kit/ops-kit';
import {
  buttonPrimary,
  buttonSecondary,
  Card,
  EmptyNote,
  ErrorNote,
  PageHeader,
  Skeleton,
} from '../_kit/report-kit';

interface Combo {
  id: string;
  name: string;
  description: string | null;
  priceMinor: number;
  isActive: boolean;
  items: {
    menuItemId: string;
    name: string;
    quantity: number;
    unitPriceMinor: number;
    isAvailable: boolean;
  }[];
  regularPriceMinor: number;
  savingsMinor: number;
  savingsPct: number | null;
  isSellable: boolean;
}
interface Combos {
  restaurantId: string;
  currencyCode: string;
  canManage: boolean;
  menuItems: {
    id: string;
    name: string;
    priceMinor: number;
    category: string | null;
    isAvailable: boolean;
  }[];
  rows: Combo[];
}

export default function CombosPage() {
  const q = useOps<Combos>('/combos');
  const w = useOpsWrite();
  const d = q.data;
  const m = (v: number) => money(v, d?.currencyCode);
  const [edit, setEdit] = useState<Partial<Combo> | null>(null);
  const [del, setDel] = useState<Combo | null>(null);
  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Combos & Meal Deals"
        description="Dishes sold together at one price. A combo is sellable only while every dish in it is available."
        actions={
          d?.canManage ? (
            <button
              type="button"
              className={buttonPrimary}
              onClick={() => setEdit({ isActive: true, items: [] })}
            >
              <Plus className="size-4" /> New combo
            </button>
          ) : null
        }
      />
      {q.isError ? <ErrorNote error={q.error} /> : null}
      {q.isPending ? (
        <Skeleton className="h-40" />
      ) : !d?.rows.length ? (
        <Card>
          <EmptyNote
            icon={SquareStack}
            title="No combos yet"
            text="Bundle a main, a side and a drink at a better price to raise the average bill."
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {d.rows.map((c) => (
            <Card key={c.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-semibold">
                    {c.name}
                    {!c.isActive ? (
                      <Badge>Hidden</Badge>
                    ) : c.isSellable ? (
                      <Badge tone="emerald">On sale</Badge>
                    ) : (
                      <Badge tone="amber">A dish is sold out</Badge>
                    )}
                  </p>
                  {c.description ? (
                    <p className="text-sm text-muted-foreground">{c.description}</p>
                  ) : null}
                </div>
                {d.canManage ? (
                  <span className="flex gap-1">
                    <button
                      type="button"
                      aria-label={`Edit ${c.name}`}
                      onClick={() => setEdit(c)}
                      className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-white/10"
                    >
                      <Pencil className="size-4" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${c.name}`}
                      onClick={() => setDel(c)}
                      className="rounded p-1 text-slate-500 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </span>
                ) : null}
              </div>
              <ul className="mt-3 space-y-1 text-sm">
                {c.items.map((i) => (
                  <li
                    key={i.menuItemId}
                    className={i.isAvailable ? '' : 'text-muted-foreground line-through'}
                  >
                    {i.quantity} × {i.name}
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex items-end justify-between">
                <div>
                  <p className="text-xl font-semibold tabular-nums">{m(c.priceMinor)}</p>
                  <p className="text-xs text-muted-foreground line-through">
                    {m(c.regularPriceMinor)}
                  </p>
                </div>
                {c.savingsMinor > 0 ? (
                  <Badge tone="emerald">
                    Save {m(c.savingsMinor)} ({c.savingsPct}%)
                  </Badge>
                ) : (
                  <Badge tone="amber">No saving</Badge>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
      {edit && d ? <ComboForm value={edit} d={d} onClose={() => setEdit(null)} /> : null}
      <DeleteConfirmDialog
        open={del !== null}
        onClose={() => setDel(null)}
        entity="combo"
        name={del?.name}
        onConfirm={() => w.send(`/combos/${del!.id}`, 'DELETE')}
      />
    </div>
  );
}

function ComboForm({
  value,
  d,
  onClose,
}: {
  value: Partial<Combo>;
  d: Combos;
  onClose: () => void;
}) {
  const w = useOpsWrite();
  const [name, setName] = useState(value.name ?? '');
  const [description, setDescription] = useState(value.description ?? '');
  const [price, setPrice] = useState(toRupees(value.priceMinor));
  const [active, setActive] = useState(value.isActive ?? true);
  const [lines, setLines] = useState(
    value.items?.length
      ? value.items.map((i) => ({ menuItemId: i.menuItemId, quantity: String(i.quantity) }))
      : [
          { menuItemId: '', quantity: '1' },
          { menuItemId: '', quantity: '1' },
        ],
  );
  const regular = lines.reduce(
    (t, l) =>
      t +
      (d.menuItems.find((i) => i.id === l.menuItemId)?.priceMinor ?? 0) * Number(l.quantity || 0),
    0,
  );
  const saving = regular - toMinor(price);
  return (
    <FormDialog
      open
      onClose={onClose}
      size="lg"
      title={value.id ? 'Edit combo' : 'New combo'}
      onSubmit={() => {
        const body = {
          name,
          description,
          priceMinor: toMinor(price),
          isActive: active,
          items: lines
            .filter((l) => l.menuItemId)
            .map((l) => ({ menuItemId: l.menuItemId, quantity: Number(l.quantity) })),
        };
        return value.id
          ? w.send(`/combos/${value.id}`, 'PATCH', body)
          : w.send('/combos', 'POST', { restaurantId: d.restaurantId, ...body });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Name" className="sm:col-span-2">
          <input
            required
            maxLength={80}
            className={input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Lunch Thali Combo"
          />
        </Field>
        <Field label="Combo price (₹)">
          <input
            required
            type="number"
            min="0.01"
            step="0.01"
            className={input}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Description (optional)">
        <input
          maxLength={300}
          className={input}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <div className="space-y-2">
        <p className="text-sm font-medium">Dishes (at least two)</p>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1fr_5rem_2rem] items-center gap-2">
            <select
              aria-label="Dish"
              className={input}
              value={l.menuItemId}
              onChange={(e) =>
                setLines((x) =>
                  x.map((y, j) => (j === i ? { ...y, menuItemId: e.target.value } : y)),
                )
              }
            >
              <option value="">Choose dish…</option>
              {d.menuItems.map((mi) => (
                <option
                  key={mi.id}
                  value={mi.id}
                  disabled={lines.some((y, j) => j !== i && y.menuItemId === mi.id)}
                >
                  {mi.name} · {money(mi.priceMinor, d.currencyCode)}
                </option>
              ))}
            </select>
            <input
              aria-label="Quantity"
              type="number"
              min="1"
              max="50"
              className={input}
              value={l.quantity}
              onChange={(e) =>
                setLines((x) => x.map((y, j) => (j === i ? { ...y, quantity: e.target.value } : y)))
              }
            />
            <button
              type="button"
              aria-label="Remove dish"
              disabled={lines.length <= 2}
              onClick={() => setLines((x) => x.filter((_, j) => j !== i))}
              className="text-slate-400 hover:text-red-600 disabled:opacity-30"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className={buttonSecondary}
          onClick={() => setLines((x) => [...x, { menuItemId: '', quantity: '1' }])}
        >
          <Plus className="size-4" /> Add dish
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 p-3 text-sm dark:bg-white/5">
        <span>
          Bought separately {money(regular, d.currencyCode)} ·{' '}
          <strong className={saving > 0 ? 'text-emerald-700' : 'text-amber-700'}>
            {saving > 0
              ? `guest saves ${money(saving, d.currencyCode)}`
              : 'no saving for the guest'}
          </strong>
        </span>
        <label className="flex items-center gap-2">
          On sale <Switch checked={active} onChange={setActive} label="On sale" />
        </label>
      </div>
    </FormDialog>
  );
}
