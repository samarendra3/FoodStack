'use client';

import { CalendarCheck, ChevronLeft, ChevronRight, Phone, Plus, Users } from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  BranchPicker,
  Field,
  FormDialog,
  input,
  timeOnly,
  Toolbar,
  useOps,
  useOpsWrite,
} from '../_kit/ops-kit';
import {
  buttonPrimary,
  buttonSecondary,
  Card,
  control,
  EmptyNote,
  ErrorNote,
  PageHeader,
  Skeleton,
  Stat,
  StatGrid,
} from '../_kit/report-kit';

type Status = 'booked' | 'seated' | 'completed' | 'cancelled' | 'no_show';
interface Reservation {
  id: string;
  customerName: string;
  phone: string;
  partySize: number;
  reservedAt: string;
  durationMinutes: number;
  tableId: string | null;
  tableLabel: string | null;
  status: Status;
  note: string | null;
}
interface Day {
  branch: { id: string; name: string };
  branches: { id: string; name: string }[];
  date: string;
  canManage: boolean;
  tables: { id: string; label: string; seats: number; area: string }[];
  rows: Reservation[];
}
const STATUS: Record<
  Status,
  { label: string; tone: 'sky' | 'emerald' | 'slate' | 'red' | 'amber' }
> = {
  booked: { label: 'Booked', tone: 'sky' },
  seated: { label: 'Seated', tone: 'emerald' },
  completed: { label: 'Done', tone: 'slate' },
  cancelled: { label: 'Cancelled', tone: 'red' },
  no_show: { label: 'No-show', tone: 'amber' },
};
const shift = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA');
};

