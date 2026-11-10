'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth, useProfile } from '@/components/auth/auth-provider';

/** GET /tables?branchId= — a branch's tables with live status from open orders. */
export interface DiningTable {
  id: string;
  area: string;
  label: string;
  seats: number;
  sortOrder: number;
  status: 'free' | 'occupied';
  openOrders: number;
  /** Separate bills open at this table. */
  bills: number;
  /** Running bill of the open orders, minor units. */
  openTotalMinor: number;
  /** When the oldest open order was placed. */
  since: string | null;
}

export interface TablesData {
  canManage: boolean;
  tables: DiningTable[];
}

function tablesKey(tenantId: string | undefined, branchId?: string) {
  return ['tables', tenantId, branchId ?? ''] as const;
}

/** Live: refreshes every 15 s and on focus, so status follows orders placed elsewhere. */
export function useTables(branchId: string | undefined) {
  const { client } = useAuth();
  const profile = useProfile();
  return useQuery({
    queryKey: tablesKey(profile.activeTenant?.id, branchId),
    queryFn: () => client.request<TablesData>(`/tables?branchId=${encodeURIComponent(branchId!)}`),
    enabled: Boolean(branchId),
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useTableMutations() {
  const { client } = useAuth();
  const profile = useProfile();
  const qc = useQueryClient();
  const onSettled = () => qc.invalidateQueries({ queryKey: ['tables', profile.activeTenant?.id] });
  return {
    create: useMutation({
      mutationFn: (body: { branchId: string; area: string; label: string; seats: number }) =>
        client.request<{ id: string }>('/tables', { method: 'POST', body }),
      onSettled,
    }),
    bulk: useMutation({
      mutationFn: (body: {
        branchId: string;
        area: string;
        prefix: string;
        from: number;
        to: number;
        seats: number;
      }) =>
        client.request<{ created: number; skipped: number }>('/tables/bulk', {
          method: 'POST',
          body,
        }),
      onSettled,
    }),
    update: useMutation({
      mutationFn: ({
        id,
        ...body
      }: {
        id: string;
        area?: string;
        label?: string;
        seats?: number;
      }) => client.request<void>(`/tables/${id}`, { method: 'PATCH', body }),
      onSettled,
    }),
    remove: useMutation({
      mutationFn: (id: string) => client.request<void>(`/tables/${id}`, { method: 'DELETE' }),
      onSettled,
    }),
  };
}
