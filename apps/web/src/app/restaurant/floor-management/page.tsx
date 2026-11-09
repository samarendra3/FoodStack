'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { Armchair, LayoutGrid, Pencil, Users } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { type DiningTable, useTables } from '@/lib/tables';
import { useRestaurantOverview } from '../overview';
import { TableSessionPanel } from '../tables/table-session-panel';
import { BranchPicker, money, Toolbar } from '../_kit/ops-kit';
import {
  buttonSecondary,
  Card,
  EmptyNote,
  ErrorNote,
  PageHeader,
  Skeleton,
  Stat,
  StatGrid,
} from '../_kit/report-kit';

/** Live floor plan by area: who is sitting where and what each table owes. */
export default function FloorManagementPage() {
  const overview = useRestaurantOverview();
  const branches = overview.data?.branches ?? [];
  const [picked, setPicked] = useState('');
  const branchId = picked || branches[0]?.id;
  const tables = useTables(branchId);
  const list = tables.data?.tables ?? [];
  const [open, setOpen] = useState<DiningTable | null>(null);
  const areas = [...new Set(list.map((t) => t.area))];
  const busy = list.filter((t) => t.status === 'occupied');
  const seats = list.reduce((s, t) => s + t.seats, 0);

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Floor Management"
        description="A live view of every floor and area. Tap a table to see its guests, orders and bill."
        actions={
          <Link href="/restaurant/tables" className={buttonSecondary}>
            <Pencil className="size-4" /> Edit tables & areas
          </Link>
        }
      />
      <Toolbar>
        <BranchPicker branches={branches} value={branchId ?? ''} onChange={setPicked} />
      </Toolbar>
      {tables.isError ? <ErrorNote error={tables.error} /> : null}
      <StatGrid>
        <Stat
          icon={Armchair}
          label="Tables occupied"
          value={tables.data ? `${busy.length} / ${list.length}` : undefined}
          loading={tables.isPending}
        />
        <Stat
          label="Occupancy"
          value={
            tables.data
              ? `${list.length ? Math.round((busy.length / list.length) * 100) : 0}%`
              : undefined
          }
          loading={tables.isPending}
        />
        <Stat
          icon={Users}
          label="Seats"
          value={tables.data ? seats : undefined}
          hint={`${areas.length} area${areas.length === 1 ? '' : 's'}`}
          loading={tables.isPending}
        />
        <Stat
          label="Running bills"
          value={tables.data ? money(busy.reduce((t, x) => t + x.openTotalMinor, 0)) : undefined}
          loading={tables.isPending}
        />
      </StatGrid>
      {tables.isPending ? (
        <Skeleton className="h-56" />
      ) : list.length === 0 ? (
        <Card>
          <EmptyNote
            icon={LayoutGrid}
            title="No tables yet"
            text="Add tables and group them into areas (Ground floor, Terrace…) on the Tables & Sections screen."
          />
        </Card>
      ) : (
        <div className="grid gap-6 xl:grid-cols-2">
          {areas.map((area) => {
            const at = list.filter((t) => t.area === area);
            const occ = at.filter((t) => t.status === 'occupied').length;
            return (
              <Card
                key={area}
                title={area}
                subtitle={`${occ} of ${at.length} occupied · ${at.reduce((s, t) => s + t.seats, 0)} seats`}
              >
                <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5">
                  {at.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => setOpen(t)}
                        className={cn(
                          'flex aspect-square w-full flex-col items-center justify-center rounded-2xl border-2 p-2 text-center transition-colors',
                          t.status === 'occupied'
                            ? 'border-amber-400 bg-amber-50 hover:bg-amber-100 dark:bg-amber-500/10'
                            : 'border-dashed border-emerald-300 bg-white hover:bg-emerald-50 dark:border-emerald-500/40 dark:bg-slate-900',
                        )}
                      >
                        <span className="text-lg font-semibold">{t.label}</span>
                        <span className="text-xs text-muted-foreground">{t.seats} seats</span>
                        {t.status === 'occupied' ? (
                          <span className="mt-1 text-xs font-semibold text-amber-800 tabular-nums dark:text-amber-300">
                            {money(t.openTotalMinor)}
                          </span>
                        ) : (
                          <span className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
                            Free
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>
      )}
      {open ? (
        <TableSessionPanel
          tableId={open.id}
          tableLabel={open.label}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
