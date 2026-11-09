'use client';

import { useProfile } from '@/components/auth/auth-provider';
import { canAccessPath } from '@/lib/auth/access';
import { TicketBoard } from './kitchen-board';
import { KitchenFrame } from './kitchen-frame';
import { KitchenEmptyState, KitchenError, SummaryCards, TicketSkeletons } from './kitchen-overview';

export default function KitchenPage() {
  return <KitchenFrame>{({ feed }) => <KitchenDisplay feed={feed} />}</KitchenFrame>;
}

function KitchenDisplay({ feed }: { feed: Parameters<typeof TicketBoard>[0]['feed'] }) {
  const profile = useProfile();
  const canManage = canAccessPath(profile, '/restaurant/dashboard');

  return (
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
  );
}
