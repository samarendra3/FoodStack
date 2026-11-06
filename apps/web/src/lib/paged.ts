'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { errorCode } from '@/lib/auth/errors';

import {
  type CursorPageMeta,
  isCursorMeta,
  type ListState,
  type OffsetPageMeta,
  type PageMeta,
  PAGE_SIZES,
  readUrl,
  toQuery,
} from './paged-query';

export {
  isCursorMeta,
  PAGE_SIZES,
  toQuery,
  type CursorPageMeta,
  type ListState,
  type OffsetPageMeta,
  type PageMeta,
};

/**
 * Server-side paged list: state lives in the URL (shareable, back-button friendly), search is
 * debounced, and the previous page stays on screen while the next one loads.
 *
 * `options.cursor` switches to keyset paging (large lists: orders, payments, stock movements,
 * invoices): Previous / Next follow server cursors, no total is counted, and every change of
 * filter, search, sort or page size starts again from the first page.
 */
export function usePagedList<T>(
  key: string,
  path: string,
  defaults: Partial<ListState> & { sortBy: string },
  options: { cursor?: boolean } = {},
) {
  const cursorMode = Boolean(options.cursor);
  const { client } = useAuth();
  const profile = useProfile();
  const base: ListState = useMemo(
    () => ({ page: 1, limit: 25, search: '', sortOrder: 'desc', filters: {}, ...defaults }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- defaults are fixed per screen
    [],
  );
  const filterKeys = Object.keys(base.filters);
  const [state, setState] = useState<ListState>(() => readUrl(base, filterKeys, cursorMode));
  const [debouncedSearch, setDebouncedSearch] = useState(state.search);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(state.search), 300);
    return () => clearTimeout(t);
  }, [state.search]);

  const effective = useMemo(
    () => ({ ...state, search: debouncedSearch }),
    [state, debouncedSearch],
  );
  const qs = toQuery(effective, cursorMode).toString();

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}?${qs}`);
    }
  }, [qs]);

  const query = useQuery({
    queryKey: [key, profile.activeTenant?.id, qs],
    queryFn: () => client.requestEnvelope<T[], PageMeta>(`${path}?${qs}`),
    placeholderData: keepPreviousData,
  });

  /** Changing anything but the page (or cursor) returns to the first page. */
  const update = useCallback(
    (patch: Partial<Omit<ListState, 'filters'>> & { filters?: Record<string, string> }) => {
      setState((s) => {
        const next: ListState = {
          ...s,
          ...patch,
          filters: patch.filters ? { ...s.filters, ...patch.filters } : s.filters,
          page: patch.page ?? 1,
        };
        if (!('cursor' in patch)) delete next.cursor;
        return next;
      });
    },
    [],
  );

  const reset = useCallback(() => setState(base), [base]);

  /** Fetches every page of the current filter (for export), 100 rows at a time. */
  const fetchAll = useCallback(async () => {
    const rows: T[] = [];
    let cursor: string | undefined;
    for (let page = 1; page <= 1000; page++) {
      const q = toQuery({ ...effective, page, limit: 100, cursor }, cursorMode);
      const res = await client.requestEnvelope<T[], PageMeta>(`${path}?${q}`);
      rows.push(...res.data);
      if (!res.meta.hasNextPage) break;
      if (isCursorMeta(res.meta)) {
        if (!res.meta.nextCursor) break;
        cursor = res.meta.nextCursor;
      }
    }
    return rows;
  }, [client, path, effective, cursorMode]);

  // A stale or edited cursor (old bookmark, link from another user): the table offers a
  // way back to the first page instead of a dead end.
  const cursorRejected = cursorMode && errorCode(query.error) === 'INVALID_CURSOR';

  const meta = query.data?.meta ?? null;
  /** Cursor mode: go to the next / previous page (no-op without a cursor). */
  const goNext = useCallback(() => {
    if (isCursorMeta(meta) && meta.nextCursor) update({ cursor: meta.nextCursor });
  }, [meta, update]);
  const goPrevious = useCallback(() => {
    if (isCursorMeta(meta) && meta.prevCursor) update({ cursor: meta.prevCursor });
  }, [meta, update]);
  const goFirst = useCallback(() => update({ cursor: undefined }), [update]);

  return {
    state,
    update,
    reset,
    rows: query.data?.data ?? [],
    meta,
    cursorMode,
    cursorRejected,
    goNext,
    goPrevious,
    goFirst,
    isLoading: query.isPending,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
    fetchAll,
  };
}

export type PagedList<T> = ReturnType<typeof usePagedList<T>>;
