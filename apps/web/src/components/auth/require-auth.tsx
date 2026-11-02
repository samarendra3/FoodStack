'use client';

import { Loader2 } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { canAccessPath } from '@/lib/auth/access';
import { useAuth } from './auth-provider';

/**
 * Renders children only for a signed-in user allowed in this area; otherwise redirects to sign-in
 * or to the user's own home. A UX guard: the API authorizes every request regardless.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const allowed = state.status === 'authenticated' && canAccessPath(state.profile, pathname);

  useEffect(() => {
    if (state.status === 'anonymous') {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    } else if (state.status === 'authenticated' && !allowed) {
      const home = state.profile.homePath;
      router.replace(home === pathname ? '/no-access' : home);
    }
  }, [state, allowed, pathname, router]);

  if (!allowed) return <FullPageSpinner />;
  return <>{children}</>;
}

export function FullPageSpinner({ label = 'Loading your workspace…' }: { label?: string }) {
  return (
    <div
      className="flex min-h-dvh flex-col items-center justify-center gap-3 text-muted-foreground"
      role="status"
    >
      <Loader2 className="size-6 animate-spin text-primary" aria-hidden />
      <span className="text-sm">{label}</span>
    </div>
  );
}
