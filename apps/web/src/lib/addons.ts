'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { hasPermissionAnywhere } from '@/lib/auth/access';
import type { Invoice } from '@/lib/billing';

/**
 * Subscription add-ons as the server computes them. Prices, quantities, the order allowance and
 * remaining orders all come from the API; nothing here is hardcoded or trusted from the browser.
 */
export type AddonType = 'orders' | 'branches' | 'staff' | 'storage';
export type AddonValidity = 'current_cycle' | 'fixed_days' | 'custom';

export interface AddonPackage {
  id: string;
  code: string;
  name: string;
  description: string | null;
  addonType: AddonType;
  quantity: number;
  priceMinor: number;
  currencyCode: string;
  validity: AddonValidity;
  validityDays: number | null;
  validUntil: string | null;
  isPopular: boolean;
  sortOrder: number;
}

export interface AdminAddonPackage extends AddonPackage {
  isActive: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderAllowance {
  planLimit: number | null;
  addonOrders: number;
  total: number | null;
  used: number;
  remaining: number | null;
  percent: number;
  warning?: 80 | 90 | 100 | null;
}

export interface AddonPurchase {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  name: string;
  addonType: AddonType;
  quantity: number;
  priceMinor: number;
  startsAt: string;
  expiresAt: string;
  status: 'active' | 'expired' | 'revoked';
  revokeReason: string | null;
  used: number | null;
  remaining: number | null;
}

export interface AddonMarketplace {
  canManage: boolean;
  hasAccess: boolean;
  orders: OrderAllowance;
  packages: AddonPackage[];
  purchases: AddonPurchase[];
  pendingInvoice: Invoice | null;
}

export const ADDON_TYPE_LABEL: Record<AddonType, string> = {
  orders: 'Extra orders',
  branches: 'Extra branches',
  staff: 'Extra staff',
  storage: 'Extra storage',
};

export const ADDON_UNIT: Record<AddonType, [string, string]> = {
  orders: ['order', 'orders'],
  branches: ['branch', 'branches'],
  staff: ['staff member', 'staff members'],
  storage: ['MB', 'MB'],
};

export function addonQuantity(type: AddonType, n: number) {
  const [one, many] = ADDON_UNIT[type];
  return `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
}

const dateFmt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' });

export function validityLabel(p: Pick<AddonPackage, 'validity' | 'validityDays' | 'validUntil'>) {
  if (p.validity === 'fixed_days') return `Valid ${p.validityDays} days from purchase`;
  if (p.validity === 'custom' && p.validUntil)
    return `Valid until ${dateFmt.format(new Date(p.validUntil))}`;
  return 'Valid until the end of your billing cycle';
}

/** The marketplace, refetched on focus so a confirmed payment shows up without a reload. */
export function useAddonMarketplace(enabled = true) {
  const { client } = useAuth();
  const profile = useProfile();
  return useQuery({
    queryKey: ['billing', profile.activeTenant?.id, 'addons'],
    queryFn: () => client.request<AddonMarketplace>('/billing/addons'),
    enabled: enabled && hasPermissionAnywhere(profile, 'restaurant:read'),
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });
}

/**
 * Only the monthly order allowance, for the usage banner shown on every Restaurant Admin page.
 * Cheap on the server and cached for a minute here, so page navigation does not refetch it;
 * window focus and add-on purchases (shared 'billing' key prefix) refresh it.
 */
export function useOrderUsage(enabled = true) {
  const { client } = useAuth();
  const profile = useProfile();
  return useQuery({
    queryKey: ['billing', profile.activeTenant?.id, 'usage'],
    queryFn: () => client.request<{ orders: OrderAllowance }>('/billing/usage'),
    enabled: enabled && hasPermissionAnywhere(profile, 'restaurant:read'),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useRequestAddon() {
  const { client } = useAuth();
  const profile = useProfile();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (packageId: string) =>
      client.request<Invoice>(`/billing/addons/${packageId}/requests`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['billing', profile.activeTenant?.id] }),
  });
}
