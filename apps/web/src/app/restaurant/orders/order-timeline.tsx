'use client';

import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/components/auth/auth-provider';
import { CHANNEL_LABEL } from './order-labels';

interface TimelineEntry {
  id: string;
  type: string;
  at: string;
  actor: { kind: 'staff' | 'guest' | 'system'; name: string };
  details: Record<string, unknown>;
}

const KITCHEN: Record<string, string> = {
  new: 'New',
  accepted: 'Accepted',
  preparing: 'Preparing',
  ready: 'Ready',
  served: 'Served',
};
const METHOD: Record<string, string> = { cash: 'Cash', card: 'Card', upi: 'UPI', online: 'Online' };
const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function describe(e: TimelineEntry, fmt: (m: number) => string): string {
  const d = e.details;
  switch (e.type) {
    case 'order.created':
      return `Order #${String(d.orderNumber ?? '')} placed (${CHANNEL_LABEL[String(d.channel)] ?? String(d.channel)}${
        d.tableLabel ? `, table ${String(d.tableLabel)}` : ''
      }) · ${String(d.itemCount ?? '')} item(s) · ${fmt(Number(d.totalMinor ?? 0))}`;
    case 'order.status':
    case 'order.ready':
    case 'order.served':
      return `Kitchen: ${KITCHEN[String(d.from)] ?? String(d.from)} → ${KITCHEN[String(d.to)] ?? String(d.to)}`;
    case 'order.item_status':
      return `${String(d.name ?? 'Dish')}: ${String(d.to) === 'ready' ? 'ready' : 'started'}`;
    case 'order.cancelled':
      return `Order cancelled: ${String(d.reason ?? '')}`;
    case 'order.item_voided':
      return `Item voided: ${String(d.reason ?? '')}`;
    case 'payment.recorded':
      return `${METHOD[String(d.method)] ?? String(d.method)} payment ${fmt(Number(d.amountMinor ?? 0))}${
        d.paidInFull ? ' · bill settled' : ''
      }`;
    case 'payment.failed':
      return `Online payment not applied: ${String(d.reason ?? '')}${d.needsReview ? ' (needs review)' : ''}`;
    case 'invoice.generated':
      return `Invoice ${String(d.invoiceNumber ?? '')} issued`;
    case 'payment.refunded':
      return `Refund ${fmt(Number(d.amountMinor ?? 0))}: ${String(d.reason ?? '')}`;
    default:
      return e.type;
  }
}

/** Who did what to this order, and when (from the order event log). */
export function OrderTimeline({ orderId, fmt }: { orderId: string; fmt: (m: number) => string }) {
  const { client } = useAuth();
  const q = useQuery({
    queryKey: ['order', orderId, 'timeline'],
    queryFn: () => client.request<TimelineEntry[]>(`/orders/${orderId}/timeline`),
  });
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">Timeline</h3>
      {q.isPending ? (
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      ) : q.isError ? (
        <p className="text-sm text-muted-foreground">Timeline unavailable.</p>
      ) : q.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No recorded events (orders placed before the timeline was enabled).
        </p>
      ) : (
        <ol className="relative space-y-3 border-l pl-4">
          {q.data.map((e) => (
            <li key={e.id} className="relative">
              <span className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full bg-emerald-500" />
              <p className="text-sm">{describe(e, fmt)}</p>
              <p className="text-xs text-muted-foreground">
                {day.format(new Date(e.at))} {time.format(new Date(e.at))} · {e.actor.name}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
