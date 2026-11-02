'use client';

import { ChefHat } from 'lucide-react';
import { WorkspacePage } from '@/components/workspace/workspace-page';

export default function KitchenPage() {
  return (
    <WorkspacePage
      title="Kitchen display"
      icon={<ChefHat />}
      emptyTitle="The kitchen display is being set up"
      emptyDescription="Your sign-in and branch access are ready. Live kitchen tickets arrive with the kitchen module."
    />
  );
}
