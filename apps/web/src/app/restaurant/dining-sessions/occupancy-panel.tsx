'use client';

import { Armchair } from 'lucide-react';
import { Badge, money, Table, useOps } from '../_kit/ops-kit';
import { Card, EmptyNote, ErrorNote, Skeleton } from '../_kit/report-kit';

interface Group {
  guestId: string;
  sessionId: string;
  name: string;
  number: number;
  seats: number;
  totalMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  paymentStatus: 'no_orders' | 'unpaid' | 'partial' | 'pending' | 'paid';
  canRelease: boolean;
}
interface TableOccupancy {
  id: string;
  label: string;
  area: string;
  capacity: number;
  occupied: number;
  available: number;
  status: 'available' | 'partial' | 'full';
  sessionId: string | null;
  groups: Group[];
}

const STATUS_TONE = { available: 'emerald', partial: 'amber', full: 'violet' } as const;
const STATUS_LABEL = { available: 'Available', partial: 'Partly seated', full: 'Full' } as const;
const PAY_LABEL: Record<Group['paymentStatus'], string> = {
  no_orders: 'No orders',
  unpaid: 'Unpaid',
  partial: 'Partly paid',
  pending: 'Payment pending',
  paid: 'Paid',
};

/** Seats per table: capacity, occupied, available, and each group's seats and payment state. */
export function OccupancyPanel({ branchId }: { branchId: string }) {
  const q = useOps<TableOccupancy[]>(`/table-sessions/occupancy?branchId=${branchId}`);
  const rows = q.data ?? [];
  return (
    <Card>
      {q.isError ? <ErrorNote error={q.error} /> : null}
      {q.isPending ? (
        <Skeleton className="h-40" />
      ) : rows.length === 0 ? (
        <EmptyNote icon={Armchair} title="No tables" text="Add tables under Tables & Sections." />
      ) : (
        <Table
          rows={rows}
          rowKey={(r) => r.id}
          cols={[
            {
              key: 't',
              header: 'Table',
              cell: (r) => (
                <span className="font-medium">
                  {r.label} <span className="text-xs font-normal text-muted-foreground">{r.area}</span>
                </span>
              ),
            },
            { key: 'c', header: 'Capacity', align: 'right', cell: (r) => r.capacity },
            { key: 'o', header: 'Occupied', align: 'right', cell: (r) => r.occupied },
            { key: 'a', header: 'Available', align: 'right', cell: (r) => r.available },
            {
              key: 's',
              header: 'Status',
              cell: (r) => <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>,
            },
            {
              key: 'g',
              header: 'Groups (seats, payment)',
              hideOnMobile: true,
              cell: (r) =>
                r.groups.length === 0 ? (
                  '—'
                ) : (
                  <div className="space-y-1">
                    {r.groups.map((g) => (
                      <div key={g.guestId} className="flex items-center gap-2 text-sm">
                        <span>
                          {g.name}: {g.seats} seat{g.seats === 1 ? '' : 's'}
                        </span>
                        <Badge
                          tone={g.paymentStatus === 'paid' ? 'emerald' : g.paymentStatus === 'no_orders' ? undefined : 'amber'}
                        >
                          {PAY_LABEL[g.paymentStatus]}
                          {g.outstandingMinor > 0 ? ` · ${money(g.outstandingMinor)} due` : ''}
                        </Badge>
                      </div>
                    ))}
                  </div>
                ),
            },
          ]}
        />
      )}
    </Card>
  );
}
