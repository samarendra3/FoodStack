'use client';

import { cn } from '@foodstack/ui/lib/utils';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  Inbox,
  Loader2,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { authErrorMessage } from '@/lib/auth/errors';
import { downloadCsv } from '@/lib/csv';
import { PAGE_SIZES, type PagedList } from '@/lib/paged';

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Server sort key; the column header becomes a sort toggle. */
  sortKey?: string;
  align?: 'left' | 'right';
  className?: string;
  /** Hidden in the stacked mobile layout (keep the 2–3 most useful columns visible). */
  hideOnMobile?: boolean;
}

export interface BulkAction<T> {
  label: string;
  icon?: ReactNode;
  destructive?: boolean;
  run: (rows: T[]) => Promise<unknown> | void;
}

export interface FilterOption {
  key: string;
  label: string;
  options: { value: string; label: string }[];
}

interface DataTableProps<T> {
  list: PagedList<T>;
  columns: Column<T>[];
  getRowId: (row: T) => string;
  searchPlaceholder?: string;
  /** Simple select filters shown in the toolbar. */
  filters?: FilterOption[];
  /** Shows From/To date inputs bound to the `from` / `to` filters. */
  dateRange?: boolean;
  /** Extra toolbar content (e.g. a branch picker). */
  toolbar?: ReactNode;
  bulkActions?: BulkAction<T>[];
  /** Per-row actions; return null when the user may not act on the row. */
  rowActions?: (row: T) => ReactNode;
  onRowClick?: (row: T) => void;
  /** CSV export of every row matching the current filters. */
  exportCsv?: {
    filename: string;
    columns: { header: string; value: (row: T) => string | number }[];
  };
  empty?: { title: string; description?: string; action?: ReactNode };
}

/**
 * Server-paged data table: debounced search, select filters, date range, sortable headers,
 * page size, row selection with bulk actions, permission-aware row actions, CSV export,
 * loading / empty / error states, and a stacked card layout on small screens.
 */
