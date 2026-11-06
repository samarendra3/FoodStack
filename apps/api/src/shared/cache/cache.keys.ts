/**
 * Cache namespaces. A namespace is the unit of invalidation (one version counter); entries live
 * inside it. Tenant data namespaces always start with the tenant and restaurant ids, taken from
 * the authenticated context after the permission check — never from raw user input.
 *
 * Keys are not an authorization mechanism: callers check access first, then look up the cache.
 */

const SEGMENT = /^[A-Za-z0-9_-]{1,80}$/;

/** Rejects anything that could change a key's shape (":" "*" spaces, empty, absurdly long). */
export function seg(value: string | null | undefined, what = 'key segment'): string {
  if (!value || !SEGMENT.test(value)) {
    throw new Error(`Invalid cache ${what}: ${JSON.stringify(value)?.slice(0, 40)}`);
  }
  return value;
}

export type CacheNamespace = string & { readonly __brand: 'CacheNamespace' };

const ns = (value: string) => value as CacheNamespace;

export const CacheNs = {
  /** Menu catalogue and categories of one restaurant. */
  menu: (tenantId: string, restaurantId: string) =>
    ns(`tenant:${seg(tenantId, 'tenant')}:restaurant:${seg(restaurantId, 'restaurant')}:menu`),
  /** Inventory aggregates of one restaurant (entries are per branch). */
  inventory: (tenantId: string, restaurantId: string) =>
    ns(`tenant:${seg(tenantId, 'tenant')}:restaurant:${seg(restaurantId, 'restaurant')}:inventory`),
  /** Public plan catalogue (not tenant data). */
  plans: () => ns('global:plans'),
  /**
   * Sales analytics of one tenant. Tenant-wide (not per restaurant) so every order write can
   * invalidate it from the tenant id alone; entries carry the restaurant and branch set.
   */
  analytics: (tenantId: string) => ns(`tenant:${seg(tenantId, 'tenant')}:analytics`),
  /** Super Admin platform analytics (platform-owned data only). */
  platformAnalytics: () => ns('global:platform-analytics'),
} as const;

export const CacheEntry = {
  menuCatalogue: 'catalogue',
  menuCategories: 'categories',
  inventorySummary: (branchId: string) => `branch:${seg(branchId, 'branch')}:summary`,
  publicPlans: 'public:list',
  publicPlan: (slug: string) => `public:slug:${seg(slug, 'slug')}`,
  /** `digest`: 32-hex hash of the authorised scope and filters (analytics-scope.ts). */
  analytics: (kind: string, digest: string) => `${seg(kind, 'kind')}:h${seg(digest, 'digest')}`,
  platformAnalytics: 'overview',
} as const;

/** Metric label for an entry name: drops ids so metrics have bounded cardinality. */
export function metricName(ns: CacheNamespace, entry: string): string {
  const area = ns.split(':').at(-1)!;
  return `${area}:${entry.replace(/:h[0-9a-f]{32}$/, ':scope').replace(/[0-9a-f-]{36}|slug:[^:]+/g, (m) => (m.startsWith('slug') ? 'slug' : 'id'))}`;
}
