'use client';

import { Printer, Wallet } from 'lucide-react';
import { useState } from 'react';
import { downloadCsv } from '@/lib/csv';
import type { CashSession } from '../cash-register/page';
import {
  Badge,
  BranchPicker,
  dateTime,
  daysAgo,
  FormDialog,
  input,
  money,
  Table,
  today,
  Toolbar,
  useOps,
} from '../_kit/ops-kit';
import {
  Card,
  CsvButton,
  EmptyNote,
  ErrorNote,
  PageHeader,
  Skeleton,
  Stat,
  StatGrid,
} from '../_kit/report-kit';

interface Sessions {
  currencyCode: string;
  branches: { id: string; name: string }[];
  rows: CashSession[];
}

export default function ShiftClosingPage() {
  const [branchId, setBranchId] = useState('');
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(today());
  const qs = new URLSearchParams({ from, to, ...(branchId ? { branchId } : {}) });
  const q = useOps<Sessions>(`/cash/sessions?${qs}`);
  const [open, setOpen] = useState<CashSession | null>(null);
  const d = q.data;
  const cur = d?.currencyCode ?? 'INR';
  const m = (v: number) => money(v, cur);
  const closed = d?.rows.filter((r) => r.status === 'closed') ?? [];
  const short = closed.filter((r) => (r.varianceMinor ?? 0) < 0);
  const net = closed.reduce((t, r) => t + (r.varianceMinor ?? 0), 0);

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Shift Closing"
        description="End-of-shift reports (Z-reports): what each register took, what was counted and any difference."
        actions={
          <CsvButton
            disabled={!closed.length}
            onClick={() =>
              downloadCsv(`shift-closing-${from}-to-${to}.csv`, [
                [
                  'Branch',
                  'Opened',
                  'Closed',
                  'Float',
                  'Cash sales',
                  'Card',
                  'UPI',
                  'Refunds',
                  'Cash in',
                  'Cash out',
                  'Expenses',
                  'Expected',
                  'Counted',
                  'Difference',
                ],
                ...closed.map((r) => [
                  r.branchName,
                  r.openedAt,
                  r.closedAt ?? '',
                  ...[
                    r.openingFloatMinor,
                    r.totals.cashSalesMinor,
                    r.totals.cardSalesMinor,
                    r.totals.upiSalesMinor,
                    r.totals.cashRefundsMinor,
                    r.totals.payInMinor,
                    r.totals.payOutMinor,
                    r.totals.cashExpensesMinor,
                    r.expectedCashMinor,
                    r.countedCashMinor ?? 0,
                    r.varianceMinor ?? 0,
                  ].map((v) => (v / 100).toFixed(2)),
                ]),
              ])
            }
          />
        }
      />
      <Toolbar>
        <BranchPicker
          branches={d?.branches ?? []}
          value={branchId}
          onChange={setBranchId}
          allLabel="All branches"
        />
        <input
          type="date"
          aria-label="From"
          className={input}
          value={from}
          max={to}
          onChange={(e) => setFrom(e.target.value)}
        />
        <input
          type="date"
          aria-label="To"
          className={input}
          value={to}
          min={from}
          onChange={(e) => setTo(e.target.value)}
        />
      </Toolbar>
      {q.isError ? <ErrorNote error={q.error} /> : null}
      <StatGrid>
        <Stat label="Shifts closed" value={d ? closed.length : undefined} loading={q.isPending} />
        <Stat
          label="Cash taken"
          value={d ? m(closed.reduce((t, r) => t + r.totals.cashSalesMinor, 0)) : undefined}
          loading={q.isPending}
        />
        <Stat
          label="Shifts with a shortage"
          value={d ? short.length : undefined}
          loading={q.isPending}
        />
        <Stat
          label="Net difference"
          value={d ? `${net > 0 ? '+' : ''}${m(net)}` : undefined}
          hint="Counted − expected, all shifts"
          loading={q.isPending}
        />
      </StatGrid>
      <Card>
        {q.isPending ? (
          <Skeleton className="h-48" />
        ) : !d?.rows.length ? (
          <EmptyNote
            icon={Wallet}
            title="No shifts in this period"
            text="Shifts appear here once the register is opened on the Cash Register screen."
          />
        ) : (
          <Table
            rows={d.rows}
            rowKey={(r) => r.id}
            onRow={setOpen}
            cols={[
              { key: 'o', header: 'Opened', cell: (r) => dateTime.format(new Date(r.openedAt)) },
              { key: 'b', header: 'Branch', hideOnMobile: true, cell: (r) => r.branchName },
              {
                key: 's',
                header: 'Status',
                cell: (r) =>
                  r.status === 'open' ? <Badge tone="sky">Open</Badge> : <Badge>Closed</Badge>,
              },
              {
                key: 'c',
                header: 'Cash sales',
                align: 'right',
                hideOnMobile: true,
                cell: (r) => m(r.totals.cashSalesMinor),
              },
              { key: 'e', header: 'Expected', align: 'right', cell: (r) => m(r.expectedCashMinor) },
              {
                key: 'n',
                header: 'Counted',
                align: 'right',
                hideOnMobile: true,
                cell: (r) => (r.countedCashMinor === null ? '—' : m(r.countedCashMinor)),
              },
              {
                key: 'v',
                header: 'Difference',
                align: 'right',
                cell: (r) =>
                  r.varianceMinor === null ? (
                    '—'
                  ) : (
                    <Badge
                      tone={
                        r.varianceMinor === 0 ? 'emerald' : r.varianceMinor < 0 ? 'red' : 'amber'
                      }
                    >{`${r.varianceMinor > 0 ? '+' : ''}${m(r.varianceMinor)}`}</Badge>
                  ),
              },
            ]}
          />
        )}
      </Card>
      <FormDialog
        open={open !== null}
        onClose={() => setOpen(null)}
        title="Shift report"
        submitLabel="Print"
        onSubmit={async () => window.print()}
        size="md"
      >
        {open ? (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              {open.branchName} · {dateTime.format(new Date(open.openedAt))} →{' '}
              {open.closedAt ? dateTime.format(new Date(open.closedAt)) : 'still open'}
              {open.closedBy ? ` · closed by ${open.closedBy}` : ''}
            </p>
            <ul className="divide-y divide-slate-100 dark:divide-white/5">
              {(
                [
                  ['Opening float', open.openingFloatMinor],
                  ['Cash sales', open.totals.cashSalesMinor],
                  ['Card sales', open.totals.cardSalesMinor],
                  ['UPI sales', open.totals.upiSalesMinor],
                  ['Cash refunds', -open.totals.cashRefundsMinor],
                  ['Cash in', open.totals.payInMinor],
                  ['Cash out', -open.totals.payOutMinor],
                  ['Expenses from the till', -open.totals.cashExpensesMinor],
                  ['Expected cash', open.expectedCashMinor],
                  ['Counted cash', open.countedCashMinor ?? 0],
                  ['Difference', open.varianceMinor ?? 0],
                ] as const
              ).map(([l, v]) => (
                <li key={l} className="flex justify-between py-1.5">
                  <span>{l}</span>
                  <span className="tabular-nums">{m(v)}</span>
                </li>
              ))}
            </ul>
            {open.note ? <p className="text-muted-foreground">Note: {open.note}</p> : null}
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Printer className="size-3.5" /> Print uses the browser print dialog.
            </p>
          </div>
        ) : null}
      </FormDialog>
    </div>
  );
}
