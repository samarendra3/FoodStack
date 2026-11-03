'use client';

import { MonitorSmartphone } from 'lucide-react';
import { WorkspacePage } from '@/components/workspace/workspace-page';
import { PosTerminal } from './pos-terminal';

export default function PosPage() {
  return (
    <WorkspacePage title="Point of sale" icon={<MonitorSmartphone />}>
      <PosTerminal />
    </WorkspacePage>
  );
}
