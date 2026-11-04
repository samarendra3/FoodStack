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
  Trash2,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { type Column, DataTable } from '@/components/data-table/data-table';
import { authErrorMessage } from '@/lib/auth/errors';
import { usePagedList } from '@/lib/paged';
import {
  formatQty,
  type MovementType,
  type StockItem,
  type StockStatus,
  UNITS,
  type Unit,
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

interface Summary {
  restaurant: { id: string; name: string; currencyCode: string } | null;
  branch: { id: string; name: string };
  branches: { id: string; name: string }[];
  counts: { total: number; low: number; out: number };
  stockValueMinor: number;
  categories: string[];
  canManageItems: boolean;
  canRecordMovements: boolean;
}

interface MovementRow {
  id: string;
  itemId: string;
  itemName: string;
  unit: string;
  type: MovementType;
  quantityDelta: number;
  quantityAfter: number;
  note: string | null;
  byName: string | null;
  createdAt: string;
}

function useInventorySummary(branchId: string) {
  const { client } = useAuth();
  const profile = useProfile();
  return useQuery({
    queryKey: ['inventory', profile.activeTenant?.id, 'summary', branchId],
    queryFn: () =>
      client.request<Summary>(
        `/inventory/summary${branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''}`,
      ),
    placeholderData: keepPreviousData,
  });
}

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export default function InventoryPage() {
  const [tab, setTab] = useState<'stock' | 'movements'>('stock');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const stock = usePagedList<StockItem>('inventory', '/inventory/items', {
    sortBy: 'name',
    sortOrder: 'asc',
    filters: { branchId: '', status: '', category: '' },
  });
  const branchId = stock.state.filters.branchId ?? '';
  const summary = useInventorySummary(branchId);
  const movements = usePagedList<MovementRow>('inventory-movements', '/inventory/movements', {
    sortBy: 'createdAt',
    filters: { branchId: '', type: '', from: '', to: '' },
  });
  const data = summary.data;
  const currency = data?.restaurant?.currencyCode ?? 'INR';
  const money = (m: number) => formatMoney(Math.round(m), currency);

  const pickBranch = (id: string) => {
    stock.update({ filters: { branchId: id } });
    movements.update({ filters: { branchId: id } });
  };

  const stockColumns: Column<StockItem>[] = [
    {
      key: 'name',
      header: 'Item',
      sortKey: 'name',
      cell: (i) => (
        <div>
          <p className="font-medium">{i.name}</p>
          <p className="text-xs text-muted-foreground">
            {i.category ?? 'Uncategorised'} · alert below {formatQty(i.lowStockThreshold)} {i.unit}
          </p>
        </div>
      ),
    },
    {
      key: 'qty',
      header: 'On hand',
      sortKey: 'quantity',
      align: 'right',
      cell: (i) => (
        <span className="font-semibold">
          {formatQty(i.quantity)}{' '}
          <span className="font-normal text-muted-foreground">{i.unit}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (i) => (
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
            STATUS[i.status].cls,
          )}
        >
          <span className={cn('size-1.5 rounded-full', STATUS[i.status].dot)} />
          {STATUS[i.status].label}
        </span>
      ),
    },
    {
      key: 'cost',
      header: 'Cost / unit',
      align: 'right',
      hideOnMobile: true,
      cell: (i) => (i.costPerUnitMinor !== null ? `${money(i.costPerUnitMinor)} / ${i.unit}` : '—'),
    },
    {
      key: 'value',
      header: 'Value',
      sortKey: 'value',
      align: 'right',
      hideOnMobile: true,
      cell: (i) => (i.costPerUnitMinor !== null ? money(i.costPerUnitMinor * i.quantity) : '—'),
    },
  ];

  const movementColumns: Column<MovementRow>[] = [
    {
      key: 'when',
      header: 'When',
      sortKey: 'createdAt',
      cell: (m) => when.format(new Date(m.createdAt)),
    },
    { key: 'item', header: 'Item', cell: (m) => <span className="font-medium">{m.itemName}</span> },
    {
      key: 'type',
      header: 'Type',
      cell: (m) => (
        <span
          className={cn(
            'text-xs font-semibold',
            m.quantityDelta >= 0 ? 'text-emerald-600' : 'text-red-600',
          )}
        >
          {MOVES[m.type].label}
        </span>
      ),
    },
    {
      key: 'change',
      header: 'Change',
      sortKey: 'quantity',
      align: 'right',
      cell: (m) => (
        <span className={m.quantityDelta >= 0 ? 'text-emerald-600' : 'text-red-600'}>
          {m.quantityDelta >= 0 ? '+' : ''}
          {formatQty(m.quantityDelta)} {m.unit}
        </span>
      ),
    },
    {
      key: 'after',
      header: 'After',
      align: 'right',
      hideOnMobile: true,
      cell: (m) => `${formatQty(m.quantityAfter)} ${m.unit}`,
    },
    {
      key: 'note',
      header: 'Note',
      hideOnMobile: true,
      cell: (m) => m.note ?? <span className="text-muted-foreground">—</span>,
    },
    { key: 'by', header: 'By', hideOnMobile: true, cell: (m) => m.byName ?? '—' },
  ];

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
                onChange={(e) => pickBranch(e.target.value)}
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

      {summary.isError ? (
        <p
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700"
        >
          {authErrorMessage(summary.error)}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Stat
          icon={Boxes}
          tone="bg-primary/10 text-primary"
          label="Stock items"
          value={data?.counts.total ?? '—'}
        />
        <Stat
          icon={AlertTriangle}
          tone="bg-amber-100 text-amber-600 dark:bg-amber-500/15"
          label="Low stock"
          value={data?.counts.low ?? '—'}
          onClick={() => {
            setTab('stock');
            stock.update({ filters: { status: 'low' } });
          }}
        />
        <Stat
          icon={PackageX}
          tone="bg-red-100 text-red-600 dark:bg-red-500/15"
          label="Out of stock"
          value={data?.counts.out ?? '—'}
          onClick={() => {
            setTab('stock');
            stock.update({ filters: { status: 'out' } });
          }}
        />
        <Stat
          icon={ArrowDownToLine}
          tone="bg-sky-100 text-sky-600 dark:bg-sky-500/15"
          label="Stock value (at cost)"
          value={data ? money(data.stockValueMinor) : '—'}
        />
      </div>

      <div className="flex gap-1 border-b" role="tablist">
        {(
          [
            { id: 'stock', label: 'Stock' },
            { id: 'movements', label: 'Stock movements' },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              '-mb-px border-b-2 px-4 py-2.5 text-sm font-medium',
              tab === t.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'stock' ? (
        <DataTable
          list={stock}
          columns={stockColumns}
          getRowId={(i) => i.id}
          searchPlaceholder="Search items or categories"
          filters={[
            {
              key: 'status',
              label: 'Status',
              options: (Object.keys(STATUS) as StockStatus[]).map((s) => ({
                value: s,
                label: STATUS[s].label,
              })),
            },
            ...(data?.categories.length
              ? [
                  {
                    key: 'category',
                    label: 'Category',
                    options: data.categories.map((c) => ({ value: c, label: c })),
                  },
                ]
              : []),
          ]}
          rowActions={(item) =>
            data ? (
              <>
                {data.canRecordMovements ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setDialog({ kind: 'move', item, type: 'purchase' })}
                    >
                      <ArrowDownToLine /> Stock in
                    </Button>
                    <Icon
                      label={`Record usage of ${item.name}`}
                      onClick={() => setDialog({ kind: 'move', item, type: 'usage' })}
                    >
                      <MinusCircle />
                    </Icon>
                    <Icon
                      label={`Record wastage of ${item.name}`}
                      onClick={() => setDialog({ kind: 'move', item, type: 'wastage' })}
                    >
                      <PackageX />
                    </Icon>
                    <Icon
                      label={`Count ${item.name}`}
                      onClick={() => setDialog({ kind: 'move', item, type: 'count' })}
                    >
                      <ClipboardCheck />
                    </Icon>
                  </>
                ) : null}
                <Icon
                  label={`History of ${item.name}`}
                  onClick={() => setDialog({ kind: 'history', item })}
                >
                  <History />
                </Icon>
                {data.canManageItems ? (
                  <>
                    <Icon
                      label={`Edit ${item.name}`}
                      onClick={() => setDialog({ kind: 'item', item })}
                    >
                      <Pencil />
                    </Icon>
                    <Icon
                      label={`Delete ${item.name}`}
                      onClick={() => setDialog({ kind: 'delete', item })}
                    >
                      <Trash2 />
                    </Icon>
                  </>
                ) : null}
              </>
            ) : null
          }
          exportCsv={{
            filename: `stock-${new Date().toISOString().slice(0, 10)}.csv`,
            columns: [
              { header: 'Item', value: (i) => i.name },
              { header: 'Category', value: (i) => i.category ?? '' },
              { header: 'Unit', value: (i) => i.unit },
              { header: 'On hand', value: (i) => i.quantity },
              { header: 'Low-stock alert', value: (i) => i.lowStockThreshold },
              {
                header: 'Cost per unit',
                value: (i) =>
                  i.costPerUnitMinor === null ? '' : (i.costPerUnitMinor / 100).toFixed(2),
              },
              { header: 'Status', value: (i) => STATUS[i.status].label },
            ],
          }}
          empty={{
            title: 'No stock items yet',
            description: data?.canManageItems
              ? 'Add the ingredients and supplies you buy — rice, oil, paneer, packaging — then record stock as it arrives.'
              : 'Your restaurant has not added stock items yet.',
            action: data?.canManageItems ? (
              <Button onClick={() => setDialog({ kind: 'item' })}>
                <Plus aria-hidden /> Add first item
              </Button>
            ) : undefined,
          }}
        />
      ) : (
        <DataTable
          list={movements}
          columns={movementColumns}
          getRowId={(m) => m.id}
          searchPlaceholder="Item or note"
          dateRange
          filters={[
            {
              key: 'type',
              label: 'Type',
              options: (Object.keys(MOVES) as MovementType[]).map((t) => ({
                value: t,
                label: MOVES[t].label,
              })),
            },
          ]}
          exportCsv={{
            filename: `stock-movements-${new Date().toISOString().slice(0, 10)}.csv`,
            columns: [
              { header: 'When', value: (m) => m.createdAt },
              { header: 'Item', value: (m) => m.itemName },
              { header: 'Type', value: (m) => MOVES[m.type].label },
              { header: 'Change', value: (m) => m.quantityDelta },
              { header: 'Unit', value: (m) => m.unit },
              { header: 'After', value: (m) => m.quantityAfter },
              { header: 'Note', value: (m) => m.note ?? '' },
              { header: 'By', value: (m) => m.byName ?? '' },
            ],
          }}
          empty={{
            title: 'No stock movements yet',
            description: 'Stock in, usage, wastage and counts appear here.',
          }}
        />
      )}

      <AnimatePresence>
        {dialog && data ? (
          <Modal onClose={() => setDialog(null)} wide={dialog.kind === 'history'}>
            {dialog.kind === 'item' ? (
              <ItemForm item={dialog.item} currency={currency} onDone={() => setDialog(null)} />
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
