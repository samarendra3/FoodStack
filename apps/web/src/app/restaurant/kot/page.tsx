'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { Printer, ScrollText, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  type KitchenTicket,
  NEXT_STATUS,
  type TicketStatus,
  useKitchenFeed,
} from '@/app/kitchen/kitchen-feed';
import { STATUS_BADGE, STATUS_LABEL } from '@/app/kitchen/kitchen-frame';
import { useRestaurantOverview } from '../overview';
import {
  Card,
  control,
  EmptyNote,
  ErrorNote,
  PageHeader,
  Skeleton,
  Stat,
  StatGrid,
} from '../_kit/report-kit';

/*
 * Kitchen Order Tickets: every ticket sent to the kitchen for a branch (open, plus served in the
 * last 12 hours), with reprint and status control for managers away from the kitchen screen.
 */

const TYPE_LABEL = { 'dine-in': 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' } as const;
const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

export default function KotPage() {
  const overview = useRestaurantOverview();
  const branches = overview.data?.branches ?? [];
  const [picked, setPicked] = useState('');
  const branchId = picked || branches[0]?.id || '';
  const feed = useKitchenFeed(branchId);
  const [status, setStatus] = useState<'' | TicketStatus>('');
  const [q, setQ] = useState('');

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return feed.tickets
      .filter((t) => !status || t.status === status)
      .filter(
        (t) =>
          !s ||
          t.orderNumber.toLowerCase().includes(s) ||
          t.tableLabel?.toLowerCase().includes(s) ||
          t.items.some((i) => i.name.toLowerCase().includes(s)),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [feed.tickets, status, q]);

  const n = (s: TicketStatus) => feed.tickets.filter((t) => t.status === s).length;

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="KOT / Kitchen Tickets"
        description="Every ticket sent to the kitchen. Reprint a KOT or move it along. Refreshes every 5 seconds."
      />

      <StatGrid>
        <Stat
          label="New"
          value={feed.isLoading ? undefined : n('new')}
          hint="Waiting for the kitchen"
          loading={feed.isLoading}
        />
        <Stat
          label="In preparation"
          value={feed.isLoading ? undefined : n('accepted') + n('preparing')}
          hint="Accepted or cooking"
          loading={feed.isLoading}
        />
        <Stat
          label="Ready to serve"
          value={feed.isLoading ? undefined : n('ready')}
          hint="Waiting for pickup"
          loading={feed.isLoading}
        />
        <Stat
          label="Served (12 h)"
          value={feed.isLoading ? undefined : n('completed')}
          hint="Completed tickets"
          loading={feed.isLoading}
        />
      </StatGrid>

      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
        {branches.length > 1 ? (
          <select
            aria-label="Branch"
            className={control}
            value={branchId}
            onChange={(e) => setPicked(e.target.value)}
          >
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        ) : null}
        <select
          aria-label="Status"
          className={control}
          value={status}
          onChange={(e) => setStatus(e.target.value as '' | TicketStatus)}
        >
          <option value="">All statuses</option>
          {(Object.keys(STATUS_LABEL) as TicketStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <label className="relative col-span-2 sm:w-72">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
          <span className="sr-only">Search tickets</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Order, table or dish"
            className={cn(control, 'w-full pl-9')}
          />
        </label>
      </div>

      {feed.error ? <ErrorNote error={new Error(feed.error)} /> : null}
      {overview.isPending || feed.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-48" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyNote
            icon={ScrollText}
            title="No kitchen tickets"
            text="Tickets appear here as soon as an order is sent to the kitchen from the POS or waiter app."
          />
        </Card>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((t) => (
            <TicketCard key={t.id} ticket={t} advance={feed.advance} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TicketCard({
  ticket: t,
  advance,
}: {
  ticket: KitchenTicket;
  advance?: (id: string, to: TicketStatus) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = NEXT_STATUS[t.status];
  const qty = t.items.reduce((a, i) => a + i.qty, 0);

  const move = async () => {
    if (!next || !advance) return;
    setBusy(true);
    setError(null);
    try {
      await advance(t.id, next.to);
    } catch {
      setError('Could not update the ticket. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-col rounded-xl border border-slate-200 bg-white shadow-xs dark:border-white/10 dark:bg-slate-900">
      <div className="flex items-start justify-between gap-3 border-b border-dashed border-slate-200 p-4 dark:border-white/10">
        <div className="min-w-0">
          <p className="text-lg font-semibold tabular-nums">KOT #{t.orderNumber}</p>
          <p className="truncate text-sm text-muted-foreground">
            {TYPE_LABEL[t.orderType]}
            {t.tableLabel ? ` · Table ${t.tableLabel}` : ''}
            {t.billLabel ? ` · ${t.billLabel}` : ''}
            {t.customerName ? ` · ${t.customerName}` : ''}
          </p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
            STATUS_BADGE[t.status],
          )}
        >
          {STATUS_LABEL[t.status]}
        </span>
      </div>
      <ul className="flex-1 space-y-1.5 p-4 text-sm">
        {t.items.map((i) => (
          <li key={i.id}>
            <span className="font-semibold tabular-nums">{i.qty} ×</span> {i.name}
            {i.note ? (
              <p className="pl-6 text-xs text-amber-700 dark:text-amber-300">{i.note}</p>
            ) : null}
          </li>
        ))}
        {t.note ? (
          <li className="rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            Note: {t.note}
          </li>
        ) : null}
      </ul>
      {error ? <p className="px-4 pb-2 text-sm text-red-600">{error}</p> : null}
      <div className="flex items-center justify-between gap-2 border-t border-slate-200 p-3 dark:border-white/10">
        <span className="text-xs text-muted-foreground">
          {time.format(new Date(t.createdAt))} · {qty} item{qty === 1 ? '' : 's'}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => printKot(t)}
            className={cn(control, 'inline-flex items-center gap-1.5 px-2.5')}
            aria-label={`Print KOT ${t.orderNumber}`}
          >
            <Printer className="size-4" />
            <span className="hidden sm:inline">Print</span>
          </button>
          {next && advance ? (
            <button
              type="button"
              disabled={busy}
              onClick={move}
              className="h-9 rounded-md bg-emerald-600 px-3 text-sm font-medium whitespace-nowrap text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              {busy ? 'Saving…' : next.label}
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** Prints one ticket on an 80 mm kitchen printer layout. */
function printKot(t: KitchenTicket) {
  const w = window.open('', '_blank', 'width=360,height=600');
  if (!w) return;
  const items = t.items
    .map(
      (i) =>
        `<tr><td class="q">${i.qty}</td><td>${esc(i.name)}${i.note ? `<div class="n">${esc(i.note)}</div>` : ''}</td></tr>`,
    )
    .join('');
  w.document
    .write(`<!doctype html><html><head><meta charset="utf-8"><title>KOT ${esc(t.orderNumber)}</title>
<style>
  @page { size: 80mm auto; margin: 4mm; }
  body { font: 13px/1.35 ui-monospace, Menlo, Consolas, monospace; margin: 0; color: #000; }
  h1 { font-size: 18px; margin: 0 0 4px; text-align: center; }
  .m { text-align: center; margin-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; border-top: 1px dashed #000; border-bottom: 1px dashed #000; }
  td { padding: 4px 0; vertical-align: top; }
  .q { width: 2.5em; font-weight: 700; }
  .n { font-size: 11px; font-style: italic; }
  .f { margin-top: 8px; font-size: 11px; text-align: center; }
</style></head><body>
<h1>KOT #${esc(t.orderNumber)}</h1>
<div class="m">${esc(TYPE_LABEL[t.orderType])}${t.tableLabel ? ` · Table ${esc(t.tableLabel)}` : ''}${t.billLabel ? ` · ${esc(t.billLabel)}` : ''}</div>
<table>${items}</table>
${t.note ? `<p><b>Note:</b> ${esc(t.note)}</p>` : ''}
<div class="f">${new Date(t.createdAt).toLocaleString()} · reprint</div>
<script>window.onload = () => { window.print(); setTimeout(() => window.close(), 300); };</script>
</body></html>`);
  w.document.close();
}
