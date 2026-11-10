'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { hasPermissionAnywhere } from '@/lib/auth/access';
import { authErrorMessage } from '@/lib/auth/errors';
import { useEntitlement } from '@/lib/billing';

const input =
  'h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-emerald-600 focus:ring-4 focus:ring-emerald-600/15 dark:border-white/10 dark:bg-white/5';

/** Suggests a short code from the name: "Salt Lake Kolkata" → "SALT-LAKE". */
function suggestCode(name: string) {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-')
    .slice(0, 2)
    .join('-')
    .slice(0, 32);
}

/** "Add branch" button + form. Hidden for people who cannot manage branches. */
export function AddBranch({ used }: { used: number }) {
  const profile = useProfile();
  const { client } = useAuth();
  const qc = useQueryClient();
  const router = useRouter();
  const entitlement = useEntitlement();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [codeTouched, setCodeTouched] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      client.request<{ id: string }>('/branches', {
        method: 'POST',
        body: { name: name.trim(), code: (code || suggestCode(name)).trim() },
      }),
    onSuccess: async (branch) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['restaurant', 'overview'] }),
        qc.invalidateQueries({ queryKey: ['billing'] }),
        client.refresh(), // sidebar branch list comes from the session
      ]);
      setOpen(false);
      setName('');
      setCode('');
      setCodeTouched(false);
      router.push(`/restaurant/branches/${branch.id}`);
    },
  });

  if (!hasPermissionAnywhere(profile, 'branch:manage')) return null;

  const limit = entitlement.data?.branchLimit ?? null;
  const full = limit !== null && used >= limit;
  const shownCode = codeTouched ? code : suggestCode(name);

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-3">
        {limit !== null ? (
          <span className="text-sm text-slate-500 dark:text-slate-400">
            {used} of {limit} branches used
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={full}
          title={full ? 'Your plan’s branch limit is reached' : undefined}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="size-4" aria-hidden /> Add branch
        </button>
      </div>
      {full ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Need more?{' '}
          <Link
            href="/restaurant/addons"
            className="font-medium text-emerald-700 hover:underline dark:text-emerald-400"
          >
            Buy extra branches or upgrade
          </Link>
        </p>
      ) : null}

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-branch-title"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
            className="w-full max-w-md space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-slate-900"
          >
            <div className="flex items-center justify-between">
              <h2 id="add-branch-title" className="font-semibold text-slate-900 dark:text-white">
                Add a branch
              </h2>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setOpen(false)}
                className="flex size-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-white/5"
              >
                <X className="size-4" />
              </button>
            </div>
            <label className="block space-y-1 text-sm">
              <span className="font-medium text-slate-700 dark:text-slate-200">Branch name</span>
              <input
                className={input}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Salt Lake"
                maxLength={120}
                required
                autoFocus
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="font-medium text-slate-700 dark:text-slate-200">Branch code</span>
              <input
                className={`${input} uppercase`}
                value={shownCode}
                onChange={(e) => {
                  setCodeTouched(true);
                  setCode(e.target.value.toUpperCase());
                }}
                pattern="[A-Za-z0-9_\-]{1,32}"
                maxLength={32}
                required
              />
              <span className="block text-xs text-slate-500">
                Short unique ID shown on orders and reports. Letters, numbers, - and _.
              </span>
            </label>
            {create.isError ? (
              <p className="rounded-md bg-red-50 p-2.5 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
                {authErrorMessage(create.error)}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-9 rounded-md px-3 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={create.isPending || !name.trim()}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {create.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                Create branch
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
