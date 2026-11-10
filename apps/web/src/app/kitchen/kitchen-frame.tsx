'use client';

import { type ReactNode, useState } from 'react';
import { useProfile } from '@/components/auth/auth-provider';
import { RequireAuth } from '@/components/auth/require-auth';
import { type KitchenFeed, useKitchenFeed, useNewTicketChime } from './kitchen-feed';
import { KitchenShell } from './kitchen-shell';

const BRANCH_KEY = 'foodstack.kds.branch';

export interface KitchenContext {
  feed: KitchenFeed;
  branchId: string;
  setBranchId: (id: string) => void;
  muted: boolean;
  setMuted: (m: boolean) => void;
}

/**
 * Wraps every kitchen page: sign-in check, shell, live feed and new-order chime. The chosen
 * branch is remembered so it stays the same when moving between kitchen pages.
 */
export function KitchenFrame(p: { title?: string; children: (ctx: KitchenContext) => ReactNode }) {
  return (
    <RequireAuth>
      <Frame {...p} />
    </RequireAuth>
  );
}

function Frame({
  title,
  children,
}: {
  title?: string;
  children: (ctx: KitchenContext) => ReactNode;
}) {
  const profile = useProfile();
  const [branchId, setBranchState] = useState(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(BRANCH_KEY);
    } catch {
      /* storage unavailable */
    }
    return profile.branches.some((b) => b.id === saved)
      ? (saved as string)
      : (profile.branches[0]?.id ?? '');
  });
  const setBranchId = (id: string) => {
    setBranchState(id);
    try {
      localStorage.setItem(BRANCH_KEY, id);
    } catch {
      /* ignore */
    }
  };
  const feed = useKitchenFeed(branchId);
  const { muted, setMuted } = useNewTicketChime(feed.tickets);

  return (
    <KitchenShell
      branchId={branchId}
      onBranch={setBranchId}
      connection={feed.connection}
      muted={muted}
      onMuted={setMuted}
      title={title}
    >
      {/* The header hides the page title below md; show it here so phones know where they are. */}
      {title ? (
        <h2 className="px-4 pt-4 text-lg font-semibold text-slate-900 sm:px-6 md:hidden dark:text-white">
          {title}
        </h2>
      ) : null}
      {children({ feed, branchId, setBranchId, muted, setMuted })}
    </KitchenShell>
  );
}

/** Shared card style for the kitchen sub-pages. */
export const CARD =
  'rounded-xl border border-slate-200 bg-white dark:border-white/10 dark:bg-slate-900';

export const STATUS_LABEL = {
  new: 'New',
  accepted: 'Accepted',
  preparing: 'Preparing',
  ready: 'Ready',
  completed: 'Completed',
} as const;

export const STATUS_BADGE = {
  new: 'bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/15 dark:text-sky-300',
  accepted:
    'bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-500/15 dark:text-violet-300',
  preparing:
    'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-300',
  ready:
    'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-300',
  completed: 'bg-slate-100 text-slate-600 ring-slate-500/20 dark:bg-white/10 dark:text-slate-300',
} as const;

export function minutesSince(iso: string, now = Date.now()) {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
}
