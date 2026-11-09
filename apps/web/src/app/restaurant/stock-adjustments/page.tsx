'use client';

import { type Column, DataTable } from '@/components/data-table/data-table';
import { PackageCheck, Plus } from 'lucide-react';
import { useState } from 'react';
import { usePagedList } from '@/lib/paged';
import {
  Badge,
  BranchPicker,
  dateTime,
  Field,
  FormDialog,
  input,
  Toolbar,
  useOpsWrite,
} from '../_kit/ops-kit';
import { useStock } from '../_kit/stock';
import { buttonPrimary, PageHeader } from '../_kit/report-kit';

interface MovementRow {
  id: string;
  itemName: string;
  unit: string;
  type: 'purchase' | 'usage' | 'wastage' | 'count' | 'transfer_in' | 'transfer_out';
  quantityDelta: number;
  quantityAfter: number;
  note: string | null;
  byName: string | null;
  createdAt: string;
}
const TYPE: Record<
  MovementRow['type'],
  { label: string; tone: 'emerald' | 'amber' | 'red' | 'sky' | 'slate' | 'violet' }
> = {
  purchase: { label: 'Stock in', tone: 'emerald' },
  usage: { label: 'Used', tone: 'slate' },
  wastage: { label: 'Wasted', tone: 'red' },
  count: { label: 'Count correction', tone: 'amber' },
  transfer_in: { label: 'Transfer in', tone: 'sky' },
  transfer_out: { label: 'Transfer out', tone: 'violet' },
};
const REASONS = {
  wastage: 'Wastage / spoilage',
  usage: 'Kitchen usage',
  count: 'Physical count (set actual quantity)',
  purchase: 'Stock received',
} as const;

export default function StockAdjustmentsPage() {
  const stock = useStock('');
  const [branchId, setBranchId] = useState('');
  const branch = branchId || stock.data?.branch.id || '';
  const [open, setOpen] = useState(false);
  const cols: Column<MovementRow>[] = [
    {
      key: 'w',
      header: 'When',
      sortKey: 'createdAt',
      cell: (r) => dateTime.format(new Date(r.createdAt)),
    },
    { key: 'i', header: 'Item', cell: (r) => <span className="font-medium">{r.itemName}</span> },
    {
      key: 't',
      header: 'Type',
      cell: (r) => (
        <Badge tone={TYPE[r.type]?.tone ?? 'slate'}>{TYPE[r.type]?.label ?? r.type}</Badge>
      ),
    },
    {
      key: 'q',
      header: 'Change',
      align: 'right',
      sortKey: 'quantity',
      cell: (r) => (
        <span className={r.quantityDelta < 0 ? 'text-red-600' : 'text-emerald-700'}>
          {r.quantityDelta > 0 ? '+' : ''}
          {r.quantityDelta} {r.unit}
        </span>
      ),
    },
    {
      key: 'a',
      header: 'After',
      align: 'right',
      hideOnMobile: true,
      cell: (r) => `${r.quantityAfter} ${r.unit}`,
    },
    { key: 'n', header: 'Reason', hideOnMobile: true, cell: (r) => r.note ?? '—' },
    { key: 'b', header: 'By', hideOnMobile: true, cell: (r) => r.byName ?? '—' },
  ];
  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Stock Adjustments"
        description="Every change to stock: deliveries, usage, wastage, count corrections and transfers. Record a new adjustment with a reason."
        actions={
          <button
            type="button"
            className={buttonPrimary}
            onClick={() => setOpen(true)}
            disabled={!stock.data}
          >
            <Plus className="size-4" /> New adjustment
          </button>
        }
      />
      <Toolbar>
        <BranchPicker branches={stock.data?.branches ?? []} value={branch} onChange={setBranchId} />
      </Toolbar>
      {/* Keyed by branch: the paged list fixes its filters on mount. */}
      {branch ? <Movements key={branch} branchId={branch} cols={cols} /> : null}
      {open ? <AdjustForm branchId={branch} onClose={() => setOpen(false)} /> : null}
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <PackageCheck className="size-3.5" /> Stock can never go below zero; a count sets the exact
        quantity on the shelf.
      </p>
    </div>
  );
}

function Movements({ branchId, cols }: { branchId: string; cols: Column<MovementRow>[] }) {
  const list = usePagedList<MovementRow>(
    `stock-adjustments-${branchId}`,
    '/inventory/movements',
    { sortBy: 'createdAt', filters: { branchId, type: '', from: '', to: '' } },
    { cursor: true },
  );
  return (
    <DataTable
      list={list}
      columns={cols}
      getRowId={(r) => r.id}
      searchPlaceholder="Item or reason"
      dateRange
      filters={[
        {
          key: 'type',
          label: 'Type',
          options: (['purchase', 'usage', 'wastage', 'count'] as const).map((t) => ({
            value: t,
            label: TYPE[t].label,
          })),
        },
      ]}
      empty={{
        title: 'No adjustments yet',
        description: 'Stock changes recorded here or on the Inventory screen appear in this list.',
      }}
    />
  );
}

function AdjustForm({ branchId, onClose }: { branchId: string; onClose: () => void }) {
  const stock = useStock(branchId);
  const w = useOpsWrite();
  const [itemId, setItemId] = useState('');
  const [type, setType] = useState<keyof typeof REASONS>('wastage');
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const item = stock.data?.items.find((i) => i.id === itemId);
  return (
    <FormDialog
      open
      onClose={onClose}
      title="New stock adjustment"
      submitLabel="Save adjustment"
      onSubmit={() =>
        w.send(`/inventory/items/${itemId}/movements`, 'POST', {
          branchId,
          type,
          quantity: Number(quantity),
          note,
        })
      }
    >
      <Field label="Item">
        <select
          required
          className={input}
          value={itemId}
          onChange={(e) => setItemId(e.target.value)}
        >
          <option value="">Choose item…</option>
          {stock.data?.items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} — {i.quantity} {i.unit} now
            </option>
          ))}
        </select>
      </Field>
      <Field label="Type">
        <select
          className={input}
          value={type}
          onChange={(e) => setType(e.target.value as keyof typeof REASONS)}
        >
          {Object.entries(REASONS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label={
          type === 'count'
            ? `Actual quantity on the shelf${item ? ` (${item.unit})` : ''}`
            : `Quantity${item ? ` (${item.unit})` : ''}`
        }
        hint={
          item && type !== 'count' && type !== 'purchase'
            ? `${item.quantity} ${item.unit} in stock`
            : undefined
        }
      >
        <input
          type="number"
          min={type === 'count' ? 0 : 0.001}
          step="0.001"
          required
          className={input}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
      </Field>
      <Field label="Reason">
        <input
          required
          maxLength={200}
          className={input}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Milk spoiled in the fridge"
        />
      </Field>
    </FormDialog>
  );
}
