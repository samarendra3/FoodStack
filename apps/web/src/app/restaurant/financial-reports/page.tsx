'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { Banknote, Landmark, Scale, Undo2, Wallet } from 'lucide-react';
import { useState } from 'react';
import { type Filters, inr, METHOD_LABEL, type Summary, useAnalytics } from '@/lib/analytics';
import { downloadCsv } from '@/lib/csv';
import {
  Card,
  CsvButton,
  Delta,
  ErrorNote,
  PageHeader,
  ReportFilters,
  Skeleton,
  Stat,
  StatGrid,
} from '../_kit/report-kit';

/** Profit-and-loss style statement of the sales side, from the analytics summary. */
const STATEMENT: {
  key: keyof Summary['revenue'];
  label: string;
  sign?: '-' | '=';
  invert?: boolean;
}[] = [
  { key: 'grossSales', label: 'Gross sales' },
  { key: 'discounts', label: 'Discounts', sign: '-', invert: true },
  { key: 'netSales', label: 'Net sales', sign: '=' },
  { key: 'tax', label: 'Tax collected (GST)' },
  { key: 'billedTotal', label: 'Total billed', sign: '=' },
  { key: 'collected', label: 'Payments collected' },
  { key: 'refunds', label: 'Refunds', sign: '-', invert: true },
  { key: 'netCollected', label: 'Net collected', sign: '=' },
];

export default function FinancialReportsPage() {
  const [filters, setFilters] = useState<Filters>({ preset: 'thisMonth' });
  const summary = useAnalytics<Summary>('summary', filters);
  const s = summary.data;
  const money = (v: number) => inr(v, s?.currencyCode ?? 'INR');
  const outstanding = s
    ? Math.max(0, s.revenue.billedTotal.value - s.revenue.collected.value)
    : null;

  const exportCsv = () => {
    if (!s) return;
    downloadCsv(`financial-${s.range.from}-to-${s.range.to}.csv`, [
      ['Line', 'This period', 'Previous period', 'Change %'],
      ...STATEMENT.map((l) => [
        l.label,
        (s.revenue[l.key].value / 100).toFixed(2),
        (s.revenue[l.key].previous / 100).toFixed(2),
        s.revenue[l.key].changePct ?? '',
      ]),
      [],
      ['Payment method', 'Collected', 'Refunds', 'Net'],
      ...s.byMethod.map((m) => [
        METHOD_LABEL[m.method] ?? m.method,
        (m.collectedMinor / 100).toFixed(2),
        (m.refundsMinor / 100).toFixed(2),
        (m.netMinor / 100).toFixed(2),
      ]),
    ]);
  };

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Financial Reports"
        description="Sales statement, tax collected and money received, for your accountant."
        actions={<CsvButton onClick={exportCsv} disabled={!s} />}
      />
      <ReportFilters filters={filters} onChange={setFilters} meta={s} showChannel={false} />
      {summary.isError ? <ErrorNote error={summary.error} /> : null}

      <StatGrid>
        <Stat
          icon={Scale}
          label="Net sales"
          value={s ? money(s.revenue.netSales.value) : undefined}
          cmp={s?.revenue.netSales}
          format={money}
          loading={summary.isPending}
        />
        <Stat
          icon={Landmark}
          label="Tax collected"
          value={s ? money(s.revenue.tax.value) : undefined}
          cmp={s?.revenue.tax}
          format={money}
          loading={summary.isPending}
        />
        <Stat
          icon={Undo2}
          label="Refunds"
          value={s ? money(s.revenue.refunds.value) : undefined}
          cmp={s?.revenue.refunds}
          format={money}
          invert
          loading={summary.isPending}
        />
        <Stat
          icon={Wallet}
          label="Unpaid on bills"
          value={outstanding === null ? undefined : money(outstanding)}
          hint="Billed but not yet collected"
          loading={summary.isPending}
        />
      </StatGrid>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card
          icon={Scale}
          title="Sales statement"
          subtitle="This period against the previous one"
          className="lg:col-span-3"
        >
          {s ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-muted-foreground uppercase dark:border-white/10">
                  <th className="py-2 font-medium">Line</th>
                  <th className="py-2 text-right font-medium">Amount</th>
                  <th className="hidden py-2 text-right font-medium sm:table-cell">Previous</th>
                  <th className="py-2 pl-3 text-right font-medium">Change</th>
                </tr>
              </thead>
              <tbody>
                {STATEMENT.map((l) => (
                  <tr
                    key={l.key}
                    className={cn(
                      'border-b border-slate-100 last:border-0 dark:border-white/5',
                      l.sign === '=' && 'bg-slate-50 font-semibold dark:bg-white/5',
                    )}
                  >
                    <td className="py-2.5 pl-2">
                      {l.sign === '-' ? (
                        <span className="mr-1 text-muted-foreground">−</span>
                      ) : null}
                      {l.label}
                    </td>
                    <td className="py-2.5 text-right tabular-nums">
                      {money(s.revenue[l.key].value)}
                    </td>
                    <td className="hidden py-2.5 text-right text-muted-foreground tabular-nums sm:table-cell">
                      {money(s.revenue[l.key].previous)}
                    </td>
                    <td className="py-2.5 pr-2 pl-3 text-right">
                      <Delta pct={s.revenue[l.key].changePct} invert={l.invert} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Skeleton className="h-72" />
          )}
        </Card>

        <Card
          icon={Banknote}
          title="Settlement by method"
          subtitle="What should be in the till and the bank"
          className="lg:col-span-2"
        >
          {s ? (
            s.byMethod.length > 0 ? (
              <ul className="divide-y divide-slate-100 dark:divide-white/5">
                {s.byMethod.map((m) => (
                  <li key={m.method} className="flex items-center justify-between gap-3 py-3">
                    <div>
                      <p className="font-medium">{METHOD_LABEL[m.method] ?? m.method}</p>
                      <p className="text-xs text-muted-foreground">
                        {money(m.collectedMinor)} in
                        {m.refundsMinor ? ` · ${money(m.refundsMinor)} refunded` : ''}
                      </p>
                    </div>
                    <span className="font-semibold tabular-nums">{money(m.netMinor)}</span>
                  </li>
                ))}
                <li className="flex items-center justify-between gap-3 pt-3 font-semibold">
                  <span>Total</span>
                  <span className="tabular-nums">{money(s.revenue.netCollected.value)}</span>
                </li>
              </ul>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No payments in this period.
              </p>
            )
          ) : (
            <Skeleton className="h-48" />
          )}
        </Card>
      </div>
    </div>
  );
}
