import { create } from 'zustand';

/** Terminal UI state only. Orders and carts move to the offline store in Phase 5. */
interface PosUiState {
  selectedCategory: string;
  selectCategory: (category: string) => void;
}

export const usePosUiStore = create<PosUiState>()((set) => ({
  selectedCategory: 'All',
  selectCategory: (selectedCategory) => set({ selectedCategory }),
}));
