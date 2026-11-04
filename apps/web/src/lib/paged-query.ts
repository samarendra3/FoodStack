/** Pure list-state helpers (no React), shared by usePagedList and tests. */

export const PAGE_SIZES = [10, 25, 50, 100] as const;

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface ListState {
  page: number;
  limit: number;
  search: string;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  /** List-specific filters (status, branchId, from, to…); empty values are omitted. */
  filters: Record<string, string>;
}

const RESERVED = new Set(['page', 'limit', 'search', 'sortBy', 'sortOrder']);

export function readUrl(defaults: ListState, filterKeys: string[]): ListState {
  if (typeof window === 'undefined') return defaults;
  const q = new URLSearchParams(window.location.search);
  const limit = Number(q.get('limit'));
  const filters = { ...defaults.filters };
  for (const k of filterKeys) {
    const v = q.get(k);
    if (v !== null) filters[k] = v;
  }
  return {
    page: Math.max(1, Number(q.get('page')) || defaults.page),
    limit: (PAGE_SIZES as readonly number[]).includes(limit) ? limit : defaults.limit,
    search: q.get('search') ?? defaults.search,
    sortBy: q.get('sortBy') ?? defaults.sortBy,
    sortOrder:
      q.get('sortOrder') === 'asc'
        ? 'asc'
        : q.get('sortOrder') === 'desc'
          ? 'desc'
          : defaults.sortOrder,
    filters,
  };
}

/** Query string for the API (and the address bar): only non-default, non-empty values. */
export function toQuery(s: ListState): URLSearchParams {
  const q = new URLSearchParams();
  q.set('page', String(s.page));
  q.set('limit', String(s.limit));
  if (s.search.trim()) q.set('search', s.search.trim());
  q.set('sortBy', s.sortBy);
  q.set('sortOrder', s.sortOrder);
  for (const [k, v] of Object.entries(s.filters)) if (v && !RESERVED.has(k)) q.set(k, v);
  return q;
}
