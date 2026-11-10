'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { Armchair, Loader2, Pencil, Plus, Rows3, Trash2, Users, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { authErrorMessage } from '@/lib/auth/errors';
import { type DiningTable, useTableMutations, useTables } from '@/lib/tables';
import { useRestaurantOverview } from '../overview';
import { TableSessionPanel } from './table-session-panel';

const money = (minor: number) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(minor / 100);

function minutesSince(iso: string | null) {
  if (!iso) return '';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

type Dialog =
  | { kind: 'add' }
  | { kind: 'bulk' }
  | { kind: 'edit'; table: DiningTable }
  | { kind: 'delete'; table: DiningTable };

/** ?branchId= from the branch admin menu. Read once, without useSearchParams (which suspends). */
function branchFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('branchId');
}

export default function TablesPage() {
  const [urlBranch] = useState(branchFromUrl);
  const overview = useRestaurantOverview();
  const branches = overview.data?.branches ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const branchId = picked ?? urlBranch ?? branches[0]?.id;
  const branch = branches.find((b) => b.id === branchId);
  const tables = useTables(branchId);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [viewing, setViewing] = useState<DiningTable | null>(null);

  const list = tables.data?.tables ?? [];
  const canManage = tables.data?.canManage ?? false;
  const areas = [...new Set(list.map((t) => t.area))];
  const occupied = list.filter((t) => t.status === 'occupied').length;

  return (
    <div className="mx-auto max-w-[96rem] space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-white">
            Tables
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {list.length
              ? `${occupied} of ${list.length} occupied · updates live`
              : 'Set up the tables for dine-in orders.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {branches.length > 1 ? (
            <select
              aria-label="Branch"
              value={branchId ?? ''}
              onChange={(e) => setPicked(e.target.value)}
              className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-white/10 dark:bg-slate-900"
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          ) : null}
          {canManage ? (
            <>
              <button
                type="button"
                onClick={() => setDialog({ kind: 'bulk' })}
                className={ghostBtn}
              >
                <Rows3 className="size-4" aria-hidden /> Add several
              </button>
              <button
                type="button"
                onClick={() => setDialog({ kind: 'add' })}
                className={primaryBtn}
              >
                <Plus className="size-4" aria-hidden /> Add table
              </button>
            </>
          ) : null}
        </div>
      </div>

      {tables.isPending || overview.isPending ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6" aria-hidden>
          {Array.from({ length: 6 }, (_, i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-xl bg-slate-200/60 dark:bg-white/5"
            />
          ))}
        </div>
      ) : tables.isError ? (
        <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {authErrorMessage(tables.error)}
        </p>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center dark:border-white/15 dark:bg-slate-900">
          <span className="flex size-10 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">
            <Armchair className="size-5" />
          </span>
          <p className="mt-3 font-medium text-slate-900 dark:text-white">
            No tables{branch ? ` at ${branch.name}` : ''} yet
          </p>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {canManage
              ? 'Add them one by one, or several at once (e.g. T1 to T10).'
              : 'Ask a manager to set up the tables.'}
          </p>
          {canManage ? (
            <button
              type="button"
              onClick={() => setDialog({ kind: 'bulk' })}
              className={cn(primaryBtn, 'mt-4')}
            >
              <Rows3 className="size-4" aria-hidden /> Add tables
            </button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-6">
          <div className="flex gap-4 text-xs text-slate-500 dark:text-slate-400">
            <Legend className="bg-white ring-slate-300 dark:bg-slate-900 dark:ring-white/20">
              Free
            </Legend>
            <Legend className="bg-amber-100 ring-amber-300 dark:bg-amber-500/20 dark:ring-amber-500/40">
              Occupied
            </Legend>
          </div>
          {areas.map((area) => (
            <section key={area}>
              <h2 className="mb-2 text-sm font-medium text-slate-500 dark:text-slate-400">
                {area}
              </h2>
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8">
                {list
                  .filter((t) => t.area === area)
                  .map((t) => (
                    <TableTile
                      key={t.id}
                      table={t}
                      canManage={canManage}
                      onOpen={() => setViewing(t)}
                      onEdit={() => setDialog({ kind: 'edit', table: t })}
                      onDelete={() => setDialog({ kind: 'delete', table: t })}
                    />
                  ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {viewing ? (
        <TableSessionPanel
          tableId={viewing.id}
          tableLabel={viewing.label}
          onClose={() => setViewing(null)}
        />
      ) : null}

      {dialog && branchId ? (
        <Modal onClose={() => setDialog(null)}>
          {dialog.kind === 'add' || dialog.kind === 'edit' ? (
            <TableForm
              branchId={branchId}
              areas={areas}
              tables={list}
              table={dialog.kind === 'edit' ? dialog.table : undefined}
              onDone={() => setDialog(null)}
            />
          ) : dialog.kind === 'bulk' ? (
            <BulkForm
              branchId={branchId}
              areas={areas}
              next={list.length + 1}
              onDone={() => setDialog(null)}
            />
          ) : (
            <DeleteTable table={dialog.table} onDone={() => setDialog(null)} />
          )}
        </Modal>
      ) : null}
    </div>
  );
}

function TableTile({
  table: t,
  canManage,
  onOpen,
  onEdit,
  onDelete,
}: {
  table: DiningTable;
  canManage: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const busy = t.status === 'occupied';
  return (
    <li
      className={cn(
        'group relative rounded-xl p-3 ring-1 transition-colors',
        busy
          ? 'bg-amber-50 ring-amber-300 dark:bg-amber-500/10 dark:ring-amber-500/40'
          : 'bg-white ring-slate-200 dark:bg-slate-900 dark:ring-white/10',
      )}
    >
      <div className="flex items-start justify-between">
        <button
          type="button"
          onClick={onOpen}
          className="text-left text-lg font-semibold text-slate-900 after:absolute after:inset-0 after:content-[''] hover:underline dark:text-white"
          aria-label={`Open table ${t.label} details`}
        >
          {t.label}
        </button>
        <span className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
          <Users className="size-3.5" aria-hidden /> {t.seats}
        </span>
      </div>
      {busy ? (
        <div className="mt-2 text-sm">
          <p className="font-semibold text-amber-800 dark:text-amber-300">
            {money(t.openTotalMinor)}
          </p>
          <p className="text-xs text-amber-700/80 dark:text-amber-300/70">
            {t.openOrders > 1 ? `${t.openOrders} orders · ` : ''}
            {minutesSince(t.since)}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">Free</p>
      )}
      {canManage ? (
        <div className="absolute right-1.5 bottom-1.5 z-10 flex gap-0.5 opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit ${t.label}`}
            className="rounded-md p-1.5 text-slate-500 hover:bg-black/5 dark:hover:bg-white/10"
          >
            <Pencil className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Remove ${t.label}`}
            className="rounded-md p-1.5 text-slate-500 hover:bg-red-500/10 hover:text-red-600"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ) : null}
    </li>
  );
}

function TableForm({
  branchId,
  areas,
  tables,
  table,
  onDone,
}: {
  branchId: string;
  areas: string[];
  tables: DiningTable[];
  table?: DiningTable;
  onDone: () => void;
}) {
  const m = useTableMutations();
  const [label, setLabel] = useState(table?.label ?? '');
  // New tables: the area of the last added table, until the label suggests another one.
  const [area, setArea] = useState(
    table?.area ??
      [...tables].sort((a, b) => b.sortOrder - a.sortOrder)[0]?.area ??
      areas[0] ??
      'Main area',
  );
  const [areaTouched, setAreaTouched] = useState(Boolean(table));
  const onLabel = (v: string) => {
    setLabel(v);
    if (areaTouched) return;
    // "R5" → the area where R1…R4 are (same letters before the number).
    const prefix =
      v
        .trim()
        .match(/^[^0-9]*/)?.[0]
        .toLowerCase() ?? '';
    if (!prefix) return;
    const same = tables.filter(
      (t) => (t.label.match(/^[^0-9]*/)?.[0].toLowerCase() ?? '') === prefix,
    );
    if (same.length) setArea(same.sort((a, b) => b.sortOrder - a.sortOrder)[0]!.area);
  };
  const [seats, setSeats] = useState(String(table?.seats ?? 4));
  const mutation = table ? m.update : m.create;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { area: area.trim(), label: label.trim(), seats: Number(seats) };
    try {
      if (table) await m.update.mutateAsync({ id: table.id, ...body });
      else await m.create.mutateAsync({ branchId, ...body });
      onDone();
    } catch {
      // Shown below from mutation.error.
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <h2 className="font-semibold text-slate-900 dark:text-white">
        {table ? `Edit ${table.label}` : 'Add a table'}
      </h2>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Table name">
          <input
            autoFocus
            required
            maxLength={20}
            value={label}
            onChange={(e) => onLabel(e.target.value)}
            placeholder="e.g. T1"
            className={input}
          />
        </Field>
        <Field label="Seats">
          <input
            required
            type="number"
            min={1}
            max={50}
            value={seats}
            onChange={(e) => setSeats(e.target.value)}
            className={input}
          />
        </Field>
      </div>
      <AreaField
        value={area}
        onChange={(v) => {
          setArea(v);
          setAreaTouched(true);
        }}
        areas={areas}
      />
      <Errors error={mutation.error} />
      <Actions onCancel={onDone} busy={mutation.isPending} label={table ? 'Save' : 'Add table'} />
    </form>
  );
}

function BulkForm({
  branchId,
  areas,
  next,
  onDone,
}: {
  branchId: string;
  areas: string[];
  next: number;
  onDone: () => void;
}) {
  const m = useTableMutations();
  const [prefix, setPrefix] = useState('T');
  const [from, setFrom] = useState(String(next));
  const [to, setTo] = useState(String(next + 9));
  const [area, setArea] = useState(areas[0] ?? 'Main area');
  const [seats, setSeats] = useState('4');
  const [result, setResult] = useState<string | null>(null);
  const count = Math.max(0, Number(to) - Number(from) + 1);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await m.bulk.mutateAsync({
        branchId,
        area: area.trim(),
        prefix: prefix.trim(),
        from: Number(from),
        to: Number(to),
        seats: Number(seats),
      });
      if (r.skipped) setResult(`Added ${r.created}; ${r.skipped} already existed.`);
      else onDone();
    } catch {
      // Shown below.
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <h2 className="font-semibold text-slate-900 dark:text-white">Add several tables</h2>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Prefix">
          <input
            value={prefix}
            maxLength={10}
            onChange={(e) => setPrefix(e.target.value)}
            className={input}
          />
        </Field>
        <Field label="From">
          <input
            type="number"
            min={0}
            max={999}
            required
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={input}
          />
        </Field>
        <Field label="To">
          <input
            type="number"
            min={0}
            max={999}
            required
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={input}
          />
        </Field>
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {count > 0 && count <= 100
          ? `Creates ${prefix}${from} to ${prefix}${to} (${count} tables). Existing names are skipped.`
          : 'Choose a range of 1 to 100 tables.'}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <AreaField value={area} onChange={setArea} areas={areas} />
        <Field label="Seats each">
          <input
            type="number"
            min={1}
            max={50}
            required
            value={seats}
            onChange={(e) => setSeats(e.target.value)}
            className={input}
          />
        </Field>
      </div>
      {result ? (
        <p className="rounded-md bg-emerald-50 p-2.5 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
          {result}
        </p>
      ) : null}
      <Errors error={m.bulk.error} />
      {result ? (
        <div className="flex justify-end">
          <button type="button" onClick={onDone} className={primaryBtn}>
            Done
          </button>
        </div>
      ) : (
        <Actions
          onCancel={onDone}
          busy={m.bulk.isPending}
          label={`Add ${count > 0 && count <= 100 ? count : ''} tables`}
          disabled={!(count > 0 && count <= 100)}
        />
      )}
    </form>
  );
}

function DeleteTable({ table, onDone }: { table: DiningTable; onDone: () => void }) {
  const m = useTableMutations();
  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-slate-900 dark:text-white">Remove {table.label}?</h2>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        It disappears from the POS. Past orders keep the table name.
      </p>
      <Errors error={m.remove.error} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className={ghostBtn}>
          Cancel
        </button>
        <button
          type="button"
          disabled={m.remove.isPending}
          onClick={() => m.remove.mutate(table.id, { onSuccess: onDone })}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-red-600 px-3 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          {m.remove.isPending ? <Loader2 className="size-4 animate-spin" /> : null} Remove
        </button>
      </div>
    </div>
  );
}

// ---- small pieces ----

const input =
  'h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-emerald-600 focus:ring-4 focus:ring-emerald-600/15 dark:border-white/10 dark:bg-white/5';
const primaryBtn =
  'inline-flex h-9 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50';
const ghostBtn =
  'inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-white/5';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="font-medium text-slate-700 dark:text-slate-200">{label}</span>
      {children}
    </label>
  );
}

function AreaField({
  value,
  onChange,
  areas,
}: {
  value: string;
  onChange: (v: string) => void;
  areas: string[];
}) {
  return (
    <Field label="Area">
      <input
        required
        maxLength={40}
        list="table-areas"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. Ground floor, Terrace"
        className={input}
      />
      <datalist id="table-areas">
        {areas.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
    </Field>
  );
}

function Errors({ error }: { error: unknown }) {
  return error ? (
    <p className="rounded-md bg-red-50 p-2.5 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
      {authErrorMessage(error)}
    </p>
  ) : null;
}

function Actions({
  onCancel,
  busy,
  label,
  disabled,
}: {
  onCancel: () => void;
  busy: boolean;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex justify-end gap-2">
      <button type="button" onClick={onCancel} className={ghostBtn}>
        Cancel
      </button>
      <button type="submit" disabled={busy || disabled} className={primaryBtn}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : null} {label}
      </button>
    </div>
  );
}

function Legend({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn('size-3 rounded ring-1', className)} aria-hidden />
      {children}
    </span>
  );
}

function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-slate-900"
      >
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute top-3 right-3 rounded-md p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-white/5"
        >
          <X className="size-4" />
        </button>
        {children}
      </div>
    </div>
  );
}
