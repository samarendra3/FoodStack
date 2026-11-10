'use client';

import { Landmark } from 'lucide-react';
import { useState } from 'react';
import { type Filters, inr, type Summary, useAnalytics } from '@/lib/analytics';
import { downloadCsv } from '@/lib/csv';
import { Field, FormDialog, input, useOps, useOpsWrite } from '../_kit/ops-kit';
import {
  buttonPrimary,
  Card,
  CsvButton,
  ErrorNote,
  PageHeader,
  ReportFilters,
  Stat,
  StatGrid,
} from '../_kit/report-kit';

interface Tax {
  restaurant: { id: string; name: string };
  taxRateBp: number;
  gstin: string | null;
  currencyCode: string;
  countryCode: string;
  canManage: boolean;
}
const RATES = [0, 500, 1200, 1800];

export default function TaxPage() {
  const q = useOps<Tax>('/tax');
  const w = useOpsWrite();
  const [filters, setFilters] = useState<Filters>({ preset: 'thisMonth' });
  const summary = useAnalytics<Summary>('summary', filters);
  const [editing, setEditing] = useState(false);
  const [rate, setRate] = useState('');
  const t = q.data;
  const s = summary.data;
  const m = (v: number) => inr(v, t?.currencyCode ?? 'INR');
  const tax = s?.revenue.tax.value ?? 0;
  // Intra-state GST splits evenly into CGST and SGST.
  const half = Math.round(tax / 2);

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Tax Management"
        description="The GST rate charged on bills and the tax you have collected, ready for your GST return."
        actions={
          t?.canManage ? (
            <button
              type="button"
              className={buttonPrimary}
              onClick={() => {
                setRate(String(t.taxRateBp / 100));
                setEditing(true);
              }}
            >
              Change GST rate
            </button>
          ) : null
        }
      />
      {q.isError ? <ErrorNote error={q.error} /> : null}
      <StatGrid>
        <Stat
          icon={Landmark}
          label="GST rate on bills"
          value={t ? `${t.taxRateBp / 100}%` : undefined}
          hint="Applies to new orders"
          loading={q.isPending}
        />
        <Stat
          label="GSTIN"
          value={t ? (t.gstin ?? 'Not set') : undefined}
          hint="Edit in Restaurant Settings"
          loading={q.isPending}
        />
        <Stat
          label="Taxable sales"
          value={s ? m(s.revenue.netSales.value) : undefined}
          loading={summary.isPending}
        />
        <Stat
          label="GST collected"
          value={s ? m(tax) : undefined}
          cmp={s?.revenue.tax}
          format={m}
          loading={summary.isPending}
        />
      </StatGrid>

      <Card
        title="GST summary"
        subtitle="Intra-state supply: GST is split equally into CGST and SGST"
        aside={
          <CsvButton
            disabled={!s}
            onClick={() =>
              downloadCsv(`gst-${s!.range.from}-to-${s!.range.to}.csv`, [
                ['Period', 'Taxable value', 'Rate %', 'CGST', 'SGST', 'Total GST', 'Invoice value'],
                [
                  `${s!.range.from} to ${s!.range.to}`,
                  (s!.revenue.netSales.value / 100).toFixed(2),
                  t ? t.taxRateBp / 100 : '',
                  (half / 100).toFixed(2),
                  ((tax - half) / 100).toFixed(2),
                  (tax / 100).toFixed(2),
                  (s!.revenue.billedTotal.value / 100).toFixed(2),
                ],
              ])
            }
          />
        }
      >
        <div className="mb-4">
          <ReportFilters filters={filters} onChange={setFilters} meta={s} showChannel={false} />
        </div>
        {summary.isError ? <ErrorNote error={summary.error} /> : null}
        <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {(
            [
              ['Taxable value', s?.revenue.netSales.value],
              ['CGST', s ? half : undefined],
              ['SGST', s ? tax - half : undefined],
              ['Total GST', s ? tax : undefined],
              ['Invoice value', s?.revenue.billedTotal.value],
              ['Bills', s?.kpis.completedOrders.value],
            ] as const
          ).map(([l, v], i) => (
            <div key={l} className="rounded-lg border border-slate-200 p-3 dark:border-white/10">
              <dt className="text-xs text-muted-foreground">{l}</dt>
              <dd className="mt-1 font-semibold tabular-nums">
                {v === undefined ? '—' : i === 5 ? v : m(v)}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-xs text-muted-foreground">
          Bills keep the rate they were created with, so changing the rate never alters past bills.
          For inter-state supply file the total as IGST.
        </p>
      </Card>

      <FormDialog
        open={editing}
        onClose={() => setEditing(false)}
        title="Change GST rate"
        description="The new rate applies to orders placed from now on. Existing and paid bills keep their rate."
        onSubmit={() =>
          w.send('/tax', 'PATCH', {
            restaurantId: t!.restaurant.id,
            taxRateBp: Math.round(Number(rate) * 100),
          })
        }
      >
        <div className="flex flex-wrap gap-2">
          {RATES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRate(String(r / 100))}
              className={`h-8 rounded-md px-3 text-sm font-medium ring-1 ring-inset ${Number(rate) * 100 === r ? 'bg-emerald-600 text-white ring-emerald-600' : 'ring-slate-200 dark:ring-white/10'}`}
            >
              {r / 100}%
            </button>
          ))}
        </div>
        <Field label="Rate (%)" hint="Restaurants (non-AC, no ITC) usually charge 5%.">
          <input
            type="number"
            min="0"
            max="50"
            step="0.01"
            required
            className={input}
            value={rate}
            onChange={(e) => setRate(e.target.value)}
          />
        </Field>
      </FormDialog>
    </div>
  );
}
