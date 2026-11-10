'use client';

import { Pencil, Plus, Receipt, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { DeleteConfirmDialog } from '@foodstack/ui/components/confirm-dialog';
import { downloadCsv } from '@/lib/csv';
import { RankedBars } from '../dashboard/charts';
import {
  Badge,
  BranchPicker,
  dateOnly,
  daysAgo,
  Field,
  FormDialog,
  input,
  money,
  Table,
  today,
  toMinor,
  toRupees,
  Toolbar,
  useOps,
  useOpsWrite,
} from '../_kit/ops-kit';
import {
  buttonPrimary,
  Card,
  control,
  CsvButton,
  EmptyNote,
  ErrorNote,
  PageHeader,
  Skeleton,
  Stat,
  StatGrid,
} from '../_kit/report-kit';

interface Expense {
  id: string;
  branchId: string;
  branchName: string;
  category: string;
  amountMinor: number;
  paidVia: 'cash' | 'card' | 'upi' | 'bank';
  vendor: string | null;
  note: string | null;
  spentOn: string;
  byName: string | null;
}
interface Expenses {
  currencyCode: string;
  branches: { id: string; name: string }[];
  canManage: boolean;
  categories: string[];
  rows: Expense[];
}
const SUGGESTED = [
  'Groceries',
  'Vegetables',
  'Gas',
  'Electricity',
  'Rent',
  'Salaries',
  'Repairs',
  'Cleaning',
  'Packaging',
  'Marketing',
];
const PAID = { cash: 'Cash (from till)', card: 'Card', upi: 'UPI', bank: 'Bank transfer' } as const;

export default function ExpensesPage() {
  const [branchId, setBranchId] = useState('');
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(today());
  const [category, setCategory] = useState('');
  const qs = new URLSearchParams({
    from,
    to,
    ...(branchId ? { branchId } : {}),
    ...(category ? { category } : {}),
  });
  const q = useOps<Expenses>(`/expenses?${qs}`);
  const w = useOpsWrite();
  const d = q.data;
  const m = (v: number) => money(v, d?.currencyCode);
  const [edit, setEdit] = useState<Partial<Expense> | null>(null);
  const [del, setDel] = useState<Expense | null>(null);
  const total = d?.rows.reduce((t, r) => t + r.amountMinor, 0) ?? 0;
  const byCat = Object.entries(
    (d?.rows ?? []).reduce<Record<string, number>>(
      (a, r) => ({ ...a, [r.category]: (a[r.category] ?? 0) + r.amountMinor }),
      {},
    ),
  ).sort((a, b) => b[1] - a[1]);
  const days = Math.max(
    1,
    Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000) + 1,
  );

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Expenses"
        description="Everything the restaurant spends money on. Cash paid from the till is deducted from the open register."
        actions={
          <>
            <CsvButton
              disabled={!d?.rows.length}
              onClick={() =>
                downloadCsv(`expenses-${from}-to-${to}.csv`, [
                  ['Date', 'Branch', 'Category', 'Vendor', 'Paid via', 'Amount', 'Note'],
                  ...d!.rows.map((r) => [
                    r.spentOn,
                    r.branchName,
                    r.category,
                    r.vendor ?? '',
                    r.paidVia,
                    (r.amountMinor / 100).toFixed(2),
                    r.note ?? '',
                  ]),
                ])
              }
            />
            {d?.canManage ? (
              <button
                type="button"
                className={buttonPrimary}
                onClick={() =>
                  setEdit({
                    spentOn: today(),
                    paidVia: 'cash',
                    branchId: branchId || d.branches[0]?.id,
                  })
                }
              >
                <Plus className="size-4" /> Add expense
              </button>
            ) : null}
          </>
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
          aria-label="Category"
          className={control}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">All categories</option>
          {d?.categories.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <input
          type="date"
          aria-label="From"
          className={control}
          value={from}
          max={to}
          onChange={(e) => setFrom(e.target.value)}
        />
        <input
          type="date"
          aria-label="To"
          className={control}
          value={to}
          min={from}
          onChange={(e) => setTo(e.target.value)}
        />
      </Toolbar>
      {q.isError ? <ErrorNote error={q.error} /> : null}
      <StatGrid>
        <Stat
          icon={Receipt}
          label="Total spent"
          value={d ? m(total) : undefined}
          loading={q.isPending}
        />
        <Stat
          label="Per day"
          value={d ? m(Math.round(total / days)) : undefined}
          hint={`${days} days`}
          loading={q.isPending}
        />
        <Stat label="Entries" value={d?.rows.length} loading={q.isPending} />
        <Stat
          label="Biggest category"
          value={byCat[0]?.[0] ?? (d ? '—' : undefined)}
          hint={byCat[0] ? m(byCat[0][1]) : undefined}
          loading={q.isPending}
        />
      </StatGrid>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="By category" className="lg:col-span-1">
          {byCat.length ? (
            <RankedBars
              ariaLabel="Spend by category"
              format={m}
              rows={byCat.map(([k, v]) => ({ key: k, label: k, value: v }))}
            />
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">No expenses yet.</p>
          )}
        </Card>
        <Card className="lg:col-span-2">
          {q.isPending ? (
            <Skeleton className="h-48" />
          ) : !d?.rows.length ? (
            <EmptyNote
              icon={Receipt}
              title="No expenses in this period"
              text="Record rent, groceries, gas and other costs to see your real profit."
            />
          ) : (
            <Table
              rows={d.rows}
              rowKey={(r) => r.id}
              cols={[
                { key: 'd', header: 'Date', cell: (r) => dateOnly.format(new Date(r.spentOn)) },
                {
                  key: 'c',
                  header: 'Category',
                  cell: (r) => <span className="font-medium">{r.category}</span>,
                },
                { key: 'v', header: 'Vendor', hideOnMobile: true, cell: (r) => r.vendor ?? '—' },
                {
                  key: 'p',
                  header: 'Paid via',
                  hideOnMobile: true,
                  cell: (r) => (
                    <Badge tone={r.paidVia === 'cash' ? 'amber' : 'slate'}>{PAID[r.paidVia]}</Badge>
                  ),
                },
                { key: 'b', header: 'Branch', hideOnMobile: true, cell: (r) => r.branchName },
                { key: 'a', header: 'Amount', align: 'right', cell: (r) => m(r.amountMinor) },
                {
                  key: 'x',
                  header: '',
                  align: 'right',
                  cell: (r) =>
                    d.canManage ? (
                      <span className="inline-flex gap-1">
                        <button
                          type="button"
                          aria-label="Edit"
                          className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-white/10"
                          onClick={() => setEdit(r)}
                        >
                          <Pencil className="size-4" />
                        </button>
                        <button
                          type="button"
                          aria-label="Delete"
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
      </div>

      {edit ? (
        <ExpenseForm
          value={edit}
          branches={d?.branches ?? []}
          categories={[...new Set([...(d?.categories ?? []), ...SUGGESTED])]}
          onClose={() => setEdit(null)}
          save={(body) =>
            edit.id
              ? w.send(`/expenses/${edit.id}`, 'PATCH', body)
              : w.send('/expenses', 'POST', body)
          }
        />
      ) : null}
      <DeleteConfirmDialog
        open={del !== null}
        onClose={() => setDel(null)}
        entity="expense"
        name={del ? `${del.category} · ${m(del.amountMinor)}` : ''}
        onConfirm={() => w.send(`/expenses/${del!.id}`, 'DELETE')}
      />
    </div>
  );
}

function ExpenseForm({
  value,
  branches,
  categories,
  onClose,
  save,
}: {
  value: Partial<Expense>;
  branches: { id: string; name: string }[];
  categories: string[];
  onClose: () => void;
  save: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const [f, setF] = useState({
    branchId: value.branchId ?? '',
    category: value.category ?? '',
    amount: toRupees(value.amountMinor),
    paidVia: value.paidVia ?? 'cash',
    vendor: value.vendor ?? '',
    note: value.note ?? '',
    spentOn: value.spentOn ?? today(),
  });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  return (
    <FormDialog
      open
      onClose={onClose}
      title={value.id ? 'Edit expense' : 'Add expense'}
      onSubmit={() =>
        save({
          ...(value.id ? {} : { branchId: f.branchId }),
          category: f.category,
          amountMinor: toMinor(f.amount),
          paidVia: f.paidVia,
          vendor: f.vendor,
          note: f.note,
          spentOn: f.spentOn,
        })
      }
    >
      {!value.id && branches.length > 1 ? (
        <Field label="Branch">
          <select
            className={input}
            value={f.branchId}
            onChange={(e) => set({ branchId: e.target.value })}
          >
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Category">
          <input
            list="expense-cats"
            required
            maxLength={40}
            className={input}
            value={f.category}
            onChange={(e) => set({ category: e.target.value })}
          />
          <datalist id="expense-cats">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
        <Field label="Amount (₹)">
          <input
            type="number"
            min="0.01"
            step="0.01"
            required
            className={input}
            value={f.amount}
            onChange={(e) => set({ amount: e.target.value })}
          />
        </Field>
        <Field label="Date">
          <input
            type="date"
            required
            max={today()}
            className={input}
            value={f.spentOn}
            onChange={(e) => set({ spentOn: e.target.value })}
          />
        </Field>
        <Field
          label="Paid via"
          hint={f.paidVia === 'cash' ? 'Taken from the open register, if any.' : undefined}
        >
          <select
            className={input}
            value={f.paidVia}
            onChange={(e) => set({ paidVia: e.target.value as Expense['paidVia'] })}
          >
            {Object.entries(PAID).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Vendor (optional)">
        <input
          maxLength={120}
          className={input}
          value={f.vendor}
          onChange={(e) => set({ vendor: e.target.value })}
        />
      </Field>
      <Field label="Note (optional)">
        <input
          maxLength={300}
          className={input}
          value={f.note}
          onChange={(e) => set({ note: e.target.value })}
        />
      </Field>
    </FormDialog>
  );
}
