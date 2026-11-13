'use client';

import { cn } from '@foodstack/ui/lib/utils';
import type { ReactNode } from 'react';
import { useProfile } from '@/components/auth/auth-provider';
import { ThemeToggle } from '@/components/theme-toggle';
import { CARD, KitchenFrame } from '../kitchen-frame';
import { unlockAudio } from '@/lib/sound';
import { VolumeSlider } from '@/components/volume-slider';
import { chime } from '../kitchen-feed';
import { CONNECTION } from '../status';

export default function KitchenSettingsPage() {
  return (
    <KitchenFrame title="Settings">
      {({ feed, branchId, setBranchId, muted, setMuted }) => (
        <Settings
          branchId={branchId}
          setBranchId={setBranchId}
          muted={muted}
          setMuted={setMuted}
          connection={CONNECTION[feed.connection]}
        />
      )}
    </KitchenFrame>
  );
}

function Settings(p: {
  branchId: string;
  setBranchId: (id: string) => void;
  muted: boolean;
  setMuted: (m: boolean) => void;
  connection: (typeof CONNECTION)[keyof typeof CONNECTION];
}) {
  const profile = useProfile();

  return (
    <div className="mx-auto max-w-[110rem] space-y-4 p-4 sm:p-6">
      <section className={cn(CARD, 'max-w-3xl divide-y divide-slate-200 dark:divide-white/10')}>
        <Row
          title="New-order sound"
          hint="A rising three-note chime when a new order arrives (waiter, POS or QR)."
        >
          <VolumeSlider className="w-32" onChange={() => chime()} />
          <button
            type="button"
            onClick={() => {
              unlockAudio();
              setTimeout(chime, 80);
            }}
            className="h-8 rounded-md px-3 text-sm font-medium text-slate-600 ring-1 ring-slate-200 ring-inset hover:bg-slate-50 dark:text-slate-300 dark:ring-white/10 dark:hover:bg-white/5"
          >
            Test
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={!p.muted}
            aria-label="New-order sound"
            onClick={() => p.setMuted(!p.muted)}
            className={cn(
              'relative h-6 w-11 rounded-full transition-colors',
              p.muted ? 'bg-slate-300 dark:bg-white/20' : 'bg-emerald-600',
            )}
          >
            <span
              className={cn(
                'absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform',
                !p.muted && 'translate-x-5',
              )}
            />
          </button>
        </Row>

        <Row title="Branch" hint="Orders shown on every kitchen page. Remembered on this device.">
          <select
            value={p.branchId}
            onChange={(e) => p.setBranchId(e.target.value)}
            disabled={profile.branches.length < 2}
            aria-label="Branch"
            className="h-9 w-full min-w-0 rounded-md sm:w-56 border border-slate-200 bg-white px-3 text-sm dark:border-white/10 dark:bg-slate-900 dark:text-white"
          >
            {profile.branches.length === 0 ? <option value="">No branch</option> : null}
            {profile.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Row>

        <Row title="Theme" hint="Light or dark screen.">
          <ThemeToggle className="rounded-md text-slate-500 ring-1 ring-slate-200 ring-inset hover:bg-slate-100 dark:text-slate-300 dark:ring-white/10 dark:hover:bg-white/10" />
        </Row>

        <Row title="Connection" hint={p.connection.detail}>
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700 dark:text-slate-200">
            <span className={cn('size-2 rounded-full', p.connection.dot)} />
            {p.connection.label}
          </span>
        </Row>

        <Row title="Restaurant" hint="Orders refresh every 5 seconds while this screen is open.">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
            {profile.activeTenant?.name ?? '—'}
          </span>
        </Row>
      </section>
    </div>
  );
}

function Row({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-900 dark:text-white">{title}</p>
        <p className="text-xs text-slate-500 dark:text-slate-400">{hint}</p>
      </div>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
    </div>
  );
}
