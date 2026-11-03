'use client';

import { authErrorMessage } from '@/lib/auth/errors';
import { useMenu } from '@/lib/menu';

/*
 * POS catalogue. Items come from the restaurant's live menu (GET /menu): hidden categories and
 * their items are left out, sold-out items show but cannot be added. Tables are still sample
 * data until the tables module ships (`tablesAreSample`).
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
  const menu = useMenu();
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
    }));

  return {
    items,
    categories: active.map((c) => c.name),
    tables: SAMPLE_TABLES,
    isLoading: menu.isPending,
    error: menu.isError ? authErrorMessage(menu.error) : null,
    tablesAreSample: true,
  };
}
