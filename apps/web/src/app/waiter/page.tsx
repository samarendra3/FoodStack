'use client';

import { ConciergeBell } from 'lucide-react';
import { WorkspacePage } from '@/components/workspace/workspace-page';

export default function WaiterPage() {
  return (
    <WorkspacePage
      title="Waiter"
      icon={<ConciergeBell />}
      emptyTitle="The waiter app is being set up"
      emptyDescription="Your sign-in and branch access are ready. Tables and order taking arrive with the dining module."
    />
  );
}