export function DataTable<T>(p: DataTableProps<T>) {
  const { list } = p;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const ids = list.rows.map(p.getRowId);
  const pageSelected = ids.length > 0 && ids.every((id) => selected.has(id));
  const selectable = Boolean(p.bulkActions?.length);
  const activeFilters =
    Boolean(list.state.search) ||
    Object.values(list.state.filters).some((v) => v !== '' && v !== undefined);

  const toggleSort = (key: string) =>
    list.update({
      sortBy: key,
      sortOrder: list.state.sortBy === key && list.state.sortOrder === 'desc' ? 'asc' : 'desc',
    });

  const runBulk = async (a: BulkAction<T>) => {
    const rows = list.rows.filter((r) => selected.has(p.getRowId(r)));
    setBusy(a.label);
    setActionError(null);
    try {
      await a.run(rows);
      setSelected(new Set());
      await list.refetch();
    } catch (e) {
      setActionError(authErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const exportAll = async () => {
    if (!p.exportCsv) return;
    setBusy('export');
    setActionError(null);
    try {
      const rows = await list.fetchAll();
      downloadCsv(p.exportCsv.filename, [
        p.exportCsv.columns.map((c) => c.header),
        ...rows.map((r) => p.exportCsv!.columns.map((c) => c.value(r))),
      ]);
    } catch (e) {
      setActionError(authErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="overflow-hidden rounded-2xl border bg-card">
      {/* Toolbar */}
      <div className="flex flex-col gap-2 border-b p-3 lg:flex-row lg:flex-wrap lg:items-center">
        <label className="relative flex-1 lg:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <span className="sr-only">Search</span>
          <input
            value={list.state.search}
            onChange={(e) => list.update({ search: e.target.value })}
            placeholder={p.searchPlaceholder ?? 'Search'}
            className="h-9 w-full rounded-lg border bg-background pr-8 pl-9 text-sm outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/20"
          />
          {list.state.search ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => list.update({ search: '' })}
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </label>
        {p.filters?.map((f) => (
          <label key={f.key} className="flex items-center">
            <span className="sr-only">{f.label}</span>
            <select
              value={list.state.filters[f.key] ?? ''}
              onChange={(e) => list.update({ filters: { [f.key]: e.target.value } })}
              className="h-9 rounded-lg border bg-background px-2.5 text-sm"
            >
              <option value="">{f.label}: All</option>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        ))}
        {p.dateRange ? (
          <div className="flex items-center gap-1.5 text-sm">
            <input
              type="date"
              aria-label="From date"
              value={list.state.filters.from ?? ''}
              max={list.state.filters.to || undefined}
              onChange={(e) => list.update({ filters: { from: e.target.value } })}
              className="h-9 rounded-lg border bg-background px-2"
            />
            <span className="text-muted-foreground">–</span>
            <input
              type="date"
              aria-label="To date"
              value={list.state.filters.to ?? ''}
              min={list.state.filters.from || undefined}
              onChange={(e) => list.update({ filters: { to: e.target.value } })}
              className="h-9 rounded-lg border bg-background px-2"
            />
          </div>
        ) : null}
        {p.toolbar}
        <div className="flex items-center gap-2 lg:ml-auto">
          {activeFilters ? (
            <button
              type="button"
              onClick={list.reset}
              className="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted-foreground hover:bg-muted"
            >
              <RotateCcw className="size-3.5" /> Reset
            </button>
          ) : null}
          {p.exportCsv ? (
            <button
              type="button"
              onClick={exportAll}
              disabled={busy === 'export' || !list.meta?.total}
              className="flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              {busy === 'export' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              Export CSV
            </button>
          ) : null}
        </div>
      </div>

      {/* Bulk bar */}
      {selectable && selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-4 py-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="text-muted-foreground hover:underline"
          >
            Clear
          </button>
          <div className="ml-auto flex flex-wrap gap-2">
            {p.bulkActions!.map((a) => (
              <button
                key={a.label}
                type="button"
                disabled={busy !== null}
                onClick={() => runBulk(a)}
                className={cn(
                  'flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold disabled:opacity-50',
                  a.destructive
                    ? 'border-red-200 text-red-700 hover:bg-red-50'
                    : 'bg-background hover:bg-muted',
                )}
              >
                {busy === a.label ? <Loader2 className="size-3.5 animate-spin" /> : a.icon}
                {a.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {actionError ? (
        <p
          role="alert"
          className="border-b bg-red-50 px-4 py-2 text-sm text-red-700 dark:bg-red-500/10"
        >
          {actionError}
        </p>
      ) : null}

      {/* Body */}
      {list.error && !list.meta ? (
        <div className="flex flex-col items-center px-6 py-14 text-center">
          <AlertCircle className="size-8 text-red-500" />
          <p className="mt-3 font-medium">Could not load this list</p>
          <p className="mt-1 text-sm text-muted-foreground">{authErrorMessage(list.error)}</p>
          <button
            type="button"
            onClick={() => list.refetch()}
            className="mt-4 rounded-lg border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Try again
          </button>
        </div>
      ) : list.isLoading ? (
        <div className="divide-y" aria-busy="true">
          {Array.from({ length: Math.min(list.state.limit, 8) }, (_, i) => (
            <div key={i} className="flex animate-pulse gap-4 px-4 py-3.5">
              <div className="h-4 flex-[2] rounded bg-muted" />
              <div className="h-4 flex-1 rounded bg-muted" />
              <div className="hidden h-4 flex-1 rounded bg-muted md:block" />
              <div className="h-4 w-16 rounded bg-muted" />
            </div>
          ))}
        </div>
      ) : list.rows.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-14 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <Inbox className="size-6" />
          </span>
          <p className="mt-3 font-medium">
            {activeFilters
              ? 'Nothing matches these filters'
              : (p.empty?.title ?? 'Nothing here yet')}
          </p>
          {activeFilters ? (
            <button
              type="button"
              onClick={list.reset}
              className="mt-3 text-sm font-medium text-primary hover:underline"
            >
              Clear filters
            </button>
          ) : (
            <>
              {p.empty?.description ? (
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">{p.empty.description}</p>
              ) : null}
              {p.empty?.action ? <div className="mt-4">{p.empty.action}</div> : null}
            </>
          )}
        </div>
      ) : (
        <div className={cn('transition-opacity', list.isFetching && 'opacity-60')}>
          {/* Desktop table */}
          <table className="hidden w-full text-sm md:table">
            <thead className="bg-muted/40 text-left text-xs font-semibold text-muted-foreground">
              <tr>
                {selectable ? (
                  <th className="w-10 px-4 py-2.5">
                    <input
                      type="checkbox"
                      aria-label="Select all on this page"
                      checked={pageSelected}
                      onChange={() =>
                        setSelected((s) => {
                          const next = new Set(s);
                          for (const id of ids) {
                            if (pageSelected) next.delete(id);
                            else next.add(id);
                          }
                          return next;
                        })
                      }
                      className="size-4 accent-emerald-600"
                    />
                  </th>
                ) : null}
                {p.columns.map((c) => (
                  <th
                    key={c.key}
                    className={cn(
                      'px-4 py-2.5 whitespace-nowrap',
                      c.align === 'right' && 'text-right',
                      c.className,
                    )}
                    aria-sort={
                      c.sortKey && list.state.sortBy === c.sortKey
                        ? list.state.sortOrder === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : undefined
                    }
                  >
                    {c.sortKey ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(c.sortKey!)}
                        className={cn(
                          'inline-flex items-center gap-1 hover:text-foreground',
                          list.state.sortBy === c.sortKey && 'text-foreground',
                        )}
                      >
                        {c.header}
                        {list.state.sortBy !== c.sortKey ? (
                          <ArrowUpDown className="size-3 opacity-50" />
                        ) : list.state.sortOrder === 'asc' ? (
                          <ArrowUp className="size-3" />
                        ) : (
                          <ArrowDown className="size-3" />
                        )}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                ))}
                {p.rowActions ? <th className="px-4 py-2.5 text-right">Actions</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y">
              {list.rows.map((row) => {
                const id = p.getRowId(row);
                return (
                  <tr
                    key={id}
                    onClick={p.onRowClick ? () => p.onRowClick!(row) : undefined}
                    className={cn(
                      'hover:bg-muted/30',
                      p.onRowClick && 'cursor-pointer',
                      selected.has(id) && 'bg-primary/5',
                    )}
                  >
                    {selectable ? (
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label="Select row"
                          checked={selected.has(id)}
                          onChange={() =>
                            setSelected((s) => {
                              const next = new Set(s);
                              if (next.has(id)) next.delete(id);
                              else next.add(id);
                              return next;
                            })
                          }
                          className="size-4 accent-emerald-600"
                        />
                      </td>
                    ) : null}
                    {p.columns.map((c) => (
                      <td
                        key={c.key}
                        className={cn(
                          'px-4 py-3',
                          c.align === 'right' && 'text-right tabular-nums',
                          c.className,
                        )}
                      >
                        {c.cell(row)}
                      </td>
                    ))}
                    {p.rowActions ? (
                      <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-end gap-1">{p.rowActions(row)}</div>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Mobile cards */}
          <ul className="divide-y md:hidden">
            {list.rows.map((row) => {
              const id = p.getRowId(row);
              return (
                <li
                  key={id}
                  className={cn('flex gap-3 px-4 py-3', selected.has(id) && 'bg-primary/5')}
                >
                  {selectable ? (
                    <input
                      type="checkbox"
                      aria-label="Select row"
                      checked={selected.has(id)}
                      onChange={() =>
                        setSelected((s) => {
                          const next = new Set(s);
                          if (next.has(id)) next.delete(id);
                          else next.add(id);
                          return next;
                        })
                      }
                      className="mt-1 size-4 accent-emerald-600"
                    />
                  ) : null}
                  <div
                    className="min-w-0 flex-1 space-y-1"
                    onClick={p.onRowClick ? () => p.onRowClick!(row) : undefined}
                  >
                    {p.columns
                      .filter((c) => !c.hideOnMobile)
                      .map((c, i) => (
                        <div
                          key={c.key}
                          className={cn(
                            'flex justify-between gap-3 text-sm',
                            i === 0 && 'font-medium',
                          )}
                        >
                          {i > 0 ? <span className="text-muted-foreground">{c.header}</span> : null}
                          <span className={cn(i > 0 && 'text-right')}>{c.cell(row)}</span>
                        </div>
                      ))}
                    {p.rowActions ? (
                      <div className="flex flex-wrap gap-1 pt-1">{p.rowActions(row)}</div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {list.meta && list.meta.total > 0 ? <Pagination list={list} /> : null}
    </div>
  );
}

/** Page size, range summary and first/previous/next/last controls. */
export function Pagination<T>({ list }: { list: PagedList<T> }) {
  const m = list.meta!;
  const first = (m.page - 1) * m.limit + 1;
  const last = Math.min(m.page * m.limit, m.total);
  const btn =
    'flex size-8 items-center justify-center rounded-lg border text-muted-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-40';
  return (
    <div className="flex flex-col gap-3 border-t px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3 text-muted-foreground">
        <label className="flex items-center gap-2">
          Rows
          <select
            value={m.limit}
            onChange={(e) => list.update({ limit: Number(e.target.value) })}
            className="h-8 rounded-lg border bg-background px-2 text-foreground"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <span aria-live="polite" className="tabular-nums">
          {first}–{last} of {m.total.toLocaleString()}
        </span>
      </div>
      <nav className="flex items-center gap-1" aria-label="Pagination">
        <button
          type="button"
          aria-label="First page"
          disabled={!m.hasPreviousPage}
          onClick={() => list.update({ page: 1 })}
          className={btn}
        >
          <ChevronsLeft className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Previous page"
          disabled={!m.hasPreviousPage}
          onClick={() => list.update({ page: m.page - 1 })}
          className={btn}
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="px-2 tabular-nums">
          Page {m.page} of {m.totalPages}
        </span>
        <button
          type="button"
          aria-label="Next page"
          disabled={!m.hasNextPage}
          onClick={() => list.update({ page: m.page + 1 })}
          className={btn}
        >
          <ChevronRight className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Last page"
          disabled={!m.hasNextPage}
          onClick={() => list.update({ page: m.totalPages })}
          className={btn}
        >
          <ChevronsRight className="size-4" />
        </button>
      </nav>
    </div>
  );
}
