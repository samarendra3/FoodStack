'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth, useProfile } from '@/components/auth/auth-provider';

export const UNITS = ['kg', 'g', 'l', 'ml', 'pcs', 'pack', 'box', 'dozen'] as const;
export type Unit = (typeof UNITS)[number];
export type MovementType = 'purchase' | 'usage' | 'wastage' | 'count';
export type StockStatus = 'ok' | 'low' | 'out';

export interface StockItem {
  id: string;
  name: string;
  category: string | null;
  unit: Unit;
  lowStockThreshold: number;
  costPerUnitMinor: number | null;
  isActive: boolean;
  quantity: number;
  status: StockStatus;
  stockUpdatedAt: string | null;
}

export interface InventoryData {
  restaurant: { id: string; name: string; currencyCode: string } | null;
  branch: { id: string; name: string };
  branches: { id: string; name: string }[];
  items: StockItem[];
  canManageItems: boolean;
  canRecordMovements: boolean;
}

export interface Movement {
  id: string;
  type: MovementType;
  quantityDelta: number;
  quantityAfter: number;
  note: string | null;
  createdAt: string;
  byName: string | null;
}

export interface StockItemInput {
  name: string;
  category: string | null;
  unit: Unit;
  lowStockThreshold: number;
  costPerUnitMinor: number | null;
}

const base = (tenantId?: string) => ['inventory', tenantId] as const;

/** Stock for one branch (the caller's first allowed branch when `branchId` is empty). */
export function useInventory(branchId: string | null) {
  const { client } = useAuth();
  const profile = useProfile();
  return useQuery({
    queryKey: [...base(profile.activeTenant?.id), branchId],
    queryFn: () =>
      client.request<InventoryData>(
        `/inventory${branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''}`,
      ),
    placeholderData: (prev) => prev,
  });
}

export function useMovements(itemId: string, branchId: string) {
  const { client } = useAuth();
  const profile = useProfile();
  return useQuery({
    queryKey: [...base(profile.activeTenant?.id), 'movements', itemId, branchId],
    queryFn: () =>
      client.request<Movement[]>(
        `/inventory/items/${itemId}/movements?branchId=${encodeURIComponent(branchId)}`,
      ),
  });
}

export function useInventoryMutations() {
  const { client } = useAuth();
  const profile = useProfile();
  const qc = useQueryClient();
  const done = {
    onSuccess: () => qc.invalidateQueries({ queryKey: base(profile.activeTenant?.id) }),
  };

  return {
    createItem: useMutation({
      mutationFn: (body: StockItemInput) =>
        client.request<{ id: string }>('/inventory/items', { method: 'POST', body }),
      ...done,
    }),
    updateItem: useMutation({
      mutationFn: ({ id, ...body }: Partial<StockItemInput> & { id: string; isActive?: boolean }) =>
        client.request<void>(`/inventory/items/${id}`, { method: 'PATCH', body }),
      ...done,
    }),
    deleteItem: useMutation({
      mutationFn: (id: string) =>
        client.request<void>(`/inventory/items/${id}`, { method: 'DELETE' }),
      ...done,
    }),
    move: useMutation({
      mutationFn: ({
        itemId,
        ...body
      }: {
        itemId: string;
        branchId: string;
        type: MovementType;
        quantity: number;
        note: string | null;
      }) =>
        client.request<{ id: string; quantity: number }>(`/inventory/items/${itemId}/movements`, {
          method: 'POST',
          body,
        }),
      ...done,
    }),
  };
}

export const formatQty = (n: number) =>
  new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 }).format(n);
