'use client';

import { useOps } from './ops-kit';

/** Stock items with quantities at a branch (GET /inventory), for the procurement screens. */
export interface StockRow {
  id: string;
  name: string;
  unit: string;
  quantity: number;
  costPerUnitMinor: number | null;
}
export function useStock(branchId: string | null) {
  return useOps<{
    items: StockRow[];
    branch: { id: string; name: string };
    branches: { id: string; name: string }[];
  }>(branchId === null ? null : `/inventory${branchId ? `?branchId=${branchId}` : ''}`);
}
