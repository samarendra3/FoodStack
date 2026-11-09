'use client';

import { ArrowLeftRight, ArrowRight, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  BranchPicker,
  dateTime,
  Field,
  FormDialog,
  input,
  Table,
  Toolbar,
  useOps,
  useOpsWrite,
} from '../_kit/ops-kit';
import { useStock } from '../_kit/stock';
import {
  buttonPrimary,
  buttonSecondary,
  Card,
  EmptyNote,
  ErrorNote,
  PageHeader,
  Skeleton,
} from '../_kit/report-kit';

interface Transfers {
  branches: { id: string; name: string }[];
  canManage: boolean;
  rows: {
    id: string;
    createdAt: string;
    note: string | null;
    fromName: string;
    toName: string;
    byName: string | null;
    lines: { name: string; unit: string; quantity: number }[];
  }[];
}

export default function StockTransfersPage() {
  const [branchId, setBranchId] = useState('');
  const q = useOps<Transfers>(`/stock-transfers${branchId ? `?branchId=${branchId}` : ''}`);
  const d = q.data;
  const [creating, setCreating] = useState(false);
  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Stock Transfers"
        description="Move stock from one branch to another. Both branches' stock updates at once, and a short source is refused."
        actions={
          d?.canManage ? (
            <button type="button" className={buttonPrimary} onClick={() => setCreating(true)}>
              <Plus className="size-4" /> New transfer
            </button>
          ) : null
        }
      />
      <Toolbar>
        <BranchPicker
          branches={d?.branches ?? []}
          value={branchId}
          onChange={setBranchId}
          allLabel="All branches"
        />
      </Toolbar>
      {q.isError ? <ErrorNote error={q.error} /> : null}
      <Card>
        {q.isPending ? (
          <Skeleton className="h-40" />
        ) : !d?.rows.length ? (
          <EmptyNote
            icon={ArrowLeftRight}
            title="No transfers yet"
            text={
              (d?.branches.length ?? 0) < 2
                ? 'Transfers need at least two branches.'
                : 'Send surplus stock to the branch that needs it.'
            }
          />
        ) : (
          <Table
            rows={d.rows}
            rowKey={(r) => r.id}
            cols={[
              { key: 'd', header: 'When', cell: (r) => dateTime.format(new Date(r.createdAt)) },
              {
                key: 'r',
                header: 'Route',
                cell: (r) => (
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    {r.fromName} <ArrowRight className="size-3.5 text-slate-400" /> {r.toName}
                  </span>
                ),
              },
              {
                key: 'i',
                header: 'Items',
                cell: (r) => r.lines.map((l) => `${l.quantity} ${l.unit} ${l.name}`).join(', '),
              },
              { key: 'b', header: 'By', hideOnMobile: true, cell: (r) => r.byName ?? '—' },
              { key: 'n', header: 'Note', hideOnMobile: true, cell: (r) => r.note ?? '—' },
            ]}
          />
        )}
      </Card>
      {creating && d ? (
        <TransferForm branches={d.branches} onClose={() => setCreating(false)} />
      ) : null}
    </div>
  );
}

function TransferForm({
  branches,
  onClose,
}: {
  branches: { id: string; name: string }[];
  onClose: () => void;
}) {
  const w = useOpsWrite();
  const [from, setFrom] = useState(branches[0]?.id ?? '');
  const [to, setTo] = useState(branches[1]?.id ?? '');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<{ itemId: string; quantity: string }[]>([
    { itemId: '', quantity: '' },
  ]);
  const stock = useStock(from);
  const items = stock.data?.items ?? [];
  return (
    <FormDialog
      open
      onClose={onClose}
      size="lg"
      title="New stock transfer"
      submitLabel="Transfer stock"
      onSubmit={() =>
        w.send('/stock-transfers', 'POST', {
          fromBranchId: from,
          toBranchId: to,
          note,
          lines: lines
            .filter((l) => l.itemId)
            .map((l) => ({ itemId: l.itemId, quantity: Number(l.quantity) })),
        })
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="From">
          <select className={input} value={from} onChange={(e) => setFrom(e.target.value)}>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="To">
          <select className={input} value={to} onChange={(e) => setTo(e.target.value)}>
            {branches
              .filter((b) => b.id !== from)
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
          </select>
        </Field>
      </div>
      {lines.map((l, i) => {
        const it = items.find((x) => x.id === l.itemId);
        return (
          <div key={i} className="grid grid-cols-[1fr_7rem_2rem] items-start gap-2">
            <select
              aria-label="Item"
              className={input}
              value={l.itemId}
              onChange={(e) =>
                setLines((ls) => ls.map((x, j) => (j === i ? { ...x, itemId: e.target.value } : x)))
              }
            >
              <option value="">Choose item…</option>
              {items.map((x) => (
                <option key={x.id} value={x.id} disabled={x.quantity <= 0}>
                  {x.name} — {x.quantity} {x.unit} available
                </option>
              ))}
            </select>
            <input
              aria-label="Quantity"
              type="number"
              min="0.001"
              step="0.001"
              max={it?.quantity}
              placeholder={it?.unit ?? 'Qty'}
              className={input}
              value={l.quantity}
              onChange={(e) =>
                setLines((ls) =>
                  ls.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)),
                )
              }
            />
            <button
              type="button"
              aria-label="Remove"
              disabled={lines.length === 1}
              onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
              className="mt-2 text-slate-400 hover:text-red-600 disabled:opacity-30"
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
        <Plus className="size-4" /> Add item
      </button>
      <Field label="Note (optional)">
        <input
          maxLength={300}
          className={input}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
    </FormDialog>
  );
}
