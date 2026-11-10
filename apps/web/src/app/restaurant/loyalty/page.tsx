'use client';

import { Gift, Search, Settings2 } from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  dateOnly,
  Field,
  FormDialog,
  input,
  money,
  Switch,
  Table,
  Toolbar,
  useOps,
  useOpsWrite,
} from '../_kit/ops-kit';
import {
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

interface Member {
  id: string;
  name: string | null;
  phone: string;
  spentMinor: number;
  visits: number;
  lastVisit: string | null;
  earned: number;
  redeemed: number;
  balance: number;
  balanceValueMinor: number;
  tier: 'bronze' | 'silver' | 'gold';
}
interface Loyalty {
  restaurantId: string;
  currencyCode: string;
  canManage: boolean;
  program: {
    isEnabled: boolean;
    pointsPer100: number;
    pointValueMinor: number;
    minRedeemPoints: number;
  };
  totals: { members: number; outstandingPoints: number; outstandingValueMinor: number };
  customers: Member[];
}
const TIER = { gold: 'amber', silver: 'slate', bronze: 'violet' } as const;

export default function LoyaltyPage() {
  const [search, setSearch] = useState('');
  const q = useOps<Loyalty>(
    `/loyalty${search.trim().length >= 2 ? `?search=${encodeURIComponent(search.trim())}` : ''}`,
  );
  const d = q.data;
  const m = (v: number) => money(v, d?.currencyCode);
  const [settings, setSettings] = useState(false);
  const [points, setPoints] = useState<{ member: Member; kind: 'redeem' | 'adjust' } | null>(null);
  const p = d?.program;

  return (
    <div className="mx-auto max-w-[96rem] space-y-6">
      <PageHeader
        title="Loyalty & Rewards"
        description="Customers earn points on every paid bill (identified by phone number) and redeem them for discounts."
        actions={
          d?.canManage ? (
            <button type="button" className={buttonSecondary} onClick={() => setSettings(true)}>
              <Settings2 className="size-4" /> Programme settings
            </button>
          ) : null
        }
      />
      {q.isError ? <ErrorNote error={q.error} /> : null}
      {p && !p.isEnabled ? (
        <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          The programme is off. Points are still counted from past bills, but cannot be redeemed
          until you turn it on.
        </div>
      ) : null}
      <StatGrid>
        <Stat
          icon={Gift}
          label="Members"
          value={d?.totals.members}
          hint="Customers with a paid bill"
          loading={q.isPending}
        />
        <Stat
          label="Earning rate"
          value={p ? `${p.pointsPer100} pt / ₹100` : undefined}
          hint={p ? `1 point = ${m(p.pointValueMinor)}` : undefined}
          loading={q.isPending}
        />
        <Stat
          label="Unredeemed points"
          value={d?.totals.outstandingPoints.toLocaleString('en-IN')}
          loading={q.isPending}
        />
        <Stat
          label="Liability"
          value={d ? m(d.totals.outstandingValueMinor) : undefined}
          hint="Value of unredeemed points"
          loading={q.isPending}
        />
      </StatGrid>
      <Toolbar>
        <label className="relative col-span-2 sm:w-80">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
          <input
            aria-label="Search members"
            placeholder="Name or phone"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`${control} w-full pl-9`}
          />
        </label>
      </Toolbar>
      <Card>
        {q.isPending ? (
          <Skeleton className="h-48" />
        ) : !d?.customers.length ? (
          <EmptyNote
            icon={Gift}
            title="No members yet"
            text="Add the customer's phone number on the POS bill; they join automatically with their first paid bill."
          />
        ) : (
          <Table
            rows={d.customers}
            rowKey={(r) => r.id}
            cols={[
              {
                key: 'n',
                header: 'Customer',
                cell: (r) => (
                  <div>
                    <p className="font-medium">{r.name ?? 'Guest'}</p>
                    <p className="text-xs text-muted-foreground">{r.phone}</p>
                  </div>
                ),
              },
              {
                key: 't',
                header: 'Tier',
                cell: (r) => <Badge tone={TIER[r.tier]}>{r.tier}</Badge>,
              },
              {
                key: 'v',
                header: 'Visits',
                align: 'right',
                hideOnMobile: true,
                cell: (r) => r.visits,
              },
              {
                key: 's',
                header: 'Spent',
                align: 'right',
                hideOnMobile: true,
                cell: (r) => m(r.spentMinor),
              },
              {
                key: 'l',
                header: 'Last visit',
                hideOnMobile: true,
                cell: (r) => (r.lastVisit ? dateOnly.format(new Date(r.lastVisit)) : '—'),
              },
              {
                key: 'b',
                header: 'Points',
                align: 'right',
                cell: (r) => (
                  <span>
                    <span className="font-semibold">{r.balance.toLocaleString('en-IN')}</span>
                    <span className="block text-xs text-muted-foreground">
                      {m(r.balanceValueMinor)}
                    </span>
                  </span>
                ),
              },
              {
                key: 'x',
                header: '',
                align: 'right',
                cell: (r) =>
                  d.canManage ? (
                    <span className="inline-flex gap-1">
                      <button
                        type="button"
                        className={buttonSecondary}
                        disabled={!p?.isEnabled || r.balance < (p?.minRedeemPoints ?? 0)}
                        onClick={() => setPoints({ member: r, kind: 'redeem' })}
                      >
                        Redeem
                      </button>
                      <button
                        type="button"
                        className={buttonSecondary}
                        disabled={!p?.isEnabled}
                        onClick={() => setPoints({ member: r, kind: 'adjust' })}
                      >
                        Adjust
                      </button>
                    </span>
                  ) : null,
              },
            ]}
          />
        )}
      </Card>
      {settings && d ? <ProgramForm d={d} onClose={() => setSettings(false)} /> : null}
      {points && d ? (
        <PointsForm
          d={d}
          member={points.member}
          kind={points.kind}
          onClose={() => setPoints(null)}
        />
      ) : null}
    </div>
  );
}

