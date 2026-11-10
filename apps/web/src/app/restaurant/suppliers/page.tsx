'use client';

import { DeleteConfirmDialog } from '@foodstack/ui/components/confirm-dialog';
import { Pencil, Plus, Search, Trash2, Truck } from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  dateOnly,
  Field,
  FormDialog,
  input,
  money,
  Table,
  Toolbar,
  useOps,
  useOpsWrite,
} from '../_kit/ops-kit';
import {
  buttonPrimary,
  Card,
  control,
  EmptyNote,
  ErrorNote,
  PageHeader,
  Skeleton,
  Stat,
  StatGrid,
} from '../_kit/report-kit';

interface Supplier {
  id: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  address: string | null;
  note: string | null;
  isActive: boolean;
  orders: number;
  spentMinor: number;
  lastReceivedAt: string | null;
}
interface Suppliers {
  currencyCode: string;
  canManage: boolean;
  rows: Supplier[];
}

export default function SuppliersPage() {
  const q = useOps<Suppliers>('/suppliers');
  const w = useOpsWrite();
  const [search, setSearch] = useState('');
  const [edit, setEdit] = useState<Partial<Supplier> | null>(null);
  const [del, setDel] = useState<Supplier | null>(null);
  const d = q.data;
  const m = (v: number) => money(v, d?.currencyCode);
  const rows = (d?.rows ?? []).filter(
    (s) =>
      !search ||
      `${s.name} ${s.contactName ?? ''} ${s.phone ?? ''}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Suppliers"
        description="The vendors you buy from, with what you have spent with each."
        actions={
          d?.canManage ? (
            <button
              type="button"
              className={buttonPrimary}
              onClick={() => setEdit({ isActive: true })}
            >
              <Plus className="size-4" /> Add supplier
            </button>
          ) : null
        }
      />
      {q.isError ? <ErrorNote error={q.error} /> : null}
      <StatGrid>
        <Stat icon={Truck} label="Suppliers" value={d?.rows.length} loading={q.isPending} />
        <Stat
          label="Active"
          value={d?.rows.filter((s) => s.isActive).length}
          loading={q.isPending}
        />
        <Stat
          label="Purchase orders"
          value={d?.rows.reduce((t, s) => t + s.orders, 0)}
          loading={q.isPending}
        />
        <Stat
          label="Total purchased"
          value={d ? m(d.rows.reduce((t, s) => t + s.spentMinor, 0)) : undefined}
          hint="Received orders"
          loading={q.isPending}
        />
      </StatGrid>
      <Toolbar>
        <label className="relative col-span-2 sm:w-80">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, contact or phone"
            aria-label="Search suppliers"
            className={`${control} w-full pl-9`}
          />
        </label>
      </Toolbar>
      <Card>
        {q.isPending ? (
          <Skeleton className="h-40" />
        ) : rows.length === 0 ? (
          <EmptyNote
            icon={Truck}
            title={d?.rows.length ? 'No suppliers match' : 'No suppliers yet'}
            text="Add the vendors you buy groceries, meat, gas and packaging from."
          />
        ) : (
          <Table
            rows={rows}
            rowKey={(r) => r.id}
            cols={[
              {
                key: 'n',
                header: 'Supplier',
                cell: (r) => (
                  <div>
                    <p className="font-medium">{r.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {[r.contactName, r.phone, r.email].filter(Boolean).join(' · ') || '—'}
                    </p>
                  </div>
                ),
              },
              { key: 'g', header: 'GSTIN', hideOnMobile: true, cell: (r) => r.gstin ?? '—' },
              {
                key: 's',
                header: 'Status',
                cell: (r) =>
                  r.isActive ? <Badge tone="emerald">Active</Badge> : <Badge>Inactive</Badge>,
              },
              {
                key: 'o',
                header: 'Orders',
                align: 'right',
                hideOnMobile: true,
                cell: (r) => r.orders,
              },
              {
                key: 'l',
                header: 'Last delivery',
                hideOnMobile: true,
                cell: (r) => (r.lastReceivedAt ? dateOnly.format(new Date(r.lastReceivedAt)) : '—'),
              },
              { key: 'p', header: 'Purchased', align: 'right', cell: (r) => m(r.spentMinor) },
              {
                key: 'x',
                header: '',
                align: 'right',
                cell: (r) =>
                  d?.canManage ? (
                    <span className="inline-flex gap-1">
                      <button
                        type="button"
                        aria-label={`Edit ${r.name}`}
                        className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-white/10"
                        onClick={() => setEdit(r)}
                      >
                        <Pencil className="size-4" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${r.name}`}
                        className="rounded p-1 text-slate-500 hover:bg-red-50 hover:text-red-600"
                        onClick={() => setDel(r)}
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </span>
                  ) : null,
              },
            ]}
          />
        )}
      </Card>
      {edit ? (
        <SupplierForm
          value={edit}
          onClose={() => setEdit(null)}
          save={(b) =>
            edit.id ? w.send(`/suppliers/${edit.id}`, 'PATCH', b) : w.send('/suppliers', 'POST', b)
          }
        />
      ) : null}
      <DeleteConfirmDialog
        open={del !== null}
        onClose={() => setDel(null)}
        entity="supplier"
        name={del?.name}
        onConfirm={() => w.send(`/suppliers/${del!.id}`, 'DELETE')}
      />
    </div>
  );
}

function SupplierForm({
  value,
  onClose,
  save,
}: {
  value: Partial<Supplier>;
  onClose: () => void;
  save: (b: Record<string, unknown>) => Promise<unknown>;
}) {
  const [f, setF] = useState({
    name: value.name ?? '',
    contactName: value.contactName ?? '',
    phone: value.phone ?? '',
    email: value.email ?? '',
    gstin: value.gstin ?? '',
    address: value.address ?? '',
    note: value.note ?? '',
    isActive: value.isActive ?? true,
  });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  return (
    <FormDialog
      open
      onClose={onClose}
      title={value.id ? 'Edit supplier' : 'Add supplier'}
      onSubmit={() => save(f)}
      size="lg"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <input
            required
            maxLength={120}
            className={input}
            value={f.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
        <Field label="Contact person">
          <input
            maxLength={80}
            className={input}
            value={f.contactName}
            onChange={(e) => set({ contactName: e.target.value })}
          />
        </Field>
        <Field label="Phone">
          <input
            maxLength={20}
            className={input}
            value={f.phone}
            onChange={(e) => set({ phone: e.target.value })}
          />
        </Field>
        <Field label="Email">
          <input
            type="email"
            className={input}
            value={f.email}
            onChange={(e) => set({ email: e.target.value })}
          />
        </Field>
        <Field label="GSTIN">
          <input
            maxLength={15}
            className={input}
            value={f.gstin}
            onChange={(e) => set({ gstin: e.target.value.toUpperCase() })}
          />
        </Field>
        <Field label="Status">
          <select
            className={input}
            value={f.isActive ? '1' : '0'}
            onChange={(e) => set({ isActive: e.target.value === '1' })}
          >
            <option value="1">Active</option>
            <option value="0">Inactive (cannot receive new orders)</option>
          </select>
        </Field>
      </div>
      <Field label="Address">
        <input
          maxLength={300}
          className={input}
          value={f.address}
          onChange={(e) => set({ address: e.target.value })}
        />
      </Field>
      <Field label="Note">
        <input
          maxLength={300}
          className={input}
          value={f.note}
          onChange={(e) => set({ note: e.target.value })}
          placeholder="Payment terms, delivery days…"
        />
      </Field>
    </FormDialog>
  );
}
