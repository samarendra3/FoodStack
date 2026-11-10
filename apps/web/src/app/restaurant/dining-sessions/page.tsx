'use client';

import { QrCode, Timer, UserRound } from 'lucide-react';
import { useState } from 'react';
import { useRestaurantOverview } from '../overview';
import { TableSessionPanel } from '../tables/table-session-panel';
import { Badge, BranchPicker, money, Table, timeOnly, Toolbar, useOps } from '../_kit/ops-kit';
import {
  Card,
  EmptyNote,
  ErrorNote,
  PageHeader,
  Skeleton,
  Stat,
  StatGrid,
} from '../_kit/report-kit';

interface OpenSession {
  id: string;
  tableId: string;
  tableLabel: string;
  area: string;
  openedAt: string;
  openedVia: 'qr' | 'staff';
  guests: number;
  orders: number;
  totalMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  lastOrderAt: string | null;
}

const minutes = (iso: string) =>
  Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
const duration = (iso: string) => {
  const m = minutes(iso);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

/** Every table that is seated right now: since when, how many guests, and what is still due. */
export default function DiningSessionsPage() {
  const overview = useRestaurantOverview();
  const branches = overview.data?.branches ?? [];
  const [picked, setPicked] = useState('');
  const branchId = picked || branches[0]?.id;
  const q = useOps<OpenSession[]>(branchId ? `/table-sessions/open?branchId=${branchId}` : null);
  const rows = q.data ?? [];
  const [open, setOpen] = useState<OpenSession | null>(null);
  const due = rows.reduce((t, r) => t + r.outstandingMinor, 0);

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Dining Sessions"
        description="Tables seated right now, from first order or QR scan until the table is closed. Open one to take payment per guest."
      />
      <Toolbar>
        <BranchPicker branches={branches} value={branchId ?? ''} onChange={setPicked} />
      </Toolbar>
      {q.isError ? <ErrorNote error={q.error} /> : null}
      <StatGrid>
        <Stat
          icon={Timer}
          label="Open sittings"
          value={q.data ? rows.length : undefined}
          loading={q.isPending}
        />
        <Stat
          icon={UserRound}
          label="QR guests"
          value={q.data ? rows.reduce((t, r) => t + r.guests, 0) : undefined}
          loading={q.isPending}
        />
        <Stat label="Outstanding" value={q.data ? money(due) : undefined} loading={q.isPending} />
        <Stat
          label="Longest sitting"
          value={q.data ? (rows[0] ? duration(rows[0].openedAt) : '—') : undefined}
          hint={rows[0] ? `Table ${rows[0].tableLabel}` : undefined}
          loading={q.isPending}
        />
      </StatGrid>
      <Card>
        {q.isPending ? (
          <Skeleton className="h-40" />
        ) : rows.length === 0 ? (
          <EmptyNote
            icon={Timer}
            title="No tables seated"
            text="A sitting starts when a guest scans a table QR code or staff place a dine-in order at a table."
          />
        ) : (
          <Table
            rows={rows}
            rowKey={(r) => r.id}
            onRow={setOpen}
            cols={[
              {
                key: 't',
                header: 'Table',
                cell: (r) => (
                  <span className="font-medium">
                    {r.tableLabel}{' '}
                    <span className="text-xs font-normal text-muted-foreground">{r.area}</span>
                  </span>
                ),
              },
              {
                key: 's',
                header: 'Seated',
                cell: (r) => (
                  <span>
                    {timeOnly.format(new Date(r.openedAt))}{' '}
                    <span className="text-xs text-muted-foreground">({duration(r.openedAt)})</span>
                  </span>
                ),
              },
              {
                key: 'v',
                header: 'Started by',
                hideOnMobile: true,
                cell: (r) =>
                  r.openedVia === 'qr' ? (
                    <Badge tone="violet">
                      <QrCode className="mr-1 size-3" />
                      QR
                    </Badge>
                  ) : (
                    <Badge>Staff</Badge>
                  ),
              },
              {
                key: 'g',
                header: 'Guests',
                align: 'right',
                hideOnMobile: true,
                cell: (r) => r.guests,
              },
              { key: 'o', header: 'Orders', align: 'right', cell: (r) => r.orders },
              {
                key: 'l',
                header: 'Last order',
                hideOnMobile: true,
                cell: (r) => (r.lastOrderAt ? `${minutes(r.lastOrderAt)} min ago` : '—'),
              },
              {
                key: 'p',
                header: 'Paid',
                align: 'right',
                hideOnMobile: true,
                cell: (r) => money(r.paidMinor),
              },
              {
                key: 'd',
                header: 'Due',
                align: 'right',
                cell: (r) =>
                  r.outstandingMinor > 0 ? (
                    <Badge tone="amber">{money(r.outstandingMinor)}</Badge>
                  ) : (
                    <Badge tone="emerald">Settled</Badge>
                  ),
              },
            ]}
          />
        )}
      </Card>
      {open ? (
        <TableSessionPanel
          tableId={open.tableId}
          tableLabel={open.tableLabel}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