function ProgramForm({ d, onClose }: { d: Loyalty; onClose: () => void }) {
  const w = useOpsWrite();
  const [f, setF] = useState({
    isEnabled: d.program.isEnabled,
    pointsPer100: String(d.program.pointsPer100),
    pointValue: String(d.program.pointValueMinor / 100),
    minRedeemPoints: String(d.program.minRedeemPoints),
  });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const rewardPct = ((Number(f.pointsPer100) * Number(f.pointValue)) / 100) * 100;
  return (
    <FormDialog
      open
      onClose={onClose}
      title="Loyalty programme"
      onSubmit={() =>
        w.send('/loyalty/program', 'PUT', {
          restaurantId: d.restaurantId,
          isEnabled: f.isEnabled,
          pointsPer100: Number(f.pointsPer100),
          pointValueMinor: Math.round(Number(f.pointValue) * 100),
          minRedeemPoints: Number(f.minRedeemPoints),
        })
      }
    >
      <div className="flex items-center justify-between rounded-lg border border-slate-200 p-3 dark:border-white/10">
        <span className="text-sm font-medium">Programme on</span>
        <Switch
          checked={f.isEnabled}
          onChange={(v) => set({ isEnabled: v })}
          label="Programme on"
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Points per ₹100">
          <input
            type="number"
            min="0"
            max="1000"
            required
            className={input}
            value={f.pointsPer100}
            onChange={(e) => set({ pointsPer100: e.target.value })}
          />
        </Field>
        <Field label="1 point is worth (₹)">
          <input
            type="number"
            min="0.01"
            step="0.01"
            required
            className={input}
            value={f.pointValue}
            onChange={(e) => set({ pointValue: e.target.value })}
          />
        </Field>
        <Field label="Minimum to redeem">
          <input
            type="number"
            min="0"
            required
            className={input}
            value={f.minRedeemPoints}
            onChange={(e) => set({ minRedeemPoints: e.target.value })}
          />
        </Field>
      </div>
      <p className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-white/5">
        Customers get back <strong>{Number.isFinite(rewardPct) ? rewardPct.toFixed(1) : 0}%</strong>{' '}
        of what they spend as rewards. 2–5% is typical.
      </p>
    </FormDialog>
  );
}

function PointsForm({
  d,
  member,
  kind,
  onClose,
}: {
  d: Loyalty;
  member: Member;
  kind: 'redeem' | 'adjust';
  onClose: () => void;
}) {
  const w = useOpsWrite();
  const [pts, setPts] = useState(kind === 'redeem' ? String(member.balance) : '');
  const [reason, setReason] = useState(kind === 'redeem' ? 'Redeemed on bill' : '');
  return (
    <FormDialog
      open
      onClose={onClose}
      title={`${kind === 'redeem' ? 'Redeem points' : 'Adjust points'} · ${member.name ?? member.phone}`}
      description={`Balance ${member.balance} points (${money(member.balanceValueMinor, d.currencyCode)}).`}
      submitLabel={kind === 'redeem' ? 'Redeem' : 'Save'}
      onSubmit={() =>
        w.send(`/loyalty/customers/${member.id}/points`, 'POST', {
          restaurantId: d.restaurantId,
          kind,
          points: Number(pts),
          reason,
        })
      }
    >
      <Field
        label={kind === 'redeem' ? 'Points to redeem' : 'Points to add (use − to remove)'}
        hint={
          kind === 'redeem' && pts
            ? `Give a discount of ${money(Number(pts) * d.program.pointValueMinor, d.currencyCode)} on the bill.`
            : undefined
        }
      >
        <input
          type="number"
          required
          min={kind === 'redeem' ? d.program.minRedeemPoints || 1 : undefined}
          max={kind === 'redeem' ? member.balance : undefined}
          className={input}
          value={pts}
          onChange={(e) => setPts(e.target.value)}
        />
      </Field>
      <Field label="Reason">
        <input
          required
          minLength={2}
          maxLength={200}
          className={input}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      {kind === 'redeem' ? (
        <p className="text-xs text-muted-foreground">
          Apply the discount on the POS bill; this records the points as spent.
        </p>
      ) : null}
    </FormDialog>
  );
}
