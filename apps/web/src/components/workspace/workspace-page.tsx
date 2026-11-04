'use client';

import { EmptyState } from '@foodstack/ui/components/empty-state';
import { Logo } from '@foodstack/ui/components/logo';
import { MapPin } from 'lucide-react';
import Link from 'next/link';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { AccountMenu } from '@/components/account-menu';
import { useProfile } from '@/components/auth/auth-provider';
import { RequireAuth } from '@/components/auth/require-auth';
import { canAccessPath } from '@/lib/auth/access';

interface WorkspacePageProps {
  title: string;
  icon: ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  /** The operational screen; when omitted, an empty state explains what is coming. */
  children?: ReactNode;
}

/**
 * Full-screen staff workspace (POS, kitchen display, waiter). Shows the signed-in user and the
 * branches they may work in; the operational screens arrive with their modules.
 */
const BranchContext = createContext<string>('');

/** The branch picked in the workspace header (POS, waiter, kitchen screens). */
export function useWorkspaceBranch(): string {
  return useContext(BranchContext);
}

export function WorkspacePage(props: WorkspacePageProps) {
  return (
    <RequireAuth>
      <Workspace {...props} />
    </RequireAuth>
  );
}

function Workspace({ title, icon, emptyTitle, emptyDescription, children }: WorkspacePageProps) {
  const profile = useProfile();
  const [branchId, setBranchId] = useState(profile.branches[0]?.id ?? '');
  const canManage = canAccessPath(profile, '/restaurant/dashboard');

  return (
    <div
      className={
        children ? 'flex h-dvh flex-col bg-muted/30' : 'flex min-h-dvh flex-col bg-muted/30'
      }
    >
      <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center justify-between gap-3 bg-sidebar px-4 text-sidebar-foreground sm:px-6">
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <Logo inverted className="hidden sm:inline-flex" />
          <span className="hidden h-6 w-px bg-white/10 sm:block" aria-hidden />
          <span className="flex items-center gap-2 font-medium text-white [&_svg]:size-5 [&_svg]:text-emerald-300">
            {icon}
            {title}
          </span>
          {profile.activeTenant ? (
            <>
              <span className="hidden h-6 w-px bg-white/10 lg:block" aria-hidden />
              <span className="hidden truncate text-sm text-slate-300 lg:block">
                {profile.activeTenant.name}
              </span>
            </>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          {profile.branches.length > 1 ? (
            <label className="hidden items-center gap-2 text-sm md:flex">
              <MapPin className="size-4 text-slate-400" aria-hidden />
              <span className="sr-only">Branch</span>
              <select
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                className="h-9 rounded-md border border-white/10 bg-white/5 px-2 text-sm text-white"
              >
                {profile.branches.map((b) => (
                  <option key={b.id} value={b.id} className="text-foreground">
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          ) : profile.branches[0] ? (
            <span className="hidden items-center gap-1.5 text-sm text-slate-300 md:flex">
              <MapPin className="size-4 text-slate-400" aria-hidden />
              {profile.branches[0].name}
            </span>
          ) : null}
          <AccountMenu inverted />
        </div>
      </header>
      {children ? (
        <main className="flex min-h-0 flex-1 flex-col">
          <BranchContext.Provider value={branchId}>{children}</BranchContext.Provider>
        </main>
      ) : (
        <main className="flex flex-1 items-center justify-center p-4 sm:p-8">
          <EmptyState
            className="w-full max-w-lg bg-card"
            icon={icon}
            title={emptyTitle ?? title}
            description={emptyDescription}
            action={
              canManage ? (
                <Link
                  href="/restaurant/dashboard"
                  className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                >
                  Go to restaurant dashboard
                </Link>
              ) : undefined
            }
          />
        </main>
      )}
    </div>
  );
}
