'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { Leaf, Plus, Search, SearchX, X } from 'lucide-react';
import { motion } from 'motion/react';
import Link from 'next/link';
import type { Diet, PosItem } from './catalog';
import { DietMark, FoodImage } from './food-image';
import { inr } from './order-math';

interface ProductSectionProps {
  items: PosItem[];
  categories: string[];
  isLoading: boolean;
  /** The restaurant has no sellable items yet. */
  menuEmpty?: boolean;
  category: string;
  onCategory: (c: string) => void;
  query: string;
  onQuery: (q: string) => void;
  diet: Diet | null;
  onDiet: (d: Diet | null) => void;
  cart: Record<string, number>;
  onAdd: (id: string) => void;
}

export function ProductSection(p: ProductSectionProps) {
  const q = p.query.trim().toLowerCase();
  const matchesSearch = (i: PosItem) =>
    (!p.diet || i.diet === p.diet || (p.diet === 'non-veg' && i.diet === 'egg')) &&
    (!q || i.name.toLowerCase().includes(q));
  const pool = p.items.filter(matchesSearch);
  const visible = pool.filter((i) => p.category === 'All' || i.category === p.category);
  const tabs = ['All', ...p.categories].map((c) => ({
    name: c,
    count: c === 'All' ? pool.length : pool.filter((i) => i.category === c).length,
  }));

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="space-y-3 border-b border-slate-200 bg-white px-4 pt-4 pb-3 sm:px-6 dark:border-white/10 dark:bg-slate-950">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <label className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-slate-400" />
            <span className="sr-only">Search menu</span>
            <input
              value={p.query}
              onChange={(e) => p.onQuery(e.target.value)}
              placeholder="Search dishes, e.g. paneer"
              className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pr-10 pl-10 text-sm outline-none placeholder:text-slate-400 focus-visible:border-emerald-500 focus-visible:bg-white focus-visible:ring-4 focus-visible:ring-emerald-500/10 dark:border-white/10 dark:bg-white/5"
            />
            {p.query ? (
              <button
                type="button"
                onClick={() => p.onQuery('')}
                aria-label="Clear search"
                className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-md p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
              >
                <X className="size-4" />
              </button>
            ) : null}
          </label>
          <div
            className="flex shrink-0 gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1 dark:border-white/10 dark:bg-white/5"
            role="group"
            aria-label="Diet filter"
          >
            {(
              [
                { id: 'veg', label: 'Veg' },
                { id: 'non-veg', label: 'Non-Veg' },
              ] as const
            ).map((d) => {
              const on = p.diet === d.id;
              return (
                <button
                  key={d.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => p.onDiet(on ? null : d.id)}
                  className={cn(
                    'flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-all',
                    on
                      ? d.id === 'veg'
                        ? 'bg-emerald-600 text-white shadow-sm'
                        : 'bg-red-600 text-white shadow-sm'
                      : 'text-slate-600 hover:bg-white hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/10',
                  )}
                >
                  {d.id === 'veg' ? (
                    <Leaf className="size-4" />
                  ) : (
                    <DietMark diet="non-veg" className="size-3.5" />
                  )}
                  {d.label}
                </button>
              );
            })}
          </div>
        </div>

        <nav
          aria-label="Menu categories"
          className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none]"
        >
          {tabs.map((t) => {
            const on = p.category === t.name;
            return (
              <button
                key={t.name}
                type="button"
                onClick={() => p.onCategory(t.name)}
                aria-current={on ? 'true' : undefined}
                className={cn(
                  'flex h-10 shrink-0 items-center gap-2 rounded-xl border px-4 text-sm font-medium transition-all',
                  on
                    ? 'border-emerald-600 bg-emerald-600 text-white shadow-sm shadow-emerald-600/20'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50 dark:border-white/10 dark:bg-transparent dark:text-slate-300',
                )}
              >
                {t.name}
                <span
                  className={cn(
                    'rounded-md px-1.5 py-0.5 text-xs tabular-nums',
                    on ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500 dark:bg-white/10',
                  )}
                >
                  {t.count}
                </span>
              </button>
            );
          })}
        </nav>
      </div>

      <div className="flex-1 overflow-y-auto bg-slate-50 px-4 py-5 pb-24 sm:px-6 lg:pb-5 dark:bg-slate-900/40">
        {p.isLoading ? (
          <Grid>
            {Array.from({ length: 10 }, (_, i) => (
              <div
                key={i}
                className="animate-pulse overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-white/10 dark:bg-slate-900"
              >
                <div className="aspect-[4/3] bg-slate-200 dark:bg-white/10" />
                <div className="space-y-2 p-3">
                  <div className="h-4 w-3/4 rounded bg-slate-200 dark:bg-white/10" />
                  <div className="h-4 w-1/3 rounded bg-slate-200 dark:bg-white/10" />
                </div>
              </div>
            ))}
          </Grid>
        ) : p.menuEmpty ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-white text-slate-400 shadow-xs dark:bg-white/5">
              <SearchX className="size-6" />
            </div>
            <p className="mt-4 font-medium text-slate-900 dark:text-white">No menu items yet</p>
            <p className="mt-1 max-w-xs text-sm text-slate-500">
              Add categories and dishes in Menu Management and they appear here instantly.
            </p>
            <Link
              href="/restaurant/menu"
              className="mt-4 rounded-lg px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50"
            >
              Open Menu Management
            </Link>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-white text-slate-400 shadow-xs dark:bg-white/5">
              <SearchX className="size-6" />
            </div>
            <p className="mt-4 font-medium text-slate-900 dark:text-white">No dishes found</p>
            <p className="mt-1 text-sm text-slate-500">Try another search or clear the filters.</p>
            <button
              type="button"
              onClick={() => {
                p.onQuery('');
                p.onDiet(null);
                p.onCategory('All');
              }}
              className="mt-4 rounded-lg px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <Grid>
            {visible.map((item) => (
              <ProductCard
                key={item.id}
                item={item}
                qty={p.cart[item.id] ?? 0}
                onAdd={() => p.onAdd(item.id)}
              />
            ))}
          </Grid>
        )}
      </div>
    </section>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-4 2xl:grid-cols-5">
      {children}
    </div>
  );
}

