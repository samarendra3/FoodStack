'use client';

import { useState } from 'react';
import { useProfile } from '@/components/auth/auth-provider';
import { RequireAuth } from '@/components/auth/require-auth';
import { canAccessPath } from '@/lib/auth/access';
import { TicketBoard } from './kitchen-board';
import { useKitchenFeed, useNewTicketChime } from './kitchen-feed';
import { KitchenEmptyState, KitchenError, SummaryCards, TicketSkeletons } from './kitchen-overview';
import { KitchenShell } from './kitchen-shell';

export default function KitchenPage() {
  return (
    <RequireAuth>
      <KitchenDisplay />
    </RequireAuth>
  );
}

function KitchenDisplay() {
  const profile = useProfile();
  const [branchId, setBranchId] = useState(profile.branches[0]?.id ?? '');
  const feed = useKitchenFeed(branchId);
  const { muted, setMuted } = useNewTicketChime(feed.tickets);
  const canManage = canAccessPath(profile, '/restaurant/dashboard');

  return (
    <KitchenShell
      branchId={branchId}
      onBranch={setBranchId}
      connection={feed.connection}
      muted={muted}
      onMuted={setMuted}
    >
      <div className="mx-auto max-w-[110rem] space-y-5 p-4 sm:p-6">
        <SummaryCards
          tickets={feed.tickets}
          connection={feed.connection}
          isLoading={feed.isLoading}
        />
        {feed.error ? <KitchenError message={feed.error} /> : null}
        {feed.isLoading ? (
          <TicketSkeletons />
        ) : feed.tickets.length > 0 ? (
          <TicketBoard feed={feed} />
        ) : (
          <KitchenEmptyState connection={feed.connection} canManage={canManage} />
        )}
      </div>
    </KitchenShell>
  );
}
