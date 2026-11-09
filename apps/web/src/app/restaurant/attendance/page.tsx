'use client';

import { cn } from '@foodstack/ui/lib/utils';
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Clock,
  LogIn,
  LogOut,
  Plus,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  BranchPicker,
  dateTime,
  daysAgo,
  Field,
  FormDialog,
  input,
  Table,
  timeOnly,
  today,
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

interface Me {
  branches: { id: string; name: string }[];
  open: { id: string; clockIn: string; branchId: string; branchName: string } | null;
  weekMinutes: number;
}
interface Attendance {
  branches: { id: string; name: string }[];
  from: string;
  to: string;
  canManage: boolean;
  entries: {
    id: string;
    userId: string;
    name: string;
    branchName: string;
    clockIn: string;
    clockOut: string | null;
    note: string | null;
    minutes: number;
  }[];
  people: { userId: string; name: string; minutes: number; days: number; onShift: boolean }[];
}
interface Shifts {
  branch: { id: string; name: string };
  branches: { id: string; name: string }[];
  weekStart: string;
  canManage: boolean;
  staff: { userId: string; name: string; roles: string[] }[];
  shifts: {
    id: string;
    userId: string;
    name: string;
    startsAt: string;
    endsAt: string;
    roleLabel: string | null;
  }[];
}
const hours = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00`);
  x.setDate(x.getDate() + n);
  return x.toLocaleDateString('en-CA');
};

export default function AttendancePage() {
  const [tab, setTab] = useState<'attendance' | 'rota'>('attendance');
  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Attendance & Shifts"
        description="Staff clock in and out here; managers see hours worked and plan the weekly rota."
      />
      <ClockCard />
      <div
        role="tablist"
        className="inline-flex rounded-lg border border-slate-200 p-1 text-sm dark:border-white/10"
      >
        {(
          [
            ['attendance', 'Attendance'],
            ['rota', 'Shift rota'],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cn(
              'rounded-md px-3 py-1.5 font-medium',
              tab === k ? 'bg-emerald-600 text-white' : 'text-slate-600 dark:text-slate-300',
            )}
          >
            {l}
          </button>
        ))}
      </div>
      {tab === 'attendance' ? <AttendanceTab /> : <RotaTab />}
    </div>
  );
}

function ClockCard() {
  const q = useOps<Me>('/attendance/me');
  const w = useOpsWrite();
  const [branch, setBranch] = useState('');
  const me = q.data;
  if (q.isError || !me) return null;
  return (
    <Card>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <span
          className={cn(
            'flex size-10 items-center justify-center rounded-full',
            me.open
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15'
              : 'bg-slate-100 text-slate-500 dark:bg-white/10',
          )}
        >
          <Clock className="size-5" />
        </span>
        <div className="flex-1">
          <p className="font-semibold">
            {me.open
              ? `On shift at ${me.open.branchName} since ${timeOnly.format(new Date(me.open.clockIn))}`
              : 'You are not clocked in'}
          </p>
          <p className="text-sm text-muted-foreground">This week: {hours(me.weekMinutes)}</p>
        </div>
        {me.open ? (
          <button
            type="button"
            className={buttonSecondary}
            onClick={() => void w.act('/attendance/clock-out', 'POST', {}, 'Clocked out')}
          >
            <LogOut className="size-4" /> Clock out
          </button>
        ) : (
          <div className="flex gap-2">
            {me.branches.length > 1 ? (
              <select
                aria-label="Branch"
                className={control}
                value={branch || me.branches[0]?.id}
                onChange={(e) => setBranch(e.target.value)}
              >
                {me.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              type="button"
              className={buttonPrimary}
              disabled={!me.branches.length}
              onClick={() =>
                void w.act(
                  '/attendance/clock-in',
                  'POST',
                  { branchId: branch || me.branches[0]?.id },
                  'Clocked in',
                )
              }
            >
              <LogIn className="size-4" /> Clock in
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}

function AttendanceTab() {
  const [branchId, setBranchId] = useState('');
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(today());
  const q = useOps<Attendance>(
    `/attendance?${new URLSearchParams({ from, to, ...(branchId ? { branchId } : {}) })}`,
  );
  const w = useOpsWrite();
  const d = q.data;
  const [fix, setFix] = useState<Attendance['entries'][number] | null>(null);
  const [out, setOut] = useState('');
  return (
    <>
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
          className={control}
          value={from}
          max={to}
          onChange={(e) => setFrom(e.target.value)}
        />
        <input
          type="date"
          aria-label="To"
          className={control}
          value={to}
          min={from}
          max={today()}
          onChange={(e) => setTo(e.target.value)}
        />
      </Toolbar>
      {q.isError ? <ErrorNote error={q.error} /> : null}
      <StatGrid>
        <Stat
          icon={CalendarClock}
          label="On shift now"
          value={d?.people.filter((p) => p.onShift).length}
          loading={q.isPending}
        />
        <Stat label="People who worked" value={d?.people.length} loading={q.isPending} />
        <Stat
          label="Total hours"
          value={d ? hours(d.people.reduce((t, p) => t + p.minutes, 0)) : undefined}
          loading={q.isPending}
        />
        <Stat
          label="Open entries"
          value={d?.entries.filter((e) => !e.clockOut).length}
          hint="Forgotten clock-outs show here"
          loading={q.isPending}
        />
      </StatGrid>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Hours by person">
          {d?.people.length ? (
            <ul className="divide-y divide-slate-100 text-sm dark:divide-white/5">
              {d.people.map((p) => (
                <li key={p.userId} className="flex items-center justify-between py-2">
                  <span>
                    {p.name} {p.onShift ? <Badge tone="emerald">On shift</Badge> : null}
                    <span className="block text-xs text-muted-foreground">
                      {p.days} day{p.days === 1 ? '' : 's'}
                    </span>
                  </span>
                  <span className="font-semibold tabular-nums">{hours(p.minutes)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No attendance in this period.
            </p>
          )}
        </Card>
        <Card className="lg:col-span-2">
          {q.isPending ? (
            <Skeleton className="h-40" />
          ) : !d?.entries.length ? (
            <EmptyNote
              icon={Clock}
              title="No clock-ins yet"
              text="Staff clock in from this screen at the start of their shift."
            />
          ) : (
            <Table
              rows={d.entries}
              rowKey={(e) => e.id}
              cols={[
                {
                  key: 'n',
                  header: 'Person',
                  cell: (e) => <span className="font-medium">{e.name}</span>,
                },
                { key: 'i', header: 'In', cell: (e) => dateTime.format(new Date(e.clockIn)) },
                {
                  key: 'o',
                  header: 'Out',
                  cell: (e) =>
                    e.clockOut ? (
                      timeOnly.format(new Date(e.clockOut))
                    ) : (
                      <Badge tone="emerald">On shift</Badge>
                    ),
                },
                { key: 'b', header: 'Branch', hideOnMobile: true, cell: (e) => e.branchName },
                { key: 'h', header: 'Hours', align: 'right', cell: (e) => hours(e.minutes) },
                {
                  key: 'x',
                  header: '',
                  align: 'right',
                  cell: (e) =>
                    d.canManage && !e.clockOut ? (
                      <button
                        type="button"
                        className={buttonSecondary}
                        onClick={() => {
                          setFix(e);
                          setOut('');
                        }}
                      >
                        Clock out
                      </button>
                    ) : null,
                },
              ]}
            />
          )}
        </Card>
      </div>
      <FormDialog
        open={fix !== null}
        onClose={() => setFix(null)}
        title={`Clock out ${fix?.name ?? ''}`}
        description="For a forgotten clock-out. The correction is recorded in the activity log."
        onSubmit={() =>
          w.send(`/attendance/${fix!.id}`, 'PATCH', {
            clockOut: new Date(out).toISOString(),
            note: 'Corrected by manager',
          })
        }
      >
        <Field label="Clock-out time">
          <input
            type="datetime-local"
            required
            className={input}
            value={out}
            onChange={(e) => setOut(e.target.value)}
          />
        </Field>
      </FormDialog>
    </>
  );
}

function RotaTab() {
  const [branchId, setBranchId] = useState('');
  const [week, setWeek] = useState('');
  const q = useOps<Shifts>(
    `/shifts?${new URLSearchParams({ ...(branchId ? { branchId } : {}), ...(week ? { weekStart: week } : {}) })}`,
  );
  const w = useOpsWrite();
  const d = q.data;
  const ws = d?.weekStart ?? week;
  const days = ws ? Array.from({ length: 7 }, (_, i) => addDays(ws, i)) : [];
  const [add, setAdd] = useState<string | null>(null);
  const [f, setF] = useState({ userId: '', start: '10:00', end: '18:00', roleLabel: '' });
  const total = (d?.shifts ?? []).reduce(
    (t, s) => t + (new Date(s.endsAt).getTime() - new Date(s.startsAt).getTime()) / 60_000,
    0,
  );
  return (
    <>
      <Toolbar>
        <BranchPicker
          branches={d?.branches ?? []}
          value={d?.branch.id ?? ''}
          onChange={setBranchId}
        />
        <div className="col-span-2 flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous week"
            className={buttonSecondary}
            disabled={!ws}
            onClick={() => setWeek(addDays(ws, -7))}
          >
            <ChevronLeft className="size-4" />
          </button>
          <span className="px-2 text-sm font-medium">Week of {ws}</span>
          <button
            type="button"
            aria-label="Next week"
            className={buttonSecondary}
            disabled={!ws}
            onClick={() => setWeek(addDays(ws, 7))}
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
        <span className="text-sm text-muted-foreground">{hours(Math.round(total))} planned</span>
      </Toolbar>
      {q.isError ? <ErrorNote error={q.error} /> : null}
      {q.isPending ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <div className="grid min-w-[56rem] grid-cols-7 gap-2">
            {days.map((day) => {
              const list = (d?.shifts ?? []).filter(
                (s) => new Date(s.startsAt).toLocaleDateString('en-CA') === day,
              );
              return (
                <div
                  key={day}
                  className="min-h-40 rounded-xl border border-slate-200 bg-white p-2 dark:border-white/10 dark:bg-slate-900"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <p
                      className={cn('text-sm font-semibold', day === today() && 'text-emerald-700')}
                    >
                      {new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
                        weekday: 'short',
                        day: 'numeric',
                      })}
                    </p>
                    {d?.canManage ? (
                      <button
                        type="button"
                        aria-label={`Add shift on ${day}`}
                        className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-emerald-700 dark:hover:bg-white/10"
                        onClick={() => {
                          setAdd(day);
                          setF((x) => ({ ...x, userId: d.staff[0]?.userId ?? '' }));
                        }}
                      >
                        <Plus className="size-4" />
                      </button>
                    ) : null}
                  </div>
                  <ul className="space-y-1">
                    {list.map((s) => (
                      <li
                        key={s.id}
                        className="group rounded-md bg-emerald-50 px-2 py-1 text-xs dark:bg-emerald-500/10"
                      >
                        <div className="flex items-start justify-between gap-1">
                          <span className="font-medium">{s.name}</span>
                          {d?.canManage ? (
                            <button
                              type="button"
                              aria-label="Delete shift"
                              onClick={() =>
                                void w.act(`/shifts/${s.id}`, 'DELETE', undefined, 'Shift removed')
                              }
                              className="opacity-60 hover:text-red-600 hover:opacity-100"
                            >
                              <Trash2 className="size-3" />
                            </button>
                          ) : null}
                        </div>
                        <span className="text-muted-foreground">
                          {timeOnly.format(new Date(s.startsAt))}–
                          {timeOnly.format(new Date(s.endsAt))}
                          {s.roleLabel ? ` · ${s.roleLabel}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <FormDialog
        open={add !== null}
        onClose={() => setAdd(null)}
        title={`Add shift · ${add ?? ''}`}
        onSubmit={() => {
          const start = new Date(`${add}T${f.start}:00`);
          let end = new Date(`${add}T${f.end}:00`);
          if (end <= start) end = new Date(end.getTime() + 86_400_000); // overnight shift
          return w.send('/shifts', 'POST', {
            branchId: d!.branch.id,
            userId: f.userId,
            startsAt: start.toISOString(),
            endsAt: end.toISOString(),
            roleLabel: f.roleLabel,
          });
        }}
      >
        <Field label="Person">
          <select
            required
            className={input}
            value={f.userId}
            onChange={(e) => setF((x) => ({ ...x, userId: e.target.value }))}
          >
            {d?.staff.map((s) => (
              <option key={s.userId} value={s.userId}>
                {s.name} · {s.roles.join(', ')}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Start">
            <input
              type="time"
              required
              className={input}
              value={f.start}
              onChange={(e) => setF((x) => ({ ...x, start: e.target.value }))}
            />
          </Field>
          <Field label="End" hint="Earlier than start = ends next day">
            <input
              type="time"
              required
              className={input}
              value={f.end}
              onChange={(e) => setF((x) => ({ ...x, end: e.target.value }))}
            />
          </Field>
        </div>
        <Field label="Station (optional)">
          <input
            maxLength={40}
            className={input}
            value={f.roleLabel}
            onChange={(e) => setF((x) => ({ ...x, roleLabel: e.target.value }))}
            placeholder="Tandoor, Counter, Floor…"
          />
        </Field>
      </FormDialog>
    </>
  );
}
