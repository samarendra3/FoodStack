import type { ReactNode } from 'react';
import { RequireAuth } from '@/components/auth/require-auth';
import { PlatformShell } from './platform-shell';

export default function PlatformLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <PlatformShell>{children}</PlatformShell>
    </RequireAuth>
  );
}
