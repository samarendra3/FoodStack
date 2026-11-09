'use client';

import { ConfirmDialog } from '@foodstack/ui/components/confirm-dialog';
import { PackageCheck, Plus, ShoppingBasket, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  BranchPicker,
  dateOnly,
  Field,
  FormDialog,
  input,
  money,
  Table,
  toMinor,
  Toolbar,
  useOps,
  useOpsWrite,
} from '../_kit/ops-kit';
import { useStock } from '../_kit/stock';
import {
  buttonPrimary,
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

type Status = 'draft' | 'ordered' | 'received' | 'cancelled';
interface PoRow {
  id: string;
  number: number;
  status: Status;
  expectedOn: string | null;
  totalMinor: number;
  createdAt: string;
  receivedAt: string | null;
  branchId: string;
  branchName: string;
  supplierId: string;
  supplierName: string;
  lineCount: number;
}
interface PoList {
  currencyCode: string;
  branches: { id: string; name: string }[];
  canManage: boolean;
  rows: PoRow[];
}
interface PoDetail extends PoRow {
  note: string | null;
  lines: {
    id: string;
    itemId: string;
    name: string;
    unit: string;
    quantity: number;
    unitCostMinor: number;
    receivedQuantity: number | null;
  }[];
}
const TONE: Record<Status, 'slate' | 'sky' | 'emerald' | 'red'> = {
  draft: 'slate',
  ordered: 'sky',
  received: 'emerald',
  cancelled: 'red',
};

export default function PurchaseOrdersPage() {
  const [branchId, setBranchId] = useState('');
  const [status, setStatus] = useState('');
  const qs = new URLSearchParams({
    ...(branchId ? { branchId } : {}),
    ...(status ? { status } : {}),
  });
  const q = useOps<PoList>(`/purchase-orders?${qs}`);
  const d = q.data;
  const w = useOpsWrite();
  const m = (v: number) => money(v, d?.currencyCode);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Purchase Orders"
        description="Order from suppliers, then receive the delivery: received quantities go straight into stock at the latest cost."
        actions={
          d?.canManage ? (
            <button type="button" className={buttonPrimary} onClick={() => setCreating(true)}>
              <Plus className="size-4" /> New purchase order
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
        <select
          aria-label="Status"
          className={control}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="ordered">Ordered</option>
          <option value="received">Received</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </Toolbar>
      {q.isError ? <ErrorNote error={q.error} /> : null}
      <StatGrid>
        <Stat
          icon={ShoppingBasket}
          label="Waiting for delivery"
          value={d?.rows.filter((r) => r.status === 'ordered').length}
          loading={q.isPending}
        />
        <Stat
          label="Overdue"
          value={
            d?.rows.filter((r) => r.status === 'ordered' && r.expectedOn && r.expectedOn < today)
              .length
          }
          loading={q.isPending}
        />
        <Stat
          label="Drafts"
          value={d?.rows.filter((r) => r.status === 'draft').length}
          loading={q.isPending}
        />
        <Stat
          label="Received value"
          value={
            d
              ? m(
                  d.rows
                    .filter((r) => r.status === 'received')
                    .reduce((t, r) => t + r.totalMinor, 0),
                )
              : undefined
          }
          loading={q.isPending}
        />
      </StatGrid>
      <Card>
        {q.isPending ? (
          <Skeleton className="h-40" />
        ) : !d?.rows.length ? (
          <EmptyNote
            icon={ShoppingBasket}
            title="No purchase orders"
            text="Create one to order stock from a supplier. Add suppliers first on the Suppliers screen."
          />
        ) : (
          <Table
            rows={d.rows}
            rowKey={(r) => r.id}
            onRow={(r) => setOpenId(r.id)}
            cols={[
              {
                key: 'n',
                header: 'PO',
                cell: (r) => <span className="font-medium">#{r.number}</span>,
              },
              { key: 's', header: 'Supplier', cell: (r) => r.supplierName },
              { key: 'b', header: 'Branch', hideOnMobile: true, cell: (r) => r.branchName },
              {
                key: 'st',
                header: 'Status',
                cell: (r) => (
                  <Badge
                    tone={
                      r.status === 'ordered' && r.expectedOn && r.expectedOn < today
                        ? 'amber'
                        : TONE[r.status]
                    }
                  >
                    {r.status === 'ordered' && r.expectedOn && r.expectedOn < today
                      ? 'Overdue'
                      : r.status}
                  </Badge>
                ),
              },
              {
                key: 'e',
                header: 'Expected',
                hideOnMobile: true,
                cell: (r) => (r.expectedOn ? dateOnly.format(new Date(r.expectedOn)) : '—'),
              },
              {
                key: 'l',
                header: 'Items',
                align: 'right',
                hideOnMobile: true,
                cell: (r) => r.lineCount,
              },
              { key: 't', header: 'Total', align: 'right', cell: (r) => m(r.totalMinor) },
            ]}
          />
        )}
      </Card>
      {creating && d ? (
        <CreatePo branches={d.branches} onClose={() => setCreating(false)} send={w.send} />
      ) : null}
      {openId ? (
        <PoPanel
          id={openId}
          canManage={Boolean(d?.canManage)}
          money={m}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </div>
  );
}

function CreatePo({
  branches,
  onClose,
  send,
}: {
  branches: { id: string; name: string }[];
  onClose: () => void;
  send: ReturnType<typeof useOpsWrite>['send'];
}) {
  const [branchId, setBranchId] = useState(branches[0]?.id ?? '');
  const suppliers = useOps<{ rows: { id: string; name: string; isActive: boolean }[] }>(
    '/suppliers',
  );
  const stock = useStock(branchId);
  const [supplierId, setSupplierId] = useState('');
  const [expectedOn, setExpectedOn] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<{ itemId: string; quantity: string; cost: string }[]>([
    { itemId: '', quantity: '', cost: '' },
  ]);
  const items = stock.data?.items ?? [];
  const total = lines.reduce((t, l) => t + Number(l.quantity || 0) * toMinor(l.cost), 0);
  const [placeOrder, setPlaceOrder] = useState(true);
  return (
    <FormDialog
      open
      onClose={onClose}
      size="xl"
      title="New purchase order"
      submitLabel={placeOrder ? 'Create and mark ordered' : 'Save draft'}
      onSubmit={async () => {
        const r = await send<{ id: string }>('/purchase-orders', 'POST', {
          branchId,
          supplierId,
          expectedOn: expectedOn || null,
          note,
          lines: lines
            .filter((l) => l.itemId)
            .map((l) => ({
              itemId: l.itemId,
              quantity: Number(l.quantity),
              unitCostMinor: toMinor(l.cost),
            })),
        });
        if (placeOrder) await send(`/purchase-orders/${r.id}/order`, 'POST');
      }}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Supplier">
          <select
            required
            className={input}
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
          >
            <option value="">Choose…</option>
            {suppliers.data?.rows
              .filter((s) => s.isActive)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Deliver to">
          <select className={input} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Expected on">
          <input
            type="date"
            className={input}
            value={expectedOn}
            onChange={(e) => setExpectedOn(e.target.value)}
          />
        </Field>
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium">Items</p>
        {lines.map((l, i) => {
          const item = items.find((x) => x.id === l.itemId);
          return (
            <div key={i} className="grid grid-cols-[1fr_5.5rem_6.5rem_2rem] items-center gap-2">
              <select
                aria-label="Stock item"
                className={input}
                value={l.itemId}
                onChange={(e) => {
                  const it = items.find((x) => x.id === e.target.value);
                  setLines((ls) =>
                    ls.map((x, j) =>
                      j === i
                        ? {
                            ...x,
                            itemId: e.target.value,
                            cost:
                              x.cost ||
                              (it?.costPerUnitMinor ? String(it.costPerUnitMinor / 100) : ''),
                          }
                        : x,
                    ),
                  );
                }}
              >
                <option value="">Choose item…</option>
                {items.map((it) => (
                  <option
                    key={it.id}
                    value={it.id}
                    disabled={lines.some((x, j) => j !== i && x.itemId === it.id)}
                  >
                    {it.name} ({it.unit})
                  </option>
                ))}
              </select>
              <input
                aria-label="Quantity"
                type="number"
                min="0.001"
                step="0.001"
                placeholder={item?.unit ?? 'Qty'}
                className={input}
                value={l.quantity}
                onChange={(e) =>
                  setLines((ls) =>
                    ls.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)),
                  )
                }
              />
              <input
                aria-label="Cost per unit"
                type="number"
                min="0"
                step="0.01"
                placeholder="₹ / unit"
                className={input}
                value={l.cost}
                onChange={(e) =>
                  setLines((ls) => ls.map((x, j) => (j === i ? { ...x, cost: e.target.value } : x)))
                }
              />
              <button
                type="button"
                aria-label="Remove line"
                disabled={lines.length === 1}
                onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                className="rounded p-1 text-slate-400 hover:text-red-600 disabled:opacity-30"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className={buttonSecondary}
          onClick={() => setLines((ls) => [...ls, { itemId: '', quantity: '', cost: '' }])}
        >
          <Plus className="size-4" /> Add item
        </button>
        {items.length === 0 && !stock.isPending ? (
          <p className="text-sm text-amber-700">Add stock items on the Inventory screen first.</p>
        ) : null}
      </div>
      <Field label="Note (optional)">
        <input
          maxLength={300}
          className={input}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 p-3 text-sm dark:bg-white/5">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={placeOrder}
            onChange={(e) => setPlaceOrder(e.target.checked)}
            className="size-4 accent-emerald-600"
          />
          Mark as sent to supplier
        </label>
        <span className="font-semibold">Total {money(total)}</span>
      </div>
    </FormDialog>
  );
}

function PoPanel({
  id,
  canManage,
  money: m,
  onClose,
}: {
  id: string;
  canManage: boolean;
  money: (v: number) => string;
  onClose: () => void;
}) {
  const q = useOps<PoDetail>(`/purchase-orders/${id}`);
  const w = useOpsWrite();
  const po = q.data;
  const [received, setReceived] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<'cancel' | null>(null);
  const receivable = po && (po.status === 'ordered' || po.status === 'draft');
  return (
    <>
      <FormDialog
        open={confirm === null}
        onClose={onClose}
        size="xl"
        title={po ? `PO #${po.number} · ${po.supplierName}` : 'Purchase order'}
        description={
          po
            ? `${po.branchName} · ${po.status}${po.expectedOn ? ` · expected ${dateOnly.format(new Date(po.expectedOn))}` : ''}`
            : undefined
        }
        submitLabel={receivable && canManage ? 'Receive into stock' : 'Done'}
        onSubmit={async () => {
          if (!(receivable && canManage) || !po) return;
          await w.send(`/purchase-orders/${id}/receive`, 'POST', {
            lines: po.lines.map((l) => ({
              lineId: l.id,
              receivedQuantity: Number(received[l.id] ?? l.quantity),
            })),
          });
        }}
      >
        {q.isError ? <ErrorNote error={q.error} /> : null}
        {!po ? (
          <Skeleton className="h-32" />
        ) : (
          <>
            <Table
              rows={po.lines}
              rowKey={(l) => l.id}
              cols={[
                { key: 'n', header: 'Item', cell: (l) => l.name },
                {
                  key: 'q',
                  header: 'Ordered',
                  align: 'right',
                  cell: (l) => `${l.quantity} ${l.unit}`,
                },
                {
                  key: 'c',
                  header: 'Cost',
                  align: 'right',
                  hideOnMobile: true,
                  cell: (l) => m(l.unitCostMinor),
                },
                {
                  key: 'r',
                  header: 'Received',
                  align: 'right',
                  cell: (l) =>
                    receivable && canManage ? (
                      <input
                        aria-label={`Received ${l.name}`}
                        type="number"
                        min="0"
                        step="0.001"
                        className={`${control} w-24 text-right`}
                        value={received[l.id] ?? String(l.quantity)}
                        onChange={(e) => setReceived((r) => ({ ...r, [l.id]: e.target.value }))}
                      />
                    ) : l.receivedQuantity === null ? (
                      '—'
                    ) : (
                      `${l.receivedQuantity} ${l.unit}`
                    ),
                },
              ]}
            />
            <p className="text-right text-sm font-semibold">Total {m(po.totalMinor)}</p>
            {receivable && canManage ? (
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
                <span>
                  Change a quantity if the delivery was short. Received stock is added at{' '}
                  {po.branchName}.
                </span>
                <span className="flex gap-2">
                  {po.status === 'draft' ? (
                    <button
                      type="button"
                      className={buttonSecondary}
                      onClick={() =>
                        void w.act(
                          `/purchase-orders/${id}/order`,
                          'POST',
                          undefined,
                          'Marked as ordered',
                        )
                      }
                    >
                      <PackageCheck className="size-4" /> Mark ordered
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={buttonSecondary}
                    onClick={() => setConfirm('cancel')}
                  >
                    Cancel PO
                  </button>
                </span>
              </div>
            ) : null}
          </>
        )}
      </FormDialog>
      <ConfirmDialog
        open={confirm === 'cancel'}
        onClose={() => setConfirm(null)}
        variant="danger"
        title={`Cancel PO #${po?.number}?`}
        description="The order is kept for your records but can no longer be received."
        confirmLabel="Cancel PO"
        onConfirm={async () => {
          await w.send(`/purchase-orders/${id}/cancel`, 'POST');
          onClose();
        }}
      />
    </>
  );
}
