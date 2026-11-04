'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth, useProfile } from '@/components/auth/auth-provider';

/** GET /menu — one restaurant's menu, shared by the dashboard, POS and (later) waiter/QR. */
export type Diet = 'veg' | 'non_veg' | 'egg';

export interface MenuCategory {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  itemCount: number;
}

export interface MenuItem {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  /** Minor units (paise for INR). */
  priceMinor: number;
  currencyCode: string;
  diet: Diet;
  imageUrl: string | null;
  isAvailable: boolean;
  sortOrder: number;
  updatedAt: string;
  /** Portions such as Full / Half; empty when the item has a single price. */
  variants: MenuVariant[];
}

export interface MenuVariant {
  id: string;
  name: string;
  priceMinor: number;
}

export interface MenuData {
  restaurant: { id: string; name: string; currencyCode: string };
  categories: MenuCategory[];
  items: MenuItem[];
  canManage: boolean;
}

export interface ItemInput {
  categoryId: string;
  name: string;
  description: string | null;
  priceMinor: number;
  diet: Diet;
  imageUrl: string | null;
  isAvailable: boolean;
  variants?: { id?: string; name: string; priceMinor: number }[];
}

export interface ImportRow {
  category: string;
  name: string;
  priceMinor: number;
  diet: Diet;
  description: string | null;
  imageUrl: string | null;
  isAvailable: boolean;
  halfPriceMinor?: number | null;
}

export interface ImportResult {
  categoriesCreated: number;
  created: number;
  updated: number;
  skipped: number;
}

export const DIET_LABEL: Record<Diet, string> = { veg: 'Veg', non_veg: 'Non-veg', egg: 'Egg' };

export function menuKey(tenantId: string | undefined) {
  return ['menu', tenantId] as const;
}

export function useMenu() {
  const { client } = useAuth();
  const profile = useProfile();
  return useQuery({
    queryKey: menuKey(profile.activeTenant?.id),
    queryFn: () => client.request<MenuData>('/menu'),
  });
}

/** Categories with item counts (no items), for screens that page the items. */
export function useMenuCategories() {
  const { client } = useAuth();
  const profile = useProfile();
  return useQuery({
    queryKey: [...menuKey(profile.activeTenant?.id), 'categories'],
    queryFn: () =>
      client.request<{
        restaurant: MenuData['restaurant'];
        categories: MenuCategory[];
        itemCount: number;
        canManage: boolean;
      }>('/menu/categories'),
  });
}

/** Menu writes; every success refetches the menu so all screens stay in step. */
export function useMenuMutations() {
  const { client } = useAuth();
  const profile = useProfile();
  const qc = useQueryClient();
  const done = {
    onSuccess: () => qc.invalidateQueries({ queryKey: menuKey(profile.activeTenant?.id) }),
  };

  return {
    createCategory: useMutation({
      mutationFn: (name: string) =>
        client.request<{ id: string }>('/menu/categories', { method: 'POST', body: { name } }),
      ...done,
    }),
    updateCategory: useMutation({
      mutationFn: ({ id, ...body }: { id: string; name?: string; isActive?: boolean }) =>
        client.request<void>(`/menu/categories/${id}`, { method: 'PATCH', body }),
      ...done,
    }),
    deleteCategory: useMutation({
      mutationFn: (id: string) =>
        client.request<void>(`/menu/categories/${id}`, { method: 'DELETE' }),
      ...done,
    }),
    createItem: useMutation({
      mutationFn: (body: ItemInput) =>
        client.request<{ id: string }>('/menu/items', { method: 'POST', body }),
      ...done,
    }),
    updateItem: useMutation({
      mutationFn: ({ id, ...body }: Partial<ItemInput> & { id: string }) =>
        client.request<void>(`/menu/items/${id}`, { method: 'PATCH', body }),
      ...done,
    }),
    importItems: useMutation({
      mutationFn: (body: { onDuplicate: 'skip' | 'update'; rows: ImportRow[] }) =>
        client.request<ImportResult>('/menu/import', { method: 'POST', body }),
      ...done,
    }),
    deleteItem: useMutation({
      mutationFn: (id: string) => client.request<void>(`/menu/items/${id}`, { method: 'DELETE' }),
      ...done,
    }),
  };
}

export function formatMoney(minor: number, currency: string) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(minor / 100);
}
