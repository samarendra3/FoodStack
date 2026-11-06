/** Pure list-state helpers (no React), shared by usePagedList and tests. */

export const PAGE_SIZES = [10, 25, 50, 100] as const;

/** Offset page (total known; numbered pages). */
export interface OffsetPageMeta {
  pagination?: undefined;
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/** Keyset page: no total, opaque cursors to the neighbouring pages. */
export interface CursorPageMeta {
  pagination: 'cursor';
  limit: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  nextCursor: string | null;
  prevCursor: string | null;
}

export type PageMeta = OffsetPageMeta | CursorPageMeta;

export const isCursorMeta = (m: PageMeta | null | undefined): m is CursorPageMeta =>
  m?.pagination === 'cursor';

export interface ListState {
  page: number;
  limit: number;
  search: string;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  /** List-specific filters (status, branchId, from, to…); empty values are omitted. */
  filters: Record<string, string>;
  /** Cursor mode only: position of the current page (absent = first page). */
  cursor?: string;
}

const RESERVED = new Set([
  'page',
  'limit',
  'search',
  'sortBy',
  'sortOrder',
  'pagination',
  'cursor',
]);
const CURSOR_RE = /^[A-Za-z0-9_-]{1,512}$/;

export function readUrl(defaults: ListState, filterKeys: string[], cursorMode = false): ListState {
  if (typeof window === 'undefined') return defaults;
  const q = new URLSearchParams(window.location.search);
  const limit = Number(q.get('limit'));
  const filters = { ...defaults.filters };
  for (const k of filterKeys) {
    const v = q.get(k);
    if (v !== null) filters[k] = v;
  }
  const cursor = q.get('cursor');
  return {
    page: cursorMode ? 1 : Math.max(1, Number(q.get('page')) || defaults.page),
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
    ...(cursorMode && cursor && CURSOR_RE.test(cursor) ? { cursor } : {}),
  };
}

/**
 * Query string for the API (and the address bar): only non-default, non-empty values.
 * Cursor mode sends `pagination=cursor` (+ `cursor`) instead of `page`.
 */
export function toQuery(s: ListState, cursorMode = false): URLSearchParams {
  const q = new URLSearchParams();
  if (cursorMode) {
    q.set('pagination', 'cursor');
    if (s.cursor) q.set('cursor', s.cursor);
  } else {
    q.set('page', String(s.page));
  }
  q.set('limit', String(s.limit));
  if (s.search.trim()) q.set('search', s.search.trim());
  q.set('sortBy', s.sortBy);
  q.set('sortOrder', s.sortOrder);
  for (const [k, v] of Object.entries(s.filters)) if (v && !RESERVED.has(k)) q.set(k, v);
  return q;
}
