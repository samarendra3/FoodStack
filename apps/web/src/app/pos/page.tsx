'use client';

import { MonitorSmartphone } from 'lucide-react';
import { WorkspacePage } from '@/components/workspace/workspace-page';

export default function PosPage() {
  return (
    <WorkspacePage
      title="Point of sale"
      icon={<MonitorSmartphone />}
      emptyTitle="The POS is being set up"
      emptyDescription="Your sign-in and branch access are ready. Order taking, billing and payments arrive with the POS release."
    />
  );
}
