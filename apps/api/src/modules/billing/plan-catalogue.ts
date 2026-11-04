/**
 * The plan catalogue: one row shape and three views of it.
 * - planDto: everything, for Super Admins.
 * - publicPlanDto: what the landing page and restaurants see. Allow-listed fields only, so
 *   internal columns added later never leak.
 * - planSnapshot: the terms a customer agreed to, frozen on the subscription when paid.
 */

/** Plan-specific feature availability keys (stable identifiers; labels live in the UI). */
export const FEATURE_KEYS = [
  'pos',
  'qr_ordering',
  'kitchen_display',
  'waiter_app',
  'inventory',
  'advanced_reports',
  'multi_branch',
  'custom_roles',
  'api_access',
  'priority_support',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const PLAN_ICONS = ['rocket', 'sparkles', 'building', 'store', 'crown'] as const;
export const PLAN_BADGES = ['popular', 'recommended'] as const;

export interface PlanRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  currency_code: string;
  price_monthly_minor: string | null;
  price_yearly_minor: string | null;
  max_branches: number | null;
  max_staff: number | null;
  max_orders_per_month: number | null;
  max_menu_items: number | null;
  max_storage_mb: number | null;
  features: string[];
  feature_flags: Partial<Record<FeatureKey, boolean>>;
  trial_days: number;
  is_active: boolean;
  is_public: boolean;
  badge: (typeof PLAN_BADGES)[number] | null;
  icon: (typeof PLAN_ICONS)[number];
  custom_pricing: boolean;
  sort_order: number;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const num = (v: string | null) => (v === null ? null : Number(v));

/** Savings of paying yearly vs 12 monthly payments, in whole percent (0 when none). */
export function yearlySavingsPercent(monthly: number | null, yearly: number | null): number {
  if (!monthly || yearly === null) return 0;
  const full = monthly * 12;
  return yearly < full ? Math.round(((full - yearly) / full) * 100) : 0;
}

export function publicPlanDto(p: PlanRow) {
  const monthly = num(p.price_monthly_minor);
  const yearly = num(p.price_yearly_minor);
  return {
    id: p.id,
    slug: p.code,
    code: p.code,
    name: p.name,
    description: p.description,
    icon: p.icon,
    badge: p.badge,
    currencyCode: p.currency_code.trim(),
    customPricing: p.custom_pricing,
    priceMonthlyMinor: monthly,
    priceYearlyMinor: yearly,
    yearlySavingsPercent: yearlySavingsPercent(monthly, yearly),
    trialDays: p.trial_days,
    limits: {
      branches: p.max_branches,
      staff: p.max_staff,
      ordersPerMonth: p.max_orders_per_month,
      menuItems: p.max_menu_items,
      storageMb: p.max_storage_mb,
    },
    features: p.features,
    featureFlags: p.feature_flags,
    sortOrder: p.sort_order,
  };
}

export function planDto(p: PlanRow) {
  return {
    ...publicPlanDto(p),
    isActive: p.is_active,
    isPublic: p.is_public,
    archivedAt: p.archived_at ? new Date(p.archived_at).toISOString() : null,
    createdAt: new Date(p.created_at).toISOString(),
    updatedAt: new Date(p.updated_at).toISOString(),
  };
}

export interface PlanSnapshot {
  planId: string;
  code: string;
  name: string;
  currencyCode: string;
  billingCycle: 'monthly' | 'yearly';
  priceMinor: number;
  limits: {
    branches: number | null;
    staff: number | null;
    ordersPerMonth: number | null;
    menuItems: number | null;
    storageMb: number | null;
  };
  features: string[];
  featureFlags: Partial<Record<FeatureKey, boolean>>;
}

/** Terms frozen on the subscription; priceMinor is what was actually invoiced. */
export function planSnapshot(
  p: PlanRow,
  cycle: 'monthly' | 'yearly',
  priceMinor: number,
): PlanSnapshot {
  const dto = publicPlanDto(p);
  return {
    planId: p.id,
    code: p.code,
    name: p.name,
    currencyCode: dto.currencyCode,
    billingCycle: cycle,
    priceMinor,
    limits: dto.limits,
    features: p.features,
    featureFlags: p.feature_flags,
  };
}

/** SQL filter for plans offered to new customers. */
export const OFFERED_SQL = 'is_active AND is_public AND archived_at IS NULL';
