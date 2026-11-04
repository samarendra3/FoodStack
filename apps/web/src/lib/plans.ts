'use client';

import { useQuery } from '@tanstack/react-query';
import { Building2, Crown, Rocket, Sparkles, Store } from 'lucide-react';
import { api } from '@/lib/api';

/**
 * The plan catalogue as every surface sees it (GET /plans and the restaurant subscription page
 * return this same shape). Nothing about plans is hardcoded in the UI: names, prices, limits and
 * features all come from the Super Admin's catalogue.
 */
export interface PublicPlan {
  id: string;
  slug: string;
  code: string;
  name: string;
  description: string | null;
  icon: PlanIcon;
  badge: 'popular' | 'recommended' | null;
  currencyCode: string;
  customPricing: boolean;
  priceMonthlyMinor: number | null;
  priceYearlyMinor: number | null;
  yearlySavingsPercent: number;
  trialDays: number;
  limits: {
    branches: number | null;
    staff: number | null;
    ordersPerMonth: number | null;
    menuItems: number | null;
    storageMb: number | null;
  };
  features: string[];
  featureFlags: Partial<Record<FeatureKey, boolean>>;
  sortOrder: number;
}

export type PlanIcon = 'rocket' | 'sparkles' | 'building' | 'store' | 'crown';
export const PLAN_ICONS: Record<PlanIcon, typeof Rocket> = {
  rocket: Rocket,
  sparkles: Sparkles,
  building: Building2,
  store: Store,
  crown: Crown,
};

/** Display labels for the backend's feature keys (the keys themselves are defined by the API). */
export const FEATURE_LABELS = {
  pos: 'POS billing',
  qr_ordering: 'QR table ordering',
  kitchen_display: 'Kitchen display',
  waiter_app: 'Waiter app',
  inventory: 'Inventory & recipes',
  advanced_reports: 'Advanced reports',
  multi_branch: 'Multi-branch management',
  custom_roles: 'Custom roles',
  api_access: 'API access',
  priority_support: 'Priority support',
} as const;
export type FeatureKey = keyof typeof FEATURE_LABELS;

export const BADGE_LABEL = { popular: 'Most popular', recommended: 'Recommended' } as const;

export const formatMoney = (minor: number, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: minor % 100 ? 2 : 0,
  }).format(minor / 100);

/** "3 branches", "Unlimited staff", ... */
export function limitLabel(n: number | null, one: string, many: string) {
  return n === null ? `Unlimited ${many}` : `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
}

/** Bullet list for a plan card: limits first, then the Super Admin's feature lines. */
export function planHighlights(p: PublicPlan): string[] {
  return [
    limitLabel(p.limits.branches, 'branch', 'branches'),
    limitLabel(p.limits.staff, 'team member', 'team members'),
    limitLabel(p.limits.ordersPerMonth, 'order / month', 'orders / month'),
    ...(p.limits.menuItems !== null
      ? [limitLabel(p.limits.menuItems, 'menu item', 'menu items')]
      : []),
    ...p.features,
  ];
}

/** Public, unauthenticated pricing (landing page). Refetches so Super Admin edits show up. */
export function usePublicPlans() {
  return useQuery({
    queryKey: ['public-plans'],
    queryFn: () => api.request<PublicPlan[]>('/plans'),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}
