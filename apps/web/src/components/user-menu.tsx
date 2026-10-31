'use client';

import { useAppStore } from '@/stores/app-store';

/** Placeholder user area until authentication lands in Phase 3. */
export function UserMenu() {
  const branchName = useAppStore((state) => state.activeBranchName);
  return (
    <div className="flex items-center gap-3">
      <div className="hidden text-right sm:block">
        <p className="text-sm font-medium leading-tight">Guest user</p>
        <p className="text-xs text-muted-foreground">{branchName ?? 'No branch selected'}</p>
      </div>
      <span className="flex size-9 items-center justify-center rounded-full bg-secondary text-sm font-medium text-secondary-foreground">
        GU
      </span>
    </div>
  );
}
