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
  badge: PlanBadge | null;
  planType: PlanType;
  ctaLabel: string | null;
  billingCycles: BillingCycles;
  allowTrial: boolean;
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
  /** Every line for the plan card, included or not, in display order. */
  featureItems: FeatureItem[];
  featureFlags: Partial<Record<FeatureKey, boolean>>;
  sortOrder: number;
}

export type PlanBadge = 'popular' | 'recommended' | 'best_value';
export type PlanType = 'free_trial' | 'paid' | 'enterprise';
export type BillingCycles = 'monthly' | 'yearly' | 'both';
export interface FeatureItem {
  label: string;
  enabled: boolean;
}

export const PLAN_TYPE_LABEL: Record<PlanType, string> = {
  free_trial: 'Free Trial',
  paid: 'Paid',
  enterprise: 'Enterprise',
};

/** Whether the plan can be bought in this cycle (the Free Trial starts on its own). */
export const sellsCycle = (
  p: Pick<PublicPlan, 'planType' | 'billingCycles'>,
  c: 'monthly' | 'yearly',
) => p.planType !== 'free_trial' && (p.billingCycles === 'both' || p.billingCycles === c);

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

export const BADGE_LABEL: Record<PlanBadge, string> = {
  popular: 'Most popular',
  recommended: 'Recommended',
  best_value: 'Best value',
};

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

/**
 * Lines for a plan card: limits first, then the Super Admin's feature lines in their order.
 * Excluded features are kept (enabled: false) so cards can show them as not included.
 */
export function planHighlights(p: PublicPlan): FeatureItem[] {
  const limits = [
    limitLabel(p.limits.branches, 'branch', 'branches'),
    limitLabel(p.limits.staff, 'team member', 'team members'),
    limitLabel(p.limits.ordersPerMonth, 'order / month', 'orders / month'),
    limitLabel(p.limits.menuItems, 'menu item', 'menu items'),
  ].map((label) => ({ label, enabled: true }));
  const features = p.featureItems?.length
    ? p.featureItems
    : p.features.map((label) => ({ label, enabled: true }));
  return [...limits, ...features];
}

/** Button text: the Super Admin's custom label, else a sensible default. */
export function planCta(p: PublicPlan): string {
  if (p.ctaLabel) return p.ctaLabel;
  if (p.customPricing) return 'Contact sales';
  if (p.planType === 'free_trial' || p.allowTrial) return `Start ${p.trialDays}-day free trial`;
  return 'Choose plan';
}

/** The cycle to show when the visitor picked `wanted` (falls back to the one the plan sells). */
export function cycleFor(p: PublicPlan, wanted: 'monthly' | 'yearly'): 'monthly' | 'yearly' {
  return p.billingCycles === 'yearly' || p.billingCycles === 'monthly' ? p.billingCycles : wanted;
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
