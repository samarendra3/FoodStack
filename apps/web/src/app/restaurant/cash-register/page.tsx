'use client';

import { ArrowDownLeft, ArrowUpRight, Banknote, Lock, LockOpen, Wallet } from 'lucide-react';
import { useState } from 'react';
import {
  BranchPicker,
  dateTime,
  Field,
  FormDialog,
  input,
  money,
  Table,
  timeOnly,
  toMinor,
  Toolbar,
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
  Stat,
  StatGrid,
} from '../_kit/report-kit';

interface Totals {
  cashSalesMinor: number;
  cardSalesMinor: number;
  upiSalesMinor: number;
  cashRefundsMinor: number;
  payInMinor: number;
  payOutMinor: number;
  cashExpensesMinor: number;
  ordersPaid: number;
}
export interface CashSession {
  id: string;
  branchId: string;
  branchName: string;
  status: 'open' | 'closed';
  openedAt: string;
  openedBy: string | null;
  closedAt: string | null;
  closedBy: string | null;
  openingFloatMinor: number;
  totals: Totals;
  expectedCashMinor: number;
  countedCashMinor: number | null;
  varianceMinor: number | null;
  note: string | null;
}
interface Current {
  branch: { id: string; name: string };
  branches: { id: string; name: string }[];
  currencyCode: string;
  canManage: boolean;
  session: CashSession | null;
}
interface Detail extends CashSession {
  movements: {
    id: string;
    type: 'pay_in' | 'pay_out';
    amountMinor: number;
    reason: string;
    createdAt: string;
    byName: string | null;
  }[];
}