function ProductCard({ item, qty, onAdd }: { item: PosItem; qty: number; onAdd: () => void }) {
  const selected = qty > 0;
  return (
    <motion.div
      layout
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-2xl border bg-white transition-[border-color,box-shadow,transform] duration-200 dark:bg-slate-900',
        item.available
          ? 'hover:-translate-y-0.5 hover:shadow-md hover:shadow-slate-900/5'
          : 'opacity-60',
        selected
          ? 'border-emerald-500 ring-2 ring-emerald-500/15'
          : 'border-slate-200 dark:border-white/10',
      )}
    >
      <div className="relative">
        <FoodImage
          src={item.imageUrl}
          alt={item.name}
          className="aspect-[4/3] w-full transition-transform duration-300 group-hover:scale-[1.03]"
        />
        {item.badge ? (
          <span
            className={cn(
              'absolute top-2.5 left-2.5 rounded-md px-2 py-0.5 text-[11px] font-semibold text-white shadow-sm',
              item.badge === 'Popular' ? 'bg-emerald-600' : 'bg-orange-500',
            )}
          >
            {item.badge}
          </span>
        ) : null}
        <DietMark diet={item.diet} className="absolute bottom-2.5 left-2.5 shadow-sm" />
        {selected ? (
          <motion.span
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            key={qty}
            className="absolute top-2.5 right-2.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-emerald-600 px-1.5 text-xs font-bold text-white shadow-sm ring-2 ring-white"
          >
            {qty}
          </motion.span>
        ) : null}
        {!item.available ? (
          <span className="absolute inset-x-0 bottom-0 bg-slate-900/75 py-1 text-center text-xs font-medium text-white">
            Sold out
          </span>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col p-3">
        <h3 className="line-clamp-1 text-sm font-semibold text-slate-900 dark:text-white">
          {item.name}
        </h3>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[15px] font-bold text-slate-900 tabular-nums dark:text-white">
            {inr.format(item.price)}
          </span>
          <button
            type="button"
            onClick={onAdd}
            disabled={!item.available}
            aria-label={`Add ${item.name}`}
            className="flex h-8 items-center gap-1 rounded-lg bg-emerald-600 px-2.5 text-xs font-semibold text-white shadow-sm transition-all hover:bg-emerald-700 active:scale-95 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
          >
            <Plus className="size-3.5" strokeWidth={2.5} />
            Add
          </button>
        </div>
      </div>
    </motion.div>
  );
}
