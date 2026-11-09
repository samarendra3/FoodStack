'use client';

import { DeleteConfirmDialog } from '@foodstack/ui/components/confirm-dialog';
import { Pencil, Plus, Sliders, Trash2 } from 'lucide-react';
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

interface Group {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  isActive: boolean;
  options: { id: string; name: string; priceMinor: number; isAvailable: boolean }[];
  menuItemIds: string[];
}
interface Addons {
  restaurantId: string;
  currencyCode: string;
  canManage: boolean;
  menuItems: { id: string; name: string; priceMinor: number; category: string | null }[];
  groups: Group[];
}

/** Customisation groups such as "Extra toppings (pick up to 3)" attached to dishes. */
export default function AddonsPage() {
  const q = useOps<Addons>('/addon-groups');
  const w = useOpsWrite();
  const d = q.data;
  const m = (v: number) => money(v, d?.currencyCode);
  const [edit, setEdit] = useState<Partial<Group> | null>(null);
  const [del, setDel] = useState<Group | null>(null);
  const names = new Map((d?.menuItems ?? []).map((i) => [i.id, i.name]));
  const rule = (g: Pick<Group, 'minSelect' | 'maxSelect'>) =>
    g.minSelect === 0
      ? `Optional · up to ${g.maxSelect}`
      : g.minSelect === g.maxSelect
        ? `Required · pick ${g.minSelect}`
        : `Pick ${g.minSelect}–${g.maxSelect}`;

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Add-ons & Variants"
        description="Extras guests can add to a dish, with selection rules. Portion sizes (Full / Half) are set on each dish in Menu Management."
        actions={
          d?.canManage ? (
            <button
              type="button"
              className={buttonPrimary}
              onClick={() =>
                setEdit({
                  minSelect: 0,
                  maxSelect: 1,
                  isActive: true,
                  options: [],
                  menuItemIds: [],
                })
              }
            >
              <Plus className="size-4" /> New add-on group
            </button>
          ) : null
        }
      />
      {q.isError ? <ErrorNote error={q.error} /> : null}
      {q.isPending ? (
        <Skeleton className="h-40" />
      ) : !d?.groups.length ? (
        <Card>
          <EmptyNote
            icon={Sliders}
            title="No add-on groups yet"
            text="Create groups like “Extra cheese”, “Choose your bread” or “Spice level” and attach them to dishes."
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {d.groups.map((g) => (
            <Card key={g.id}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="flex items-center gap-2 font-semibold">
                    {g.name} {g.isActive ? null : <Badge>Hidden</Badge>}
                  </p>
                  <p className="text-sm text-muted-foreground">{rule(g)}</p>
                </div>
                {d.canManage ? (
                  <span className="flex gap-1">
                    <button
                      type="button"
                      aria-label={`Edit ${g.name}`}
                      onClick={() => setEdit(g)}
                      className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-white/10"
                    >
                      <Pencil className="size-4" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${g.name}`}
                      onClick={() => setDel(g)}
                      className="rounded p-1 text-slate-500 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </span>
                ) : null}
              </div>
              <ul className="mt-3 divide-y divide-slate-100 text-sm dark:divide-white/5">
                {g.options.map((o) => (
                  <li key={o.id} className="flex justify-between py-1.5">
                    <span className={o.isAvailable ? '' : 'text-muted-foreground line-through'}>
                      {o.name}
                    </span>
                    <span className="tabular-nums">
                      {o.priceMinor ? `+${m(o.priceMinor)}` : 'Free'}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-muted-foreground">
                {g.menuItemIds.length
                  ? `On ${g.menuItemIds.length} dish${g.menuItemIds.length === 1 ? '' : 'es'}: ${g.menuItemIds
                      .slice(0, 4)
                      .map((id) => names.get(id))
                      .join(', ')}${g.menuItemIds.length > 4 ? '…' : ''}`
                  : 'Not attached to any dish yet'}
              </p>
            </Card>
          ))}
        </div>
      )}
      {edit && d ? <GroupForm value={edit} d={d} onClose={() => setEdit(null)} /> : null}
      <DeleteConfirmDialog
        open={del !== null}
        onClose={() => setDel(null)}
        entity="add-on group"
        name={del?.name}
        onConfirm={() => w.send(`/addon-groups/${del!.id}`, 'DELETE')}
      />
    </div>
  );
}

function GroupForm({
  value,
  d,
  onClose,
}: {
  value: Partial<Group>;
  d: Addons;
  onClose: () => void;
}) {
  const w = useOpsWrite();
  const [name, setName] = useState(value.name ?? '');
  const [min, setMin] = useState(String(value.minSelect ?? 0));
  const [max, setMax] = useState(String(value.maxSelect ?? 1));
  const [active, setActive] = useState(value.isActive ?? true);
  const [opts, setOpts] = useState(
    (value.options?.length
      ? value.options
      : [{ id: '', name: '', priceMinor: 0, isAvailable: true }]
    ).map((o) => ({ name: o.name, price: toRupees(o.priceMinor), isAvailable: o.isAvailable })),
  );
  const [items, setItems] = useState(new Set(value.menuItemIds ?? []));
  const [filter, setFilter] = useState('');
  return (
    <FormDialog
      open
      onClose={onClose}
      size="xl"
      title={value.id ? 'Edit add-on group' : 'New add-on group'}
      onSubmit={() => {
        const body = {
          name,
          minSelect: Number(min),
          maxSelect: Number(max),
          isActive: active,
          options: opts
            .filter((o) => o.name.trim())
            .map((o) => ({
              name: o.name,
              priceMinor: toMinor(o.price),
              isAvailable: o.isAvailable,
            })),
          menuItemIds: [...items],
        };
        return value.id
          ? w.send(`/addon-groups/${value.id}`, 'PATCH', body)
          : w.send('/addon-groups', 'POST', { restaurantId: d.restaurantId, ...body });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-4">
        <Field label="Group name" className="sm:col-span-2">
          <input
            required
            maxLength={60}
            className={input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Extra toppings"
          />
        </Field>
        <Field label="Minimum" hint="0 = optional">
          <input
            type="number"
            min="0"
            max="20"
            className={input}
            value={min}
            onChange={(e) => setMin(e.target.value)}
          />
        </Field>
        <Field label="Maximum">
          <input
            type="number"
            min="1"
            max="20"
            className={input}
            value={max}
            onChange={(e) => setMax(e.target.value)}
          />
        </Field>
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium">Options</p>
        {opts.map((o, i) => (
          <div key={i} className="grid grid-cols-[1fr_7rem_auto_2rem] items-center gap-2">
            <input
              aria-label="Option name"
              required
              maxLength={60}
              className={input}
              value={o.name}
              onChange={(e) =>
                setOpts((x) => x.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))
              }
              placeholder="Cheese"
            />
            <input
              aria-label="Extra price"
              type="number"
              min="0"
              step="0.01"
              className={input}
              value={o.price}
              onChange={(e) =>
                setOpts((x) => x.map((y, j) => (j === i ? { ...y, price: e.target.value } : y)))
              }
              placeholder="₹ 0"
            />
            <Switch
              checked={o.isAvailable}
              onChange={(v) =>
                setOpts((x) => x.map((y, j) => (j === i ? { ...y, isAvailable: v } : y)))
              }
              label="Available"
            />
            <button
              type="button"
              aria-label="Remove option"
              disabled={opts.length === 1}
              onClick={() => setOpts((x) => x.filter((_, j) => j !== i))}
              className="text-slate-400 hover:text-red-600 disabled:opacity-30"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className={buttonSecondary}
          onClick={() => setOpts((x) => [...x, { name: '', price: '', isAvailable: true }])}
        >
          <Plus className="size-4" /> Add option
        </button>
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium">Dishes ({items.size} selected)</p>
        <input
          aria-label="Filter dishes"
          className={input}
          placeholder="Filter dishes"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2 dark:border-white/10">
          {d.menuItems
            .filter((i) => !filter || i.name.toLowerCase().includes(filter.toLowerCase()))
            .map((i) => (
              <li key={i.id}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-emerald-600"
                    checked={items.has(i.id)}
                    onChange={(e) =>
                      setItems((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(i.id);
                        else n.delete(i.id);
                        return n;
                      })
                    }
                  />
                  {i.name} <span className="text-xs text-muted-foreground">{i.category}</span>
                </label>
              </li>
            ))}
        </ul>
      </div>
      <div className="flex items-center justify-between rounded-lg border border-slate-200 p-3 text-sm dark:border-white/10">
        Show this group
        <Switch checked={active} onChange={setActive} label="Show this group" />
      </div>
    </FormDialog>
  );
}
