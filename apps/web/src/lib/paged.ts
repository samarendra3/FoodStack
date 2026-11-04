'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth, useProfile } from '@/components/auth/auth-provider';

import { type ListState, type PageMeta, PAGE_SIZES, readUrl, toQuery } from './paged-query';

export { PAGE_SIZES, toQuery, type ListState, type PageMeta };

/**
 * Server-side paged list: state lives in the URL (shareable, back-button friendly), search is
 * debounced, and the previous page stays on screen while the next one loads.
 */
export function usePagedList<T>(
  key: string,
  path: string,
  defaults: Partial<ListState> & { sortBy: string },
) {
  const { client } = useAuth();
  const profile = useProfile();
  const base: ListState = useMemo(
    () => ({ page: 1, limit: 25, search: '', sortOrder: 'desc', filters: {}, ...defaults }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- defaults are fixed per screen
    [],
  );
  const filterKeys = Object.keys(base.filters);
  const [state, setState] = useState<ListState>(() => readUrl(base, filterKeys));
  const [debouncedSearch, setDebouncedSearch] = useState(state.search);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(state.search), 300);
    return () => clearTimeout(t);
  }, [state.search]);

  const effective = useMemo(
    () => ({ ...state, search: debouncedSearch }),
    [state, debouncedSearch],
  );
  const qs = toQuery(effective).toString();

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

  /** Changing anything but the page returns to page 1. */
  const update = useCallback(
    (patch: Partial<Omit<ListState, 'filters'>> & { filters?: Record<string, string> }) => {
      setState((s) => ({
        ...s,
        ...patch,
        filters: patch.filters ? { ...s.filters, ...patch.filters } : s.filters,
        page: patch.page ?? 1,
      }));
    },
    [],
  );

  const reset = useCallback(() => setState(base), [base]);

  /** Fetches every page of the current filter (for export), 100 rows at a time. */
  const fetchAll = useCallback(async () => {
    const rows: T[] = [];
    for (let page = 1; page <= 1000; page++) {
      const q = toQuery({ ...effective, page, limit: 100 });
      const res = await client.requestEnvelope<T[], PageMeta>(`${path}?${q}`);
      rows.push(...res.data);
      if (!res.meta.hasNextPage) break;
    }
    return rows;
  }, [client, path, effective]);

  return {
    state,
    update,
    reset,
    rows: query.data?.data ?? [],
    meta: query.data?.meta ?? null,
    isLoading: query.isPending,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
    fetchAll,
  };
}

export type PagedList<T> = ReturnType<typeof usePagedList<T>>;
