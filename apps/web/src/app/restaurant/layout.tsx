import type { ReactNode } from 'react';
import { RequireAuth } from '@/components/auth/require-auth';
import { RestaurantShell } from './restaurant-shell';

export default function RestaurantLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <RestaurantShell>{children}</RestaurantShell>
    </RequireAuth>
  );
}
