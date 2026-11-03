'use client';

import { Button } from '@foodstack/ui/components/button';
import { cn } from '@foodstack/ui/lib/utils';
import {
  AlertTriangle,
  ArrowDownToLine,
  Boxes,
  Check,
  ClipboardCheck,
  History,
  Loader2,
  MapPin,
  MinusCircle,
  PackageX,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { authErrorMessage } from '@/lib/auth/errors';
import {
  formatQty,
  type InventoryData,
  type MovementType,
  type StockItem,
  type StockStatus,
  UNITS,
  type Unit,
  useInventory,
  useInventoryMutations,
  useMovements,
} from '@/lib/inventory';
import { formatMoney } from '@/lib/menu';

type Dialog =
  | { kind: 'item'; item?: StockItem }
  | { kind: 'move'; item: StockItem; type: MovementType }
  | { kind: 'history'; item: StockItem }
  | { kind: 'delete'; item: StockItem };

const STATUS: Record<StockStatus, { label: string; cls: string; dot: string }> = {
  ok: {
    label: 'In stock',
    cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
    dot: 'bg-emerald-500',
  },
  low: {
    label: 'Low stock',
    cls: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
    dot: 'bg-amber-500',
  },
  out: {
    label: 'Out of stock',
    cls: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300',
    dot: 'bg-red-500',
  },
};

const MOVES: Record<
  MovementType,
  { label: string; verb: string; icon: typeof Plus; hint: string }
> = {
  purchase: {
    label: 'Stock in',
    verb: 'Add stock',
    icon: ArrowDownToLine,
    hint: 'Quantity received',
  },
  usage: { label: 'Use', verb: 'Record usage', icon: MinusCircle, hint: 'Quantity used' },
  wastage: {
    label: 'Waste',
    verb: 'Record wastage',
    icon: PackageX,
    hint: 'Quantity wasted or spoiled',
  },
  count: {
    label: 'Count',
    verb: 'Save count',
    icon: ClipboardCheck,
    hint: 'Actual quantity on the shelf',
  },
};

export default function InventoryPage() {
  const [branchId, setBranchId] = useState<string | null>(null);
  const inv = useInventory(branchId);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StockStatus | 'all'>('all');
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const data = inv.data;
  const q = query.trim().toLowerCase();
  const items = (data?.items ?? []).filter(
    (i) =>
      (status === 'all' || i.status === status) &&
      (!q || i.name.toLowerCase().includes(q) || i.category?.toLowerCase().includes(q)),
  );
  const count = (s: StockStatus) => data?.items.filter((i) => i.status === s).length ?? 0;
  const value = (data?.items ?? []).reduce((n, i) => n + (i.costPerUnitMinor ?? 0) * i.quantity, 0);

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Inventory</h1>
          <p className="text-sm text-muted-foreground">
            Track ingredients and supplies, record stock in and usage, and catch low stock early.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {data && data.branches.length > 1 ? (
            <label className="relative flex items-center">
              <MapPin className="pointer-events-none absolute left-3 size-4 text-muted-foreground" />
              <span className="sr-only">Branch</span>
              <select
                value={data.branch.id}
                onChange={(e) => setBranchId(e.target.value)}
                className="h-9 rounded-md border bg-card pr-3 pl-9 text-sm"
              >
                {data.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          ) : data ? (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <MapPin className="size-4" /> {data.branch.name}
            </span>
          ) : null}
          {data?.canManageItems ? (
            <Button onClick={() => setDialog({ kind: 'item' })}>
              <Plus aria-hidden /> Add stock item
            </Button>
          ) : null}
        </div>
      </div>

      {inv.isError ? (
        <p
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700"
        >
          {authErrorMessage(inv.error)}
        </p>
      ) : null}

      {inv.isPending ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="h-24 animate-pulse rounded-2xl bg-muted" />
            ))}
          </div>
          <div className="h-80 animate-pulse rounded-2xl bg-muted" />
        </div>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <Stat
              icon={Boxes}
              tone="bg-primary/10 text-primary"
              label="Stock items"
              value={data.items.length}
            />
            <Stat
              icon={AlertTriangle}
              tone="bg-amber-100 text-amber-600 dark:bg-amber-500/15"
              label="Low stock"
              value={count('low')}
              onClick={() => setStatus('low')}
            />
            <Stat
              icon={PackageX}
              tone="bg-red-100 text-red-600 dark:bg-red-500/15"
              label="Out of stock"
              value={count('out')}
              onClick={() => setStatus('out')}
            />
            <Stat
              icon={ArrowDownToLine}
              tone="bg-sky-100 text-sky-600 dark:bg-sky-500/15"
              label="Stock value (at cost)"
              value={
                data.restaurant ? formatMoney(Math.round(value), data.restaurant.currencyCode) : '—'
              }
            />
          </div>

          {data.items.length === 0 ? (
            <div className="flex flex-col items-center rounded-2xl border bg-card px-6 py-16 text-center">
              <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Boxes className="size-6" />
              </span>
              <h2 className="mt-4 text-lg font-semibold">No stock items yet</h2>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                {data.canManageItems
                  ? 'Add the ingredients and supplies you buy — rice, oil, paneer, packaging — then record stock as it arrives.'
                  : 'Your restaurant has not added stock items yet.'}
              </p>
              {data.canManageItems ? (
                <Button className="mt-5" onClick={() => setDialog({ kind: 'item' })}>
                  <Plus aria-hidden /> Add first item
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border bg-card">
              <div className="flex flex-col gap-3 border-b p-3 sm:flex-row sm:items-center">
                <label className="relative flex-1 sm:max-w-xs">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <span className="sr-only">Search stock</span>
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search items or categories"
                    className="h-9 w-full rounded-lg border bg-background pr-3 pl-9 text-sm outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/20"
                  />
                </label>
                <div className="flex gap-1 overflow-x-auto" role="tablist">
                  {(['all', 'ok', 'low', 'out'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="tab"
                      aria-selected={status === s}
                      onClick={() => setStatus(s)}
                      className={cn(
                        'h-9 shrink-0 rounded-lg px-3 text-sm font-medium',
                        status === s
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-muted',
                      )}
                    >
                      {s === 'all' ? 'All' : STATUS[s].label}
                    </button>
                  ))}
                </div>
              </div>

              {items.length === 0 ? (
                <p className="py-14 text-center text-sm text-muted-foreground">No items match.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[46rem] text-sm">
                    <thead className="bg-muted/40 text-left text-xs font-semibold text-muted-foreground uppercase">
                      <tr>
                        <th className="px-4 py-2.5">Item</th>
                        <th className="px-4 py-2.5 text-right">On hand</th>
                        <th className="px-4 py-2.5">Status</th>
                        <th className="px-4 py-2.5 text-right">Cost / unit</th>
                        <th className="px-4 py-2.5 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {items.map((item) => (
                        <Row key={item.id} item={item} data={data} onDialog={setDialog} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      ) : null}

      <AnimatePresence>
        {dialog && data ? (
          <Modal onClose={() => setDialog(null)} wide={dialog.kind === 'history'}>
            {dialog.kind === 'item' ? (
              <ItemForm
                item={dialog.item}
                currency={data.restaurant?.currencyCode ?? 'INR'}
                onDone={() => setDialog(null)}
              />
            ) : dialog.kind === 'move' ? (
              <MoveForm
                item={dialog.item}
                type={dialog.type}
                branch={data.branch}
                onDone={() => setDialog(null)}
              />
            ) : dialog.kind === 'history' ? (
              <HistoryView item={dialog.item} branch={data.branch} />
            ) : (
              <ConfirmDelete item={dialog.item} onDone={() => setDialog(null)} />
            )}
          </Modal>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Row({
  item,
  data,
  onDialog,
}: {
  item: StockItem;
  data: InventoryData;
  onDialog: (d: Dialog) => void;
}) {
  const s = STATUS[item.status];
  return (
    <tr className="hover:bg-muted/30">
      <td className="px-4 py-3">
        <p className="font-medium">{item.name}</p>
        <p className="text-xs text-muted-foreground">
          {item.category ?? 'Uncategorised'} · alert below {formatQty(item.lowStockThreshold)}{' '}
          {item.unit}
        </p>
      </td>
      <td className="px-4 py-3 text-right font-semibold tabular-nums">
        {formatQty(item.quantity)}{' '}
        <span className="font-normal text-muted-foreground">{item.unit}</span>
      </td>
      <td className="px-4 py-3">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
            s.cls,
          )}
        >
          <span className={cn('size-1.5 rounded-full', s.dot)} />
          {s.label}
        </span>
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
        {item.costPerUnitMinor !== null && data.restaurant
          ? `${formatMoney(item.costPerUnitMinor, data.restaurant.currencyCode)} / ${item.unit}`
          : '—'}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1">
          {data.canRecordMovements ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onDialog({ kind: 'move', item, type: 'purchase' })}
              >
                <ArrowDownToLine /> Stock in
              </Button>
              <Icon
                label={`Record usage of ${item.name}`}
                onClick={() => onDialog({ kind: 'move', item, type: 'usage' })}
              >
                <MinusCircle />
              </Icon>
              <Icon
                label={`Record wastage of ${item.name}`}
                onClick={() => onDialog({ kind: 'move', item, type: 'wastage' })}
              >
                <PackageX />
              </Icon>
              <Icon
                label={`Count ${item.name}`}
                onClick={() => onDialog({ kind: 'move', item, type: 'count' })}
              >
                <ClipboardCheck />
              </Icon>
            </>
          ) : null}
          <Icon
            label={`History of ${item.name}`}
            onClick={() => onDialog({ kind: 'history', item })}
          >
            <History />
          </Icon>
          {data.canManageItems ? (
            <>
              <Icon label={`Edit ${item.name}`} onClick={() => onDialog({ kind: 'item', item })}>
                <Pencil />
              </Icon>
              <Icon
                label={`Delete ${item.name}`}
                onClick={() => onDialog({ kind: 'delete', item })}
              >
                <Trash2 />
              </Icon>
            </>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function Stat(p: {
  icon: typeof Plus;
  tone: string;
  label: string;
  value: ReactNode;
  onClick?: () => void;
}) {
  const Ico = p.icon;
  const body = (
    <>
      <span className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl', p.tone)}>
        <Ico className="size-5" />
      </span>
      <div className="min-w-0 text-left">
        <p className="truncate text-2xl font-bold tabular-nums">{p.value}</p>
        <p className="text-sm text-muted-foreground">{p.label}</p>
      </div>
    </>
  );
  const cls =
    'flex items-center gap-3 rounded-2xl border bg-card p-4 transition-all hover:-translate-y-0.5 hover:shadow-sm';
  return p.onClick ? (
    <button type="button" onClick={p.onClick} className={cls}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function Icon({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-4"
    >
      {children}
    </button>
  );
}

function Modal({
  onClose,
  wide,
  children,
}: {
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.div
        className="absolute inset-0 bg-slate-950/50"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        initial={{ opacity: 0, y: 20, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 400, damping: 34 }}
        className={cn(
          'relative max-h-[calc(100dvh-2rem)] w-full overflow-y-auto rounded-2xl border bg-card p-6 shadow-xl',
          wide ? 'max-w-xl' : 'max-w-md',
        )}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 rounded-md p-1 text-muted-foreground hover:bg-muted"
        >
          <X className="size-4" />
        </button>
        {children}
      </motion.div>
    </div>
  );
}

const field =
  'h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/20';

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {error ? <span className="block text-xs text-red-600">{error}</span> : null}
    </label>
  );
}

const decimal = (v: string) => v.replace(/[^\d.]/g, '');
const validQty = (v: string) =>
  v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 && /^\d+(\.\d{0,3})?$/.test(v);

function ItemForm({
  item,
  currency,
  onDone,
}: {
  item?: StockItem;
  currency: string;
  onDone: () => void;
}) {
  const m = useInventoryMutations();
  const [f, setF] = useState({
    name: item?.name ?? '',
    category: item?.category ?? '',
    unit: item?.unit ?? ('kg' as Unit),
    threshold: item ? String(item.lowStockThreshold) : '0',
    cost: item?.costPerUnitMinor != null ? String(item.costPerUnitMinor / 100) : '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const busy = m.createItem.isPending || m.updateItem.isPending;
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!f.name.trim()) next.name = 'Enter a name.';
    if (!validQty(f.threshold)) next.threshold = 'Enter a number (up to 3 decimals).';
    if (f.cost !== '' && !(Number(f.cost) >= 0)) next.cost = 'Enter a valid cost.';
    setErrors(next);
    if (Object.keys(next).length) return;
    const body = {
      name: f.name.trim(),
      category: f.category.trim() || null,
      unit: f.unit,
      lowStockThreshold: Number(f.threshold),
      costPerUnitMinor: f.cost === '' ? null : Math.round(Number(f.cost) * 100),
    };
    try {
      if (item) await m.updateItem.mutateAsync({ id: item.id, ...body });
      else await m.createItem.mutateAsync(body);
      onDone();
    } catch (err) {
      setErrors({ form: authErrorMessage(err) });
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <h2 className="text-lg font-semibold">{item ? 'Edit stock item' : 'Add stock item'}</h2>
      <Field label="Name" error={errors.name}>
        <input
          autoFocus
          value={f.name}
          maxLength={80}
          onChange={(e) => set('name', e.target.value)}
          placeholder="e.g. Basmati Rice"
          className={field}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Category (optional)">
          <input
            value={f.category}
            maxLength={40}
            onChange={(e) => set('category', e.target.value)}
            placeholder="e.g. Grains"
            className={field}
          />
        </Field>
        <Field label="Unit">
          <select
            value={f.unit}
            onChange={(e) => set('unit', e.target.value as Unit)}
            className={field}
          >
            {UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label={`Low-stock alert (${f.unit})`} error={errors.threshold}>
          <input
            inputMode="decimal"
            value={f.threshold}
            onChange={(e) => set('threshold', decimal(e.target.value))}
            className={cn(field, 'tabular-nums')}
          />
        </Field>
        <Field label={`Cost per ${f.unit} (${currency}, optional)`} error={errors.cost}>
          <input
            inputMode="decimal"
            value={f.cost}
            onChange={(e) => set('cost', decimal(e.target.value))}
            placeholder="0.00"
            className={cn(field, 'tabular-nums')}
          />
        </Field>
      </div>
      {errors.form ? (
        <p role="alert" className="text-sm text-red-600">
          {errors.form}
        </p>
      ) : null}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Check />}{' '}
          {item ? 'Save changes' : 'Add item'}
        </Button>
      </div>
    </form>
  );
}

function MoveForm(p: {
  item: StockItem;
  type: MovementType;
  branch: { id: string; name: string };
  onDone: () => void;
}) {
  const m = useInventoryMutations();
  const meta = MOVES[p.type];
  const [qty, setQty] = useState(p.type === 'count' ? String(p.item.quantity) : '');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const n = Number(qty);
  const after = !validQty(qty)
    ? null
    : p.type === 'count'
      ? n
      : p.type === 'purchase'
        ? p.item.quantity + n
        : p.item.quantity - n;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!validQty(qty) || (p.type !== 'count' && n <= 0))
      return setError('Enter a quantity above 0 (up to 3 decimals).');
    if (after !== null && after < 0)
      return setError(`Only ${formatQty(p.item.quantity)} ${p.item.unit} in stock.`);
    try {
      await m.move.mutateAsync({
        itemId: p.item.id,
        branchId: p.branch.id,
        type: p.type,
        quantity: n,
        note: note.trim() || null,
      });
      p.onDone();
    } catch (err) {
      setError(authErrorMessage(err));
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">
          {meta.verb}: {p.item.name}
        </h2>
        <p className="text-sm text-muted-foreground">
          {p.branch.name} · on hand {formatQty(p.item.quantity)} {p.item.unit}
        </p>
      </div>
      <Field label={`${meta.hint} (${p.item.unit})`}>
        <input
          autoFocus
          inputMode="decimal"
          value={qty}
          onChange={(e) => setQty(decimal(e.target.value))}
          className={cn(field, 'text-lg tabular-nums')}
        />
      </Field>
      <Field label="Note (optional)">
        <input
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
          placeholder={
            p.type === 'purchase' ? 'e.g. Invoice #1042, Fresh Mart' : 'e.g. Dinner service'
          }
          className={field}
        />
      </Field>
      {after !== null ? (
        <p
          className={cn(
            'rounded-lg px-3 py-2 text-sm',
            after < 0 ? 'bg-red-50 text-red-700' : 'bg-muted',
          )}
        >
          New quantity:{' '}
          <strong className="tabular-nums">
            {formatQty(Math.max(after, 0))} {p.item.unit}
          </strong>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={p.onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={m.move.isPending}>
          {m.move.isPending ? <Loader2 className="animate-spin" /> : <Check />} {meta.verb}
        </Button>
      </div>
    </form>
  );
}

function HistoryView({ item, branch }: { item: StockItem; branch: { id: string; name: string } }) {
  const history = useMovements(item.id, branch.id);
  const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{item.name} history</h2>
        <p className="text-sm text-muted-foreground">{branch.name} · last 50 movements</p>
      </div>
      {history.isPending ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : history.isError ? (
        <p role="alert" className="text-sm text-red-600">
          {authErrorMessage(history.error)}
        </p>
      ) : history.data.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No stock movements yet.</p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {history.data.map((h) => (
            <li key={h.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
              <span
                className={cn(
                  'w-20 shrink-0 text-xs font-semibold',
                  h.quantityDelta >= 0 ? 'text-emerald-600' : 'text-red-600',
                )}
              >
                {MOVES[h.type].label}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-muted-foreground">{h.note ?? '—'}</p>
                <p className="text-xs text-muted-foreground">
                  {when.format(new Date(h.createdAt))}
                  {h.byName ? ` · ${h.byName}` : ''}
                </p>
              </div>
              <span
                className={cn(
                  'tabular-nums font-semibold',
                  h.quantityDelta >= 0 ? 'text-emerald-600' : 'text-red-600',
                )}
              >
                {h.quantityDelta >= 0 ? '+' : ''}
                {formatQty(h.quantityDelta)}
              </span>
              <span className="w-20 text-right tabular-nums text-muted-foreground">
                = {formatQty(h.quantityAfter)} {item.unit}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConfirmDelete({ item, onDone }: { item: StockItem; onDone: () => void }) {
  const m = useInventoryMutations();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Delete {item.name}?</h2>
      <p className="text-sm text-muted-foreground">
        It is removed from every branch&apos;s stock list. Its movement history is kept.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={m.deleteItem.isPending}
          onClick={() =>
            m.deleteItem.mutate(item.id, {
              onSuccess: onDone,
              onError: (e) => setError(authErrorMessage(e)),
            })
          }
        >
          {m.deleteItem.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />} Delete
        </Button>
      </div>
    </div>
  );
}
