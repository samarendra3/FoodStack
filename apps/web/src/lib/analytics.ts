'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useAuth, useProfile } from '@/components/auth/auth-provider';

/** Client for /analytics/* (apps/api/src/modules/analytics). All money is in minor units. */

export const PRESETS = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['last7', 'Last 7 days'],
  ['last30', 'Last 30 days'],
  ['thisMonth', 'This month'],
  ['lastMonth', 'Last month'],
  ['thisYear', 'This year'],
  ['custom', 'Custom range'],
] as const;
export type Preset = (typeof PRESETS)[number][0];

export const CHANNEL_LABEL: Record<string, string> = {
  dine_in: 'Dine-in',
  takeaway: 'Takeaway',
  delivery: 'Delivery',
  qr: 'QR order',
};
export const METHOD_LABEL: Record<string, string> = { cash: 'Cash', card: 'Card', upi: 'UPI' };

export interface Filters {
  preset: Preset;
  from?: string;
  to?: string;
  restaurantId?: string;
  branchId?: string;
  channel?: string;
  method?: string;
}

export interface Compared {
  value: number;
  previous: number;
  changePct: number | null;
}

interface Meta {
  restaurant: { id: string; name: string; currencyCode: string; timezone: string };
  restaurants: { id: string; name: string }[];
  branches: { id: string; name: string }[];
  branchIds: string[];
  timezone: string;
  currencyCode: string;
  range: {
    from: string;
    to: string;
    previousFrom: string;
    previousTo: string;
    days: number;
    partial: boolean;
  };
  generatedAt: string;
}

export interface Summary extends Meta {
  kpis: {
    totalRevenue: Compared;
    totalOrders: Compared;
    completedOrders: Compared;
    pendingOrders: { value: number };
    cancelledOrders: Compared;
    averageOrderValue: { value: number | null; previous: number | null; changePct: number | null };
    totalCustomers: Compared;
    activeTables: { value: number };
  };
  revenue: Record<
    | 'grossSales'
    | 'discounts'
    | 'netSales'
    | 'tax'
    | 'billedTotal'
    | 'collected'
    | 'refunds'
    | 'netCollected',
    Compared
  >;
  orders: Record<
    'total' | 'open' | 'completed' | 'cancelled' | 'pending' | 'preparing' | 'ready' | 'served',
    number
  >;
  byChannel: { channel: string; orders: number; completedOrders: number; netSalesMinor: number }[];
  byMethod: {
    method: string;
    collectedMinor: number;
    refundsMinor: number;
    netMinor: number;
    orders: number;
  }[];
}

export interface Trend extends Meta {
  granularity: 'hour' | 'day' | 'month';
  points: {
    bucket: string;
    netSales: number;
    completedOrders: number;
    ordersPlaced: number;
    cancelled: number;
    collected: number;
    refunds: number;
  }[];
}

export interface MenuItemRow {
  menuItemId: string;
  name: string;
  categoryName: string | null;
  deleted: boolean;
  quantity: number;
  revenue: number;
  orders: number;
}

export interface MenuStats extends Meta {
  totals: { itemsSold: number; distinctItems: number; revenueMinor: number };
  topSelling: MenuItemRow[];
  bestPerforming: MenuItemRow[];
  lowPerforming: MenuItemRow[] | null;
  lowPerformingNote: string | null;
  unsold: { id: string; name: string }[];
  categories: {
    categoryId: string;
    name: string;
    quantity: number;
    revenue: number;
    sharePct: number | null;
  }[];
  items: { sort: string; page: number; pageSize: number; total: number; rows: MenuItemRow[] };
}

export interface CustomerStats extends Meta {
  totalCustomers: Compared;
  newCustomers: number;
  returningCustomers: number;
  repeatCustomers: number;
  repeatPurchaseRatePct: number | null;
  averageSpendMinor: number | null;
  identifiedOrders: number;
  completedOrders: number;
  identifiedOrderSharePct: number | null;
}

export interface BranchStats extends Meta {
  branchCount: number;
  rows: {
    id: string;
    name: string;
    rank: number;
    sharePct: number | null;
    netSales: Compared;
    ordersPlaced: Compared;
    completedOrders: number;
    cancelledOrders: number;
    averageOrderValueMinor: number | null;
    collectedMinor: number;
    refundsMinor: number;
  }[];
}

type Kind = 'summary' | 'trend' | 'menu' | 'customers' | 'branches';

export function toQuery(filters: Filters, extra: Record<string, string | number> = {}) {
  const q = new URLSearchParams();
  q.set('preset', filters.preset);
  if (filters.preset === 'custom') {
    if (filters.from) q.set('from', filters.from);
    if (filters.to) q.set('to', filters.to);
  }
  for (const k of ['restaurantId', 'branchId', 'channel', 'method'] as const) {
    if (filters[k]) q.set(k, filters[k]!);
  }
  for (const [k, v] of Object.entries(extra)) q.set(k, String(v));
  return q.toString();
}

/** One analytics call; previous data stays on screen while filters change. */
export function useAnalytics<T>(
  kind: Kind,
  filters: Filters,
  extra: Record<string, string | number> = {},
  enabled = true,
) {
  const { client } = useAuth();
  const profile = useProfile();
  const ready = filters.preset !== 'custom' || Boolean(filters.from && filters.to);
  const qs = toQuery(filters, extra);
  return useQuery({
    queryKey: ['analytics', profile.activeTenant?.id, kind, qs],
    queryFn: () => client.request<T>(`/analytics/${kind}?${qs}`),
    enabled: enabled && ready,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function inr(minor: number, currency = 'INR') {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(Math.round(minor / 100));
}

export const count = (n: number) => new Intl.NumberFormat('en-IN').format(n);
