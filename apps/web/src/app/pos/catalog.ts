'use client';

import type { AddonGroup } from '@/lib/cart-line';
import { authErrorMessage } from '@/lib/auth/errors';
import { useWorkspaceBranch } from '@/components/workspace/workspace-page';
import { useMenu } from '@/lib/menu';
import { useTables } from '@/lib/tables';

/*
 * POS catalogue. Items come from the restaurant's live menu (GET /menu): hidden categories and
 * their items are left out, sold-out items show but cannot be added. Tables are the branch's
 * real tables (GET /tables) with live occupancy; sample tables only while none are set up.
 */

export type Diet = 'veg' | 'non-veg' | 'egg';

export interface PosItem {
  id: string;
  name: string;
  category: string;
  /** Major units (rupees), as used by the order maths. */
  price: number;
  diet: Diet;
  imageUrl?: string;
  available: boolean;
  badge?: 'Popular' | 'New';
  /** Portions (e.g. Full / Half) in major units; empty for single-price items. */
  variants: { id: string; name: string; price: number }[];
  /** Add-on groups, prices in minor units as served by the menu API. */
  addonGroups: AddonGroup[];
}

export interface PosTable {
  id: string;
  label: string;
  occupied: boolean;
}

export interface PosCatalog {
  items: PosItem[];
  categories: string[];
  tables: PosTable[];
  isLoading: boolean;
  error: string | null;
  tablesAreSample: boolean;
}

const SAMPLE_TABLES: PosTable[] = Array.from({ length: 12 }, (_, i) => ({
  id: `t${i + 1}`,
  label: `T${i + 1}`,
  occupied: false,
}));

export function usePosCatalog(): PosCatalog {
  const branchId = useWorkspaceBranch() || undefined;
  const menu = useMenu(branchId);
  const real = useTables(branchId).data?.tables ?? [];
  const tables: PosTable[] = real.map((t) => ({
    id: t.id,
    label: t.label,
    occupied: t.status === 'occupied',
  }));
  const active = (menu.data?.categories ?? []).filter((c) => c.isActive);
  const names = new Map(active.map((c) => [c.id, c.name]));
  const items = (menu.data?.items ?? [])
    .filter((i) => names.has(i.categoryId))
    .map((i): PosItem => ({
      id: i.id,
      name: i.name,
      category: names.get(i.categoryId)!,
      price: i.priceMinor / 100,
      diet: i.diet === 'non_veg' ? 'non-veg' : i.diet,
      imageUrl: i.imageUrl ?? undefined,
      available: i.isAvailable,
      variants: i.variants.map((v) => ({ id: v.id, name: v.name, price: v.priceMinor / 100 })),
      addonGroups: i.addonGroups ?? [],
    }));

  return {
    items,
    categories: active.map((c) => c.name),
    tables: tables.length ? tables : SAMPLE_TABLES,
    isLoading: menu.isPending,
    error: menu.isError ? authErrorMessage(menu.error) : null,
    tablesAreSample: tables.length === 0,
  };
}
