'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { authErrorMessage } from '@/lib/auth/errors';
import { DIET_LABEL, type MenuItem, useMenu, useMenuMutations } from '@/lib/menu';
import { CARD, KitchenFrame } from '../kitchen-frame';
import { KitchenError, TicketSkeletons } from '../kitchen-overview';

const DIET_DOT = { veg: 'bg-emerald-500', non_veg: 'bg-red-500', egg: 'bg-amber-500' } as const;

export default function KitchenMenuPage() {
  return (
    <KitchenFrame title="Menu">
      {({ branchId }) => <KitchenMenu branchId={branchId} />}
    </KitchenFrame>
  );
}

function KitchenMenu({ branchId }: { branchId: string }) {
  const menu = useMenu(branchId || undefined);
  const { updateItem } = useMenuMutations();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [soldOutOnly, setSoldOutOnly] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const data = menu.data;
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.items ?? []).filter(
      (i) =>
        (category === 'all' || i.categoryId === category) &&
        (!soldOutOnly || !i.isAvailable) &&
        (!q || i.name.toLowerCase().includes(q)),
    );
  }, [data, query, category, soldOutOnly]);

  const toggle = async (item: MenuItem) => {
    setPending(item.id);
    setError(null);
    try {
      await updateItem.mutateAsync({ id: item.id, isAvailable: !item.isAvailable });
    } catch (e) {
      setError(authErrorMessage(e));
    } finally {
      setPending(null);
    }
  };

  if (menu.isPending) {
    return (
      <div className="p-4 sm:p-6">
        <TicketSkeletons />
      </div>
    );
  }
  if (menu.isError || !data) {
    return (
      <div className="p-4 sm:p-6">
        <KitchenError message={authErrorMessage(menu.error)} />
      </div>
    );
  }

  const soldOut = data.items.filter((i) => !i.isAvailable).length;
  const categories = data.categories.filter((c) => data.items.some((i) => i.categoryId === c.id));

  return (
    <div className="mx-auto max-w-[110rem] space-y-4 p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="relative flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
          <span className="sr-only">Search menu</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search dishes…"
            className="h-9 w-full rounded-md border border-slate-200 bg-white pr-3 pl-9 text-sm dark:border-white/10 dark:bg-slate-900 dark:text-white"
          />
        </label>
        <div className="flex items-center gap-3">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="Category"
            className="h-9 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-3 text-sm sm:max-w-[14rem] sm:flex-none dark:border-white/10 dark:bg-slate-900 dark:text-white"
          >
            <option value="all">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <label className="flex shrink-0 items-center gap-2 text-sm whitespace-nowrap text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              checked={soldOutOnly}
              onChange={(e) => setSoldOutOnly(e.target.checked)}
              className="size-4 accent-emerald-600"
            />
            Sold out only ({soldOut})
          </label>
        </div>
      </div>

      {!data.canManage ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          View only. Ask a manager to mark dishes sold out or back in stock.
        </p>
      ) : null}
      {error ? <KitchenError message={error} /> : null}

      {items.length === 0 ? (
        <div className={cn(CARD, 'p-10 text-center text-sm text-slate-500 dark:text-slate-400')}>
          No dishes match.
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <li key={item.id} className={cn(CARD, 'flex items-center gap-3 p-3')}>
              <span
                className={cn('size-2.5 shrink-0 rounded-full', DIET_DOT[item.diet])}
                title={DIET_LABEL[item.diet]}
              />
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    'truncate font-medium text-slate-900 dark:text-white',
                    !item.isAvailable && 'text-slate-400 line-through dark:text-slate-500',
                  )}
                >
                  {item.name}
                </p>
                <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                  {data.categories.find((c) => c.id === item.categoryId)?.name}
                  {item.variants.length > 0
                    ? ` · ${item.variants.map((v) => v.name).join(' / ')}`
                    : ''}
                </p>
              </div>
              {data.canManage ? (
                <button
                  type="button"
                  disabled={pending === item.id}
                  onClick={() => toggle(item)}
                  className={cn(
                    'h-9 shrink-0 rounded-md px-3 text-xs whitespace-nowrap font-medium ring-1 ring-inset disabled:opacity-60',
                    item.isAvailable
                      ? 'text-red-700 ring-red-200 hover:bg-red-50 dark:text-red-300 dark:ring-red-500/30 dark:hover:bg-red-500/10'
                      : 'bg-emerald-600 text-white ring-emerald-600 hover:bg-emerald-700',
                  )}
                >
                  {pending === item.id ? '…' : item.isAvailable ? 'Mark sold out' : 'Back in stock'}
                </button>
              ) : (
                <span
                  className={cn(
                    'shrink-0 rounded-md px-2 py-0.5 text-xs font-medium',
                    item.isAvailable
                      ? 'text-emerald-700 dark:text-emerald-300'
                      : 'text-red-700 dark:text-red-300',
                  )}
                >
                  {item.isAvailable ? 'Available' : 'Sold out'}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
