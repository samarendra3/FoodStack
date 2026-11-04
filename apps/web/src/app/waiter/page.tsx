'use client';

import { RequireAuth } from '@/components/auth/require-auth';
import { WaiterSetup } from './waiter-setup';

export default function WaiterPage() {
  return (
    <RequireAuth>
      <WaiterSetup />
    </RequireAuth>
  );
}