export default function CashRegisterPage() {
  const [branchId, setBranchId] = useState('');
  const q = useOps<Current>(`/cash/current${branchId ? `?branchId=${branchId}` : ''}`);
  const d = q.data;
  const s = d?.session;
  const detail = useOps<Detail>(s ? `/cash/sessions/${s.id}` : null);
  const w = useOpsWrite();
  const [dialog, setDialog] = useState<null | 'open' | 'close' | 'pay_in' | 'pay_out'>(null);
  const [amount, setAmount] = useState('');
  const [text, setText] = useState('');
  const cur = d?.currencyCode ?? 'INR';
  const m = (v: number) => money(v, cur);
  const openDialog = (k: typeof dialog) => {
    setAmount(k === 'close' && s ? String(s.expectedCashMinor / 100) : '');
    setText('');
    setDialog(k);
  };

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Cash Register"
        description="Open the till with a float, record cash in and out, and see exactly how much cash should be in the drawer."
        actions={
          d?.canManage ? (
            s ? (
              <>
                <button
                  type="button"
                  className={buttonSecondary}
                  onClick={() => openDialog('pay_in')}
                >
                  <ArrowDownLeft className="size-4" /> Cash in
                </button>
                <button
                  type="button"
                  className={buttonSecondary}
                  onClick={() => openDialog('pay_out')}
                >
                  <ArrowUpRight className="size-4" /> Cash out
                </button>
                <button type="button" className={buttonPrimary} onClick={() => openDialog('close')}>
                  <Lock className="size-4" /> Close register
                </button>
              </>
            ) : (
              <button type="button" className={buttonPrimary} onClick={() => openDialog('open')}>
                <LockOpen className="size-4" /> Open register
              </button>
            )
          ) : null
        }
      />
      <Toolbar>
        <BranchPicker
          branches={d?.branches ?? []}
          value={d?.branch.id ?? ''}
          onChange={setBranchId}
        />
      </Toolbar>
      {q.isError ? <ErrorNote error={q.error} /> : null}
      {q.isPending ? (
        <Skeleton className="h-40" />
      ) : !s ? (
        <Card>
          <EmptyNote
            icon={Wallet}
            title={`Register closed at ${d?.branch.name ?? 'this branch'}`}
            text="Open the register at the start of the shift with the cash float in the drawer. Cash sales, refunds and expenses are then tracked automatically."
          />
        </Card>
      ) : (
        <>
          <StatGrid>
            <Stat
              icon={Banknote}
              label="Expected in drawer"
              value={m(s.expectedCashMinor)}
              hint="Float + cash sales − refunds ± movements − cash expenses"
            />
            <Stat
              label="Opening float"
              value={m(s.openingFloatMinor)}
              hint={`Opened ${timeOnly.format(new Date(s.openedAt))}${s.openedBy ? ` by ${s.openedBy}` : ''}`}
            />
            <Stat
              label="Cash sales"
              value={m(s.totals.cashSalesMinor)}
              hint={`${s.totals.ordersPaid} bills paid this shift`}
            />
            <Stat
              label="Card + UPI"
              value={m(s.totals.cardSalesMinor + s.totals.upiSalesMinor)}
              hint="Not in the drawer"
            />
          </StatGrid>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="How the expected cash adds up">
              <ul className="divide-y divide-slate-100 text-sm dark:divide-white/5">
                {(
                  [
                    ['Opening float', s.openingFloatMinor, ''],
                    ['Cash sales', s.totals.cashSalesMinor, '+'],
                    ['Cash refunds', s.totals.cashRefundsMinor, '−'],
                    ['Cash in', s.totals.payInMinor, '+'],
                    ['Cash out', s.totals.payOutMinor, '−'],
                    ['Expenses paid from the till', s.totals.cashExpensesMinor, '−'],
                  ] as const
                ).map(([l, v, sign]) => (
                  <li key={l} className="flex justify-between py-2">
                    <span className="text-muted-foreground">
                      {sign ? `${sign} ` : ''}
                      {l}
                    </span>
                    <span className="tabular-nums">{m(v)}</span>
                  </li>
                ))}
                <li className="flex justify-between py-2 font-semibold">
                  <span>Expected cash</span>
                  <span className="tabular-nums">{m(s.expectedCashMinor)}</span>
                </li>
              </ul>
            </Card>
            <Card title="Cash in and out this shift">
              {detail.data && detail.data.movements.length > 0 ? (
                <Table
                  rows={detail.data.movements}
                  rowKey={(r) => r.id}
                  cols={[
                    {
                      key: 't',
                      header: 'Time',
                      cell: (r) => timeOnly.format(new Date(r.createdAt)),
                    },
                    { key: 'r', header: 'Reason', cell: (r) => r.reason },
                    { key: 'b', header: 'By', hideOnMobile: true, cell: (r) => r.byName ?? '—' },
                    {
                      key: 'a',
                      header: 'Amount',
                      align: 'right',
                      cell: (r) => (
                        <span className={r.type === 'pay_in' ? 'text-emerald-700' : 'text-red-600'}>
                          {r.type === 'pay_in' ? '+' : '−'}
                          {m(r.amountMinor)}
                        </span>
                      ),
                    },
                  ]}
                />
              ) : (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No cash in or out yet.
                </p>
              )}
            </Card>
          </div>
        </>
      )}

      <FormDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={
          {
            open: 'Open register',
            close: 'Close register',
            pay_in: 'Cash in',
            pay_out: 'Cash out',
            '': '',
          }[dialog ?? '']
        }
        description={
          dialog === 'close' && s
            ? `Count the cash in the drawer. Expected: ${m(s.expectedCashMinor)}. The difference is saved on the shift report.`
            : dialog === 'open'
              ? 'Count the float (change) in the drawer before the first sale.'
              : undefined
        }
        submitLabel={
          {
            open: 'Open register',
            close: 'Close register',
            pay_in: 'Add cash',
            pay_out: 'Take cash out',
            '': '',
          }[dialog ?? '']
        }
        onSubmit={async () => {
          if (dialog === 'open')
            await w.send('/cash/open', 'POST', {
              branchId: d!.branch.id,
              openingFloatMinor: toMinor(amount),
              note: text,
            });
          else if (dialog === 'close')
            await w.send(`/cash/sessions/${s!.id}/close`, 'POST', {
              countedCashMinor: toMinor(amount),
              note: text,
            });
          else
            await w.send(`/cash/sessions/${s!.id}/movements`, 'POST', {
              type: dialog,
              amountMinor: toMinor(amount),
              reason: text,
            });
        }}
      >
        <Field
          label={
            dialog === 'close'
              ? 'Cash counted (₹)'
              : dialog === 'open'
                ? 'Opening float (₹)'
                : 'Amount (₹)'
          }
        >
          <input
            type="number"
            min="0"
            step="0.01"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={input}
          />
        </Field>
        {dialog === 'close' && s && amount !== '' ? (
          <p className="text-sm">
            Difference:{' '}
            <strong
              className={
                toMinor(amount) - s.expectedCashMinor === 0 ? 'text-emerald-700' : 'text-red-600'
              }
            >
              {toMinor(amount) - s.expectedCashMinor > 0 ? '+' : ''}
              {m(toMinor(amount) - s.expectedCashMinor)}
            </strong>
          </p>
        ) : null}
        <Field label={dialog === 'pay_in' || dialog === 'pay_out' ? 'Reason' : 'Note (optional)'}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            required={dialog === 'pay_in' || dialog === 'pay_out'}
            minLength={dialog === 'pay_in' || dialog === 'pay_out' ? 2 : undefined}
            placeholder={
              dialog === 'pay_out'
                ? 'e.g. Milk delivery'
                : dialog === 'pay_in'
                  ? 'e.g. Extra change from bank'
                  : ''
            }
            className={input}
          />
        </Field>
      </FormDialog>
      {s ? (
        <p className="text-xs text-muted-foreground">
          Shift started {dateTime.format(new Date(s.openedAt))}. Figures update as payments come in.
        </p>
      ) : null}
    </div>
  );
}
