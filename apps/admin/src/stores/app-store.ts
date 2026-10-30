import { create } from 'zustand';

/** Client-only UI state. Server data belongs in TanStack Query, not here. */
interface AppState {
  activeBranchId: string | null;
  activeBranchName: string | null;
  setActiveBranch: (branch: { id: string; name: string } | null) => void;
}

export const useAppStore = create<AppState>()((set) => ({
  activeBranchId: null,
  activeBranchName: null,
  setActiveBranch: (branch) =>
    set({ activeBranchId: branch?.id ?? null, activeBranchName: branch?.name ?? null }),
}));