export default function ReservationsPage() {
  const [branchId, setBranchId] = useState('');
  const [date, setDate] = useState('');
  const qs = new URLSearchParams({ ...(branchId ? { branchId } : {}), ...(date ? { date } : {}) });
  const q = useOps<Day>(`/reservations?${qs}`);
  const w = useOpsWrite();
  const d = q.data;
  const [edit, setEdit] = useState<Partial<Reservation> | null>(null);
  const active = d?.rows.filter((r) => r.status === 'booked' || r.status === 'seated') ?? [];
  const day = d?.date ?? date;

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Reservations"
        description="Table bookings by day. A table cannot be double-booked for overlapping times."
        actions={
          d?.canManage ? (
            <button
              type="button"
              className={buttonPrimary}
              onClick={() => setEdit({ partySize: 2, durationMinutes: 90 })}
            >
              <Plus className="size-4" /> New reservation
            </button>
          ) : null
        }
      />
      <Toolbar>
        <BranchPicker
          branches={d?.branches ?? []}
          value={d?.branch.id ?? ''}
          onChange={setBranchId}
        />
        <div className="col-span-2 flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous day"
            className={buttonSecondary}
            onClick={() => setDate(shift(day, -1))}
            disabled={!day}
          >
            <ChevronLeft className="size-4" />
          </button>
          <input
            type="date"
            aria-label="Day"
            className={control}
            value={day}
            onChange={(e) => setDate(e.target.value)}
          />
          <button
            type="button"
            aria-label="Next day"
            className={buttonSecondary}
            onClick={() => setDate(shift(day, 1))}
            disabled={!day}
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </Toolbar>
      {q.isError ? <ErrorNote error={q.error} /> : null}
      <StatGrid>
        <Stat
          icon={CalendarCheck}
          label="Bookings"
          value={d ? active.length : undefined}
          loading={q.isPending}
        />
        <Stat
          icon={Users}
          label="Guests expected"
          value={d ? active.reduce((t, r) => t + r.partySize, 0) : undefined}
          loading={q.isPending}
        />
        <Stat
          label="Seated now"
          value={d?.rows.filter((r) => r.status === 'seated').length}
          loading={q.isPending}
        />
        <Stat
          label="No-shows"
          value={d?.rows.filter((r) => r.status === 'no_show').length}
          loading={q.isPending}
        />
      </StatGrid>
      <Card>
        {q.isPending ? (
          <Skeleton className="h-40" />
        ) : !d?.rows.length ? (
          <EmptyNote
            icon={CalendarCheck}
            title="No reservations this day"
            text="Bookings taken by phone or walk-in appear here in time order."
          />
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-white/5">
            {d.rows.map((r) => (
              <li key={r.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center">
                <div className="w-20 shrink-0 text-lg font-semibold tabular-nums">
                  {timeOnly.format(new Date(r.reservedAt))}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {r.customerName}{' '}
                    <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {r.partySize} guests · {r.tableLabel ? `Table ${r.tableLabel}` : 'No table yet'}{' '}
                    · {r.durationMinutes} min ·{' '}
                    <a
                      href={`tel:${r.phone}`}
                      className="inline-flex items-center gap-0.5 hover:underline"
                    >
                      <Phone className="size-3" /> {r.phone}
                    </a>
                  </p>
                  {r.note ? <p className="text-xs text-muted-foreground">{r.note}</p> : null}
                </div>
                {d.canManage ? (
                  <div className="flex flex-wrap gap-2">
                    {r.status === 'booked' ? (
                      <>
                        <button
                          type="button"
                          className={buttonSecondary}
                          onClick={() =>
                            void w.act(
                              `/reservations/${r.id}`,
                              'PATCH',
                              { status: 'seated' },
                              `${r.customerName} seated`,
                            )
                          }
                        >
                          Seat
                        </button>
                        <button
                          type="button"
                          className={buttonSecondary}
                          onClick={() => setEdit(r)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className={buttonSecondary}
                          onClick={() =>
                            void w.act(
                              `/reservations/${r.id}`,
                              'PATCH',
                              { status: 'no_show' },
                              'Marked no-show',
                            )
                          }
                        >
                          No-show
                        </button>
                        <button
                          type="button"
                          className={buttonSecondary}
                          onClick={() =>
                            void w.act(
                              `/reservations/${r.id}`,
                              'PATCH',
                              { status: 'cancelled' },
                              'Reservation cancelled',
                            )
                          }
                        >
                          Cancel
                        </button>
                      </>
                    ) : r.status === 'seated' ? (
                      <button
                        type="button"
                        className={buttonSecondary}
                        onClick={() =>
                          void w.act(
                            `/reservations/${r.id}`,
                            'PATCH',
                            { status: 'completed' },
                            'Table freed',
                          )
                        }
                      >
                        Finish
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {edit && d ? (
        <ReservationForm
          value={edit}
          day={d.date}
          branchId={d.branch.id}
          tables={d.tables}
          onClose={() => setEdit(null)}
        />
      ) : null}
    </div>
  );
}

function ReservationForm({
  value,
  day,
  branchId,
  tables,
  onClose,
}: {
  value: Partial<Reservation>;
  day: string;
  branchId: string;
  tables: Day['tables'];
  onClose: () => void;
}) {
  const w = useOpsWrite();
  const at = value.reservedAt ? new Date(value.reservedAt) : null;
  const [f, setF] = useState({
    customerName: value.customerName ?? '',
    phone: value.phone ?? '',
    partySize: String(value.partySize ?? 2),
    date: at ? at.toLocaleDateString('en-CA') : day,
    time: at ? at.toTimeString().slice(0, 5) : '19:30',
    durationMinutes: String(value.durationMinutes ?? 90),
    tableId: value.tableId ?? '',
    note: value.note ?? '',
  });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const fits = tables.filter((t) => t.seats >= Number(f.partySize) || t.id === f.tableId);
  return (
    <FormDialog
      open
      onClose={onClose}
      title={value.id ? 'Edit reservation' : 'New reservation'}
      onSubmit={() => {
        const body = {
          customerName: f.customerName,
          phone: f.phone,
          partySize: Number(f.partySize),
          reservedAt: new Date(`${f.date}T${f.time}:00`).toISOString(),
          durationMinutes: Number(f.durationMinutes),
          tableId: f.tableId || null,
          note: f.note,
        };
        return value.id
          ? w.send(`/reservations/${value.id}`, 'PATCH', body)
          : w.send('/reservations', 'POST', { branchId, ...body });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Guest name">
          <input
            required
            maxLength={80}
            className={input}
            value={f.customerName}
            onChange={(e) => set({ customerName: e.target.value })}
          />
        </Field>
        <Field label="Phone">
          <input
            required
            type="tel"
            className={input}
            value={f.phone}
            onChange={(e) => set({ phone: e.target.value })}
          />
        </Field>
        <Field label="Date">
          <input
            required
            type="date"
            className={input}
            value={f.date}
            onChange={(e) => set({ date: e.target.value })}
          />
        </Field>
        <Field label="Time">
          <input
            required
            type="time"
            className={input}
            value={f.time}
            onChange={(e) => set({ time: e.target.value })}
          />
        </Field>
        <Field label="Guests">
          <input
            required
            type="number"
            min="1"
            max="100"
            className={input}
            value={f.partySize}
            onChange={(e) => set({ partySize: e.target.value })}
          />
        </Field>
        <Field label="Duration">
          <select
            className={input}
            value={f.durationMinutes}
            onChange={(e) => set({ durationMinutes: e.target.value })}
          >
            {[60, 90, 120, 150, 180].map((m) => (
              <option key={m} value={m}>
                {m / 60} h
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field
        label="Table (optional)"
        hint="Only tables with enough seats are listed. You can assign one when the guest arrives."
      >
        <select
          className={input}
          value={f.tableId}
          onChange={(e) => set({ tableId: e.target.value })}
        >
          <option value="">Assign later</option>
          {fits.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label} · {t.seats} seats · {t.area}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Note (optional)">
        <input
          maxLength={300}
          className={input}
          value={f.note}
          onChange={(e) => set({ note: e.target.value })}
          placeholder="Birthday, high chair, window seat…"
        />
      </Field>
    </FormDialog>
  );
}
