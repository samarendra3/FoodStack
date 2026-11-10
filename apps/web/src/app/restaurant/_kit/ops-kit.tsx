'use client';

import { Dialog } from '@foodstack/ui/components/dialog';
import { cn } from '@foodstack/ui/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { authErrorMessage } from '@/lib/auth/errors';
import { useNotify } from '@/lib/notify';
import { buttonPrimary, buttonSecondary, control } from './report-kit';

/*
 * Data and form helpers for the operations pages: one query/mutation pattern, a form dialog,
 * labelled fields, status badges and a responsive table.
 */

const ROOT = 'ops';

/** GET an operations endpoint; cached per tenant under the `ops` key. */
export function useOps<T>(path: string | null) {
  const { client } = useAuth();
  const profile = useProfile();
  return useQuery({
    queryKey: [ROOT, profile.activeTenant?.id, path],
    queryFn: () => client.request<T>(path!),
    enabled: Boolean(path),
  });
}

/** Writes to the API, then refreshes every operations query (and inventory, menu, tables). */
export function useOpsWrite() {
  const { client } = useAuth();
  const qc = useQueryClient();
  const notify = useNotify();
  const m = useMutation({
    mutationFn: ({
      path,
      method,
      body,
    }: {
      path: string;
      method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
      body?: unknown;
    }) => client.request<unknown>(path, { method, body }),
    onSuccess: () => {
      for (const key of [ROOT, 'inventory', 'menu', 'tables', 'analytics']) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });
  return {
    pending: m.isPending,
    /** Resolves with the response; rejects (for forms to show) on error. */
    send: <T = unknown,>(
      path: string,
      method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
      body?: unknown,
    ) => m.mutateAsync({ path, method, body }) as Promise<T>,
    /** Fire-and-notify for quick actions (toggles, status buttons). */
    act: async (
      path: string,
      method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
      body?: unknown,
      ok?: string,
    ) => {
      try {
        await m.mutateAsync({ path, method, body });
        if (ok) notify.success(ok);
        return true;
      } catch (e) {
        notify.error(e);
        return false;
      }
    },
  };
}

export const money = (minor: number, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(
    minor / 100,
  );
export const toMinor = (rupees: string) => Math.round(Number(rupees || 0) * 100);
export const toRupees = (minor: number | null | undefined) =>
  minor === null || minor === undefined ? '' : String(minor / 100);
export const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});
export const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
export const timeOnly = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
export const today = () => new Date().toLocaleDateString('en-CA');
export const daysAgo = (n: number) =>
  new Date(Date.now() - n * 86_400_000).toLocaleDateString('en-CA');

/** Modal form with title, body, error line and Cancel / Save buttons. */
export function FormDialog({
  open,
  onClose,
  title,
  description,
  submitLabel = 'Save',
  onSubmit,
  children,
  size = 'md',
  danger,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  submitLabel?: string;
  onSubmit: () => Promise<unknown>;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  danger?: boolean;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
      onClose();
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} dismissible={!busy} labelledBy={`${id}-t`} size={size}>
      <form onSubmit={submit} className="flex max-h-[85dvh] flex-col">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-white/10">
          <div>
            <h2 id={`${id}-t`} className="text-base font-semibold">
              {title}
            </h2>
            {description ? (
              <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">{children}</div>
        {error ? (
          <p
            role="alert"
            className="mx-5 mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300"
          >
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-white/10">
          <button type="button" onClick={onClose} disabled={busy} className={buttonSecondary}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className={cn(buttonPrimary, danger && 'bg-red-600 hover:bg-red-700')}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('block space-y-1.5', className)}>
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export const input = cn(control, 'w-full');

export function Badge({
  tone = 'slate',
  children,
}: {
  tone?: 'slate' | 'emerald' | 'amber' | 'red' | 'sky' | 'violet';
  children: ReactNode;
}) {
  const tones = {
    slate: 'bg-slate-100 text-slate-700 ring-slate-500/20 dark:bg-white/10 dark:text-slate-300',
    emerald:
      'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-300',
    amber: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-300',
    red: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/15 dark:text-red-300',
    sky: 'bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/15 dark:text-sky-300',
    violet:
      'bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-500/15 dark:text-violet-300',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset',
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export interface Col<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  align?: 'right';
  /** Hidden below the sm breakpoint. */
  hideOnMobile?: boolean;
}

/** Plain responsive table: scrolls sideways on small screens, secondary columns hide on phones. */
export function Table<T>({
  rows,
  cols,
  rowKey,
  onRow,
}: {
  rows: T[];
  cols: Col<T>[];
  rowKey: (r: T) => string;
  onRow?: (r: T) => void;
}) {
  return (
    <div className="-mx-4 overflow-x-auto sm:mx-0">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs text-muted-foreground uppercase dark:border-white/10">
            {cols.map((c) => (
              <th
                key={c.key}
                className={cn(
                  'px-4 py-2 font-medium whitespace-nowrap sm:px-3',
                  c.align === 'right' && 'text-right',
                  c.hideOnMobile && 'hidden sm:table-cell',
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={rowKey(r)}
              onClick={onRow ? () => onRow(r) : undefined}
              className={cn(
                'border-b border-slate-100 last:border-0 dark:border-white/5',
                onRow && 'cursor-pointer hover:bg-slate-50 dark:hover:bg-white/5',
              )}
            >
              {cols.map((c) => (
                <td
                  key={c.key}
                  className={cn(
                    'px-4 py-3 align-middle sm:px-3',
                    c.align === 'right' && 'text-right tabular-nums',
                    c.hideOnMobile && 'hidden sm:table-cell',
                  )}
                >
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Branch picker that hides itself when there is only one branch. */
export function BranchPicker({
  branches,
  value,
  onChange,
  allLabel,
}: {
  branches: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
  allLabel?: string;
}) {
  if (branches.length < 2) return null;
  return (
    <select
      aria-label="Branch"
      className={control}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {allLabel ? <option value="">{allLabel}</option> : null}
      {branches.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
    </select>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">{children}</div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-white/20',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform',
          checked && 'translate-x-5',
        )}
      />
    </button>
  );
}
