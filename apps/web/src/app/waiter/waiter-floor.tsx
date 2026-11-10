'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Loader2,
  Minus,
  Plus,
  Search,
  Users,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { authErrorMessage } from '@/lib/auth/errors';
import { type Diet, type MenuItem, useMenu } from '@/lib/menu';
import { type Order, useOrderMutations } from '@/lib/orders';
import type { DiningTable } from '@/lib/tables';

/*
 * Waiter workspace. Same visual language as the restaurant admin: neutral surfaces, 1px borders,
 * one accent (emerald) reserved for primary actions and "free" status. Mobile-first: on phones and
 * tablets the order lives in a bottom bar + sheet; from `lg` it is a side panel.
 */

const money = (minor: number) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: minor % 100 ? 2 : 0,
  }).format(minor / 100);

function since(iso: string | null) {
  if (!iso) return '';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const KITCHEN: Record<Order['kitchenStatus'], { label: string; dot: string }> = {
  new: { label: 'Sent', dot: 'bg-slate-400' },
  accepted: { label: 'Accepted', dot: 'bg-sky-500' },
  preparing: { label: 'Preparing', dot: 'bg-amber-500' },
  ready: { label: 'Ready', dot: 'bg-emerald-500' },
  served: { label: 'Served', dot: 'bg-slate-300' },
};

const DIET: Record<Diet, { label: string; cls: string }> = {
  veg: { label: 'Veg', cls: 'border-emerald-600 after:bg-emerald-600' },
  non_veg: { label: 'Non-veg', cls: 'border-red-600 after:bg-red-600' },
  egg: { label: 'Egg', cls: 'border-amber-500 after:bg-amber-500' },
};

// Shared tokens (match the admin: slate surfaces, 1px borders, rounded-lg).
const card = 'rounded-lg border border-slate-200 bg-white dark:border-white/10 dark:bg-slate-900';
const muted = 'text-slate-500 dark:text-slate-400';

/** Course tags sent with the order so the kitchen knows what to fire (added to the note). */
const COURSES = ['Starter', 'Main course', 'Dessert', 'Drinks'] as const;
const primaryBtn =
  'inline-flex items-center justify-center gap-2 rounded-md bg-emerald-600 font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40';
const outlineBtn =
  'inline-flex items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-white font-medium text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-white/5';

/** Segmented control, as used across the admin. */
function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string; count?: number }[];
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="inline-flex shrink-0 rounded-md border border-slate-200 bg-white p-0.5 dark:border-white/10 dark:bg-slate-900"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded px-3 text-sm whitespace-nowrap transition-colors',
            value === o.value
              ? 'bg-slate-100 font-medium text-slate-900 dark:bg-white/10 dark:text-white'
              : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white',
          )}
        >
          {o.label}
          {o.count !== undefined ? (
            <span className="text-xs text-slate-400 tabular-nums">{o.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Floor

type StatusFilter = 'all' | 'free' | 'occupied';

export function WaiterFloor({ branchId, tables }: { branchId: string; tables: DiningTable[] }) {
  const [tableId, setTableId] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [area, setArea] = useState('');
  const table = tables.find((t) => t.id === tableId);

  if (table) {
    return <TableOrder branchId={branchId} table={table} onBack={() => setTableId(null)} />;
  }

  const areas = [...new Set(tables.map((t) => t.area))];
  const occupied = tables.filter((t) => t.status === 'occupied');
  const shown = tables.filter(
    (t) => (status === 'all' || t.status === status) && (!area || t.area === area),
  );
  const shownAreas = areas.filter((a) => shown.some((t) => t.area === a));
  const openTotal = occupied.reduce((s, t) => s + t.openTotalMinor, 0);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Tables</h1>
          <p className={cn('mt-0.5 text-sm', muted)}>Select a table to take an order.</p>
        </div>
        <dl className="flex gap-6 text-sm">
          <Stat label="Occupied" value={`${occupied.length} / ${tables.length}`} />
          <Stat label="Open bills" value={money(openTotal)} />
        </dl>
      </div>

      <div className="sticky top-14 z-20 -mx-4 mt-4 flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50/95 px-4 py-2.5 backdrop-blur sm:-mx-6 sm:px-6 dark:border-white/10 dark:bg-slate-950/95">
        <Segmented
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: 'All', count: tables.length },
            { value: 'free', label: 'Free', count: tables.length - occupied.length },
            { value: 'occupied', label: 'Occupied', count: occupied.length },
          ]}
        />
        {areas.length > 1 ? (
          <select
            aria-label="Area"
            value={area}
            onChange={(e) => setArea(e.target.value)}
            className="h-9 rounded-md border border-slate-200 bg-white px-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-emerald-500/30 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200"
          >
            <option value="">All areas</option>
            {areas.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {shown.length === 0 ? (
        <p className={cn('mt-12 text-center text-sm', muted)}>
          No {status === 'all' ? '' : `${status} `}tables{area ? ` in ${area}` : ''}.
        </p>
      ) : (
        <div className="mt-5 space-y-6">
          {shownAreas.map((a) => (
            <section key={a}>
              <h2 className={cn('mb-2.5 text-sm font-medium', muted)}>{a}</h2>
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-3">
                {shown
                  .filter((t) => t.area === a)
                  .map((t) => (
                    <li key={t.id}>
                      <TableTile table={t} onOpen={() => setTableId(t.id)} />
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className={cn('text-xs', muted)}>{label}</dt>
      <dd className="font-semibold text-slate-900 tabular-nums dark:text-white">{value}</dd>
    </div>
  );
}

function StatusDot({ busy }: { busy: boolean }) {
  return (
    <span
      className={cn('size-2 shrink-0 rounded-full', busy ? 'bg-amber-500' : 'bg-emerald-500')}
      aria-hidden
    />
  );
}

function TableTile({ table: t, onOpen }: { table: DiningTable; onOpen: () => void }) {
  const busy = t.status === 'occupied';
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Table ${t.label}, ${busy ? `occupied, ${money(t.openTotalMinor)}` : 'free'}`}
      className={cn(
        card,
        'flex min-h-28 w-full flex-col p-3.5 text-left transition-colors hover:border-slate-300 focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:outline-none dark:hover:border-white/20',
        busy && 'border-amber-300 dark:border-amber-500/40',
      )}
    >
      <span className="flex w-full items-start justify-between">
        <span className="text-lg font-semibold tracking-tight">{t.label}</span>
        <span className={cn('flex items-center gap-1 text-xs', muted)}>
          <Users className="size-3.5" aria-hidden />
          {t.seats}
        </span>
      </span>
      <span className="mt-auto w-full pt-3">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          <StatusDot busy={busy} />
          <span className={busy ? 'text-slate-700 dark:text-slate-200' : muted}>
            {busy ? 'Occupied' : 'Free'}
          </span>
          {busy ? <span className={cn('ml-auto font-normal', muted)}>{since(t.since)}</span> : null}
        </span>
        {busy ? (
          <span className="mt-1 block text-sm font-semibold tabular-nums">
            {money(t.openTotalMinor)}
          </span>
        ) : null}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// Table: order taking

/** Open dine-in orders at this table (the list endpoint has no table filter). */
function useTableOrders(branchId: string, label: string) {
  const { client } = useAuth();
  const profile = useProfile();
  return useQuery({
    queryKey: ['orders', profile.activeTenant?.id, 'table', branchId, label.toLowerCase()],
    queryFn: async () => {
      const q = new URLSearchParams({ branchId, status: 'open', limit: '100' });
      const rows = await client.request<{ id: string; tableLabel: string | null }[]>(
        `/orders?${q}`,
      );
      const mine = rows.filter((o) => o.tableLabel?.toLowerCase() === label.toLowerCase());
      return Promise.all(mine.map((o) => client.request<Order>(`/orders/${o.id}`)));
    },
    refetchInterval: 15_000,
  });
}

type Cart = Record<string, number>; // "itemId" or "itemId:variantId" → quantity
type PanelTab = 'new' | 'table';

interface Line {
  key: string;
  item: MenuItem;
  variantName: string | null;
  variantId: string | null;
  qty: number;
  price: number;
}

function TableOrder({
  branchId,
  table,
  onBack,
}: {
  branchId: string;
  table: DiningTable;
  onBack: () => void;
}) {
  const menu = useMenu(branchId);
  const orders = useTableOrders(branchId, table.label);
  const { create } = useOrderMutations();
  const [cart, setCart] = useState<Cart>({});
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [note, setNote] = useState('');
  const [requestId, setRequestId] = useState(() => `waiter-${crypto.randomUUID()}`);
  const [sent, setSent] = useState<string | null>(null);
  const [tab, setTab] = useState<PanelTab>('new');
  const [sheet, setSheet] = useState(false);
  // Separate bills at one table (parties sharing it). Orders without a bill count as bill A.
  const [bill, setBill] = useState('A');
  const [extraBills, setExtraBills] = useState<string[]>([]);
  const [course, setCourse] = useState('');

  // Escape closes the sheet; the page behind does not scroll while it is open.
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSheet(false);
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [sheet]);

  const categories = (menu.data?.categories ?? []).filter((c) => c.isActive);
  const visible = new Set(categories.map((c) => c.id));
  const q = search.trim().toLowerCase();
  const items = (menu.data?.items ?? []).filter(
    (i) =>
      visible.has(i.categoryId) &&
      (!category || i.categoryId === category) &&
      (!q || i.name.toLowerCase().includes(q) || i.description?.toLowerCase().includes(q)),
  );

  const lines: Line[] = Object.entries(cart).flatMap(([key, qty]) => {
    const [itemId, variantId] = key.split(':');
    const item = menu.data?.items.find((i) => i.id === itemId);
    if (!item) return [];
    const variant = variantId ? item.variants.find((v) => v.id === variantId) : undefined;
    if (variantId && !variant) return [];
    return [
      {
        key,
        item,
        variantId: variant?.id ?? null,
        variantName: variant?.name ?? null,
        qty,
        price: variant?.priceMinor ?? item.priceMinor,
      },
    ];
  });
  const count = lines.reduce((n, l) => n + l.qty, 0);
  const cartTotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const open = orders.data ?? [];
  const runningTotal = open.reduce((s, o) => s + o.totalMinor, 0);
  const bills = [...new Set(['A', ...open.map((o) => o.billLabel ?? 'A'), ...extraBills])].sort();
  const newBill = () => {
    let code = 65;
    while (bills.includes(String.fromCharCode(code))) code++;
    const next = String.fromCharCode(code);
    setExtraBills((b) => [...b, next]);
    setBill(next);
  };

  const add = (key: string, d: number) => {
    setSent(null);
    setCart((c) => {
      const n = (c[key] ?? 0) + d;
      const next = { ...c };
      if (n <= 0) delete next[key];
      else next[key] = n;
      return next;
    });
  };

  const send = async () => {
    setSent(null);
    try {
      const order = await create.mutateAsync({
        requestId,
        branchId,
        channel: 'dine_in',
        tableLabel: table.label,
        billLabel: bill,
        note: [course, note.trim()].filter(Boolean).join(' · ') || null,
        couponCode: null,
        customer: null,
        lines: lines.map((l) => ({
          menuItemId: l.item.id,
          variantId: l.variantId,
          quantity: l.qty,
        })),
      });
      setCart({});
      setNote('');
      setCourse('');
      setRequestId(`waiter-${crypto.randomUUID()}`);
      setSent(`Order #${order.orderNumber} (Bill ${bill}) sent to the kitchen`);
      setTab('table');
      void orders.refetch();
    } catch {
      // Shown from create.error.
    }
  };

  const panel = (
    <OrderPanel
      tab={tab}
      onTab={setTab}
      lines={lines}
      count={count}
      cartTotal={cartTotal}
      onChange={add}
      note={note}
      onNote={setNote}
      onSend={send}
      sending={create.isPending}
      error={create.error ? authErrorMessage(create.error) : null}
      sent={sent}
      open={open}
      runningTotal={runningTotal}
      loadingOrders={orders.isPending}
      bill={bill}
      bills={bills}
      onBill={setBill}
      onNewBill={newBill}
      course={course}
      onCourse={setCourse}
    />
  );

  const openSheet = (t: PanelTab) => {
    setTab(t);
    setSheet(true);
  };

  return (
    <div className="mx-auto w-full max-w-7xl">
      {/* Table bar: title, search, categories */}
      <div className="sticky top-14 z-20 border-b border-slate-200 bg-white dark:border-white/10 dark:bg-slate-900">
        <div className="flex items-center gap-3 px-4 pt-3 sm:px-6">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to tables"
            className={cn(outlineBtn, 'size-9 shrink-0')}
          >
            <ArrowLeft className="size-4" />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base leading-tight font-semibold sm:text-lg">
              Table {table.label}
            </h1>
            <p className={cn('truncate text-xs', muted)}>
              {table.area} · {table.seats} seats{bills.length > 1 ? ` · ${bills.length} bills` : ''}
            </p>
          </div>
          {open.length ? (
            <button
              type="button"
              onClick={() => openSheet('table')}
              className="shrink-0 text-right lg:pointer-events-none"
            >
              <span className={cn('block text-xs', muted)}>Table total</span>
              <span className="block text-sm font-semibold tabular-nums">
                {money(runningTotal)}
              </span>
            </button>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 px-4 pt-3 pb-3 sm:flex-row sm:items-center sm:px-6">
          <div className="relative sm:w-64 sm:shrink-0">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search dishes"
              aria-label="Search dishes"
              className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 pr-3 pl-9 text-base outline-none focus:border-emerald-600 focus:bg-white focus:ring-4 focus:ring-emerald-600/15 sm:text-sm dark:border-white/10 dark:bg-white/5"
            />
          </div>
          <nav
            aria-label="Categories"
            className="-mx-4 flex gap-1 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0"
          >
            {[{ id: '', name: 'All' }, ...categories].map((c) => (
              <button
                key={c.id || 'all'}
                type="button"
                onClick={() => setCategory(c.id)}
                aria-pressed={category === c.id}
                className={cn(
                  'h-8 shrink-0 rounded-md px-3 text-sm whitespace-nowrap transition-colors',
                  category === c.id
                    ? 'bg-slate-900 font-medium text-white dark:bg-white dark:text-slate-900'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/5',
                )}
              >
                {c.name}
              </button>
            ))}
          </nav>
        </div>
      </div>

      <div className="grid gap-6 px-4 pt-4 pb-28 sm:px-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:pb-8">
        {/* Menu */}
        <div className="min-w-0">
          {menu.isPending ? (
            <ul className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3" aria-hidden>
              {Array.from({ length: 6 }, (_, i) => (
                <li
                  key={i}
                  className="h-[5.5rem] animate-pulse rounded-lg bg-slate-200/70 dark:bg-white/5"
                />
              ))}
            </ul>
          ) : menu.isError ? (
            <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
              {authErrorMessage(menu.error)}
            </p>
          ) : items.length === 0 ? (
            <p className={cn('py-12 text-center text-sm', muted)}>No dishes found.</p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
              {items.map((item) => (
                <MenuCard key={item.id} item={item} cart={cart} onAdd={add} />
              ))}
            </ul>
          )}
        </div>

        {/* Desktop: side panel */}
        <aside className="hidden lg:block">
          <div
            className={cn(
              card,
              'sticky top-[11.5rem] flex max-h-[calc(100dvh-12.5rem)] flex-col overflow-hidden',
            )}
          >
            {panel}
          </div>
        </aside>
      </div>

      {/* Phones and tablets: bottom bar */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 lg:hidden dark:border-white/10 dark:bg-slate-900">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <button
            type="button"
            onClick={() => openSheet(count ? 'new' : 'table')}
            className="min-w-0 flex-1 text-left"
          >
            <span className={cn('block text-xs', muted)}>
              {count
                ? `Bill ${bill} · ${count} item${count > 1 ? 's' : ''} · tap to review`
                : 'On the table'}
            </span>
            <span className="block truncate text-sm font-semibold tabular-nums">
              {count ? money(cartTotal) : open.length ? money(runningTotal) : 'Nothing yet'}
            </span>
          </button>
          {count ? (
            <button
              type="button"
              onClick={send}
              disabled={create.isPending}
              className={cn(primaryBtn, 'h-11 px-5 text-sm')}
            >
              {create.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Send to kitchen
            </button>
          ) : (
            <button
              type="button"
              onClick={() => openSheet('table')}
              className={cn(outlineBtn, 'h-11 px-4 text-sm')}
            >
              View table <ChevronRight className="size-4" aria-hidden />
            </button>
          )}
        </div>
        {sent || create.error ? (
          <p
            className={cn(
              'mx-auto mt-2 max-w-2xl text-xs',
              create.error ? 'text-red-600' : 'text-emerald-700 dark:text-emerald-400',
            )}
          >
            {create.error ? authErrorMessage(create.error) : sent}
          </p>
        ) : null}
      </div>

      {/* Phones and tablets: sheet */}
      <AnimatePresence>
        {sheet ? (
          <div className="fixed inset-0 z-40 lg:hidden">
            <motion.div
              className="absolute inset-0 bg-slate-900/40"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSheet(false)}
            />
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label={`Table ${table.label} order`}
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'tween', duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="absolute inset-x-0 bottom-0 mx-auto flex max-h-[85dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-xl border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] dark:border-white/10 dark:bg-slate-900"
            >
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-white/10">
                <h2 className="text-sm font-semibold">Table {table.label}</h2>
                <button
                  type="button"
                  onClick={() => setSheet(false)}
                  aria-label="Close"
                  className="flex size-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-white/10"
                >
                  <X className="size-4" />
                </button>
              </div>
              {panel}
            </motion.div>
          </div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function OrderPanel(p: {
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  lines: Line[];
  count: number;
  cartTotal: number;
  onChange: (key: string, d: number) => void;
  note: string;
  onNote: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  error: string | null;
  sent: string | null;
  open: Order[];
  runningTotal: number;
  loadingOrders: boolean;
  bill: string;
  bills: string[];
  onBill: (b: string) => void;
  onNewBill: () => void;
  course: string;
  onCourse: (c: string) => void;
}) {
  const byBill = p.bills
    .map((b) => ({
      bill: b,
      orders: p.open.filter((o) => (o.billLabel ?? 'A') === b),
    }))
    .filter((g) => g.orders.length > 0);
  return (
    <>
      <div className="flex shrink-0 border-b border-slate-200 px-4 dark:border-white/10">
        {(
          [
            ['new', 'New order', p.count],
            ['table', 'On the table', p.open.length],
          ] as const
        ).map(([key, label, n]) => (
          <button
            key={key}
            type="button"
            onClick={() => p.onTab(key)}
            aria-selected={p.tab === key}
            role="tab"
            className={cn(
              '-mb-px flex h-11 items-center gap-1.5 border-b-2 px-1 text-sm transition-colors not-first:ml-5',
              p.tab === key
                ? 'border-emerald-600 font-medium text-slate-900 dark:text-white'
                : 'border-transparent text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white',
            )}
          >
            {label}
            {n ? (
              <span className="rounded bg-slate-100 px-1.5 text-xs leading-5 text-slate-600 tabular-nums dark:bg-white/10 dark:text-slate-300">
                {n}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {p.tab === 'new' ? (
        <>
          <div className="shrink-0 space-y-2.5 border-b border-slate-100 px-4 py-3 dark:border-white/5">
            <div className="flex items-center gap-2">
              <span className={cn('w-14 shrink-0 text-xs', muted)}>Bill</span>
              <div className="flex flex-wrap gap-1.5">
                {p.bills.map((b) => (
                  <button
                    key={b}
                    type="button"
                    aria-pressed={p.bill === b}
                    onClick={() => p.onBill(b)}
                    className={cn(
                      'h-8 min-w-8 rounded-md border px-2.5 text-sm font-medium',
                      p.bill === b
                        ? 'border-slate-900 bg-slate-900 text-white dark:border-white dark:bg-white dark:text-slate-900'
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/5',
                    )}
                  >
                    {b}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={p.onNewBill}
                  className="inline-flex h-8 items-center gap-1 rounded-md border border-dashed border-slate-300 px-2.5 text-sm text-slate-600 hover:bg-slate-50 dark:border-white/15 dark:text-slate-300 dark:hover:bg-white/5"
                >
                  <Plus className="size-3.5" aria-hidden /> New bill
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className={cn('w-14 shrink-0 text-xs', muted)}>Course</span>
              <div className="flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
                {COURSES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={p.course === c}
                    onClick={() => p.onCourse(p.course === c ? '' : c)}
                    className={cn(
                      'h-8 shrink-0 rounded-md border px-2.5 text-sm whitespace-nowrap',
                      p.course === c
                        ? 'border-emerald-600 bg-emerald-50 font-medium text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300'
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/5',
                    )}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4">
            {p.lines.length === 0 ? (
              <div className="py-10 text-center">
                {p.sent ? (
                  <p className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                    <Check className="size-4" /> {p.sent}
                  </p>
                ) : (
                  <p className={cn('text-sm', muted)}>Add dishes from the menu.</p>
                )}
              </div>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-white/5">
                {p.lines.map((l) => (
                  <li key={l.key} className="flex items-center gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{l.item.name}</p>
                      <p className={cn('text-xs', muted)}>
                        {l.variantName ? `${l.variantName} · ` : ''}
                        {money(l.price)}
                      </p>
                    </div>
                    <Stepper
                      qty={l.qty}
                      onChange={(d) => p.onChange(l.key, d)}
                      label={l.item.name}
                    />
                    <span className="w-16 text-right text-sm tabular-nums">
                      {money(l.price * l.qty)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="shrink-0 space-y-3 border-t border-slate-200 p-4 dark:border-white/10">
            <input
              value={p.note}
              onChange={(e) => p.onNote(e.target.value)}
              maxLength={200}
              placeholder="Note for the kitchen (optional)"
              aria-label="Note for the kitchen"
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-base outline-none focus:border-emerald-600 focus:ring-4 focus:ring-emerald-600/15 sm:text-sm dark:border-white/10 dark:bg-white/5"
            />
            {p.error ? (
              <p className="rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
                {p.error}
              </p>
            ) : null}
            <div className="flex items-center justify-between text-sm">
              <span className={muted}>Subtotal</span>
              <span className="font-semibold tabular-nums">{money(p.cartTotal)}</span>
            </div>
            <button
              type="button"
              onClick={p.onSend}
              disabled={p.lines.length === 0 || p.sending}
              className={cn(primaryBtn, 'h-10 w-full text-sm')}
            >
              {p.sending ? <Loader2 className="size-4 animate-spin" /> : null}
              Send to kitchen
            </button>
          </div>
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {p.sent ? (
            <p className="mb-4 flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400">
              <Check className="size-4 shrink-0" /> {p.sent}
            </p>
          ) : null}
          {p.loadingOrders ? (
            <Loader2 className="mx-auto mt-6 size-5 animate-spin text-slate-400" />
          ) : p.open.length === 0 ? (
            <p className={cn('py-6 text-center text-sm', muted)}>Nothing ordered yet.</p>
          ) : (
            <>
              <div className="space-y-6">
                {byBill.map((g) => (
                  <BillSummary
                    key={g.bill}
                    bill={g.bill}
                    orders={g.orders}
                    showName={byBill.length > 1}
                  />
                ))}
              </div>
              <div className="mt-5 flex items-center justify-between border-t border-slate-200 pt-3 dark:border-white/10">
                <span className="text-sm font-medium">
                  {byBill.length > 1 ? 'Table total' : 'Total'} (incl. tax)
                </span>
                <span className="text-base font-semibold tabular-nums">
                  {money(p.runningTotal)}
                </span>
              </div>
              <p className={cn('mt-1 text-xs', muted)}>Payment is taken at the POS.</p>
            </>
          )}
        </div>
      )}
    </>
  );
}

/**
 * One bill: a single combined item list and total, however many times the waiter pressed Send.
 * The kitchen rounds (each Send) are shown only as a compact status line.
 */
function BillSummary({
  bill,
  orders,
  showName,
}: {
  bill: string;
  orders: Order[];
  showName: boolean;
}) {
  const merged = new Map<
    string,
    { name: string; variant: string | null; qty: number; total: number }
  >();
  for (const o of orders) {
    for (const i of o.items) {
      if (i.status !== 'active') continue;
      const key = `${i.name}|${i.variantName ?? ''}|${i.unitPriceMinor}`;
      const m = merged.get(key) ?? { name: i.name, variant: i.variantName, qty: 0, total: 0 };
      m.qty += i.quantity;
      m.total += i.lineTotalMinor;
      merged.set(key, m);
    }
  }
  const total = orders.reduce((s, o) => s + o.totalMinor, 0);
  return (
    <section>
      {showName ? (
        <div className="mb-2 flex items-center justify-between rounded-md bg-slate-50 px-2.5 py-1.5 text-sm dark:bg-white/5">
          <span className="font-medium">Bill {bill}</span>
          <span className="font-semibold tabular-nums">{money(total)}</span>
        </div>
      ) : null}
      <ul className="space-y-1 text-sm">
        {[...merged.values()].map((m) => (
          <li key={`${m.name}|${m.variant ?? ''}|${m.total}`} className="flex gap-2">
            <span className={cn('w-7 shrink-0 tabular-nums', muted)}>{m.qty}×</span>
            <span className="min-w-0 flex-1 truncate">
              {m.name}
              {m.variant ? <span className={muted}> · {m.variant}</span> : null}
            </span>
            <span className="tabular-nums">{money(m.total)}</span>
          </li>
        ))}
      </ul>
      <ul className="mt-2.5 space-y-1 border-t border-dashed border-slate-200 pt-2 dark:border-white/10">
        {orders.map((o, n) => (
          <li key={o.id} className={cn('flex items-center gap-1.5 text-xs', muted)}>
            <span
              className={cn('size-1.5 shrink-0 rounded-full', KITCHEN[o.kitchenStatus].dot)}
              aria-hidden
            />
            <span className="truncate">
              {orders.length > 1 ? `Round ${n + 1}` : 'Kitchen'} · #{o.orderNumber}
              {o.note ? ` · ${o.note}` : ''}
            </span>
            <span className="ml-auto shrink-0">{KITCHEN[o.kitchenStatus].label}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MenuCard({
  item,
  cart,
  onAdd,
}: {
  item: MenuItem;
  cart: Cart;
  onAdd: (key: string, d: number) => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const options = item.variants.length
    ? item.variants.map((v) => ({ key: `${item.id}:${v.id}`, name: v.name, price: v.priceMinor }))
    : [{ key: item.id, name: null as string | null, price: item.priceMinor }];
  const inCart = options.some((o) => cart[o.key]);

  return (
    <li
      className={cn(
        card,
        'flex gap-3 p-3 transition-colors',
        inCart && 'border-emerald-500 dark:border-emerald-500/60',
        !item.isAvailable && 'opacity-60',
      )}
    >
      <div className="size-16 shrink-0 overflow-hidden rounded-md bg-slate-100 dark:bg-white/5">
        {item.imageUrl && !imgFailed ? (
          // eslint-disable-next-line @next/next/no-img-element -- uploaded menu photo
          <img
            src={item.imageUrl}
            alt=""
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="size-full object-cover"
          />
        ) : (
          <span className="flex size-full items-center justify-center text-slate-300 dark:text-slate-600">
            <UtensilsCrossed className="size-5" aria-hidden />
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start gap-1.5">
          <span
            className={cn(
              'relative mt-[3px] size-3.5 shrink-0 rounded-[3px] border after:absolute after:inset-[3px] after:rounded-full',
              DIET[item.diet].cls,
            )}
            role="img"
            aria-label={DIET[item.diet].label}
          />
          <p className="line-clamp-2 text-sm leading-snug font-medium">{item.name}</p>
        </div>
        {item.description ? (
          <p className={cn('mt-0.5 line-clamp-1 text-xs', muted)}>{item.description}</p>
        ) : null}
        <div className="mt-auto space-y-1.5 pt-2">
          {!item.isAvailable ? (
            <p className={cn('text-xs font-medium', muted)}>Sold out</p>
          ) : (
            options.map((o) => {
              const qty = cart[o.key] ?? 0;
              const name = `${item.name}${o.name ? ` ${o.name}` : ''}`;
              return (
                <div key={o.key} className="flex items-center justify-between gap-2">
                  <span className="text-sm">
                    {o.name ? <span className={muted}>{o.name} · </span> : null}
                    <span className="font-medium tabular-nums">{money(o.price)}</span>
                  </span>
                  {qty ? (
                    <Stepper qty={qty} onChange={(d) => onAdd(o.key, d)} label={name} />
                  ) : (
                    <button
                      type="button"
                      onClick={() => onAdd(o.key, 1)}
                      aria-label={`Add ${name}`}
                      className={cn(outlineBtn, 'h-8 px-3 text-sm')}
                    >
                      <Plus className="size-3.5" aria-hidden /> Add
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </li>
  );
}

function Stepper({
  qty,
  onChange,
  label,
}: {
  qty: number;
  onChange: (d: number) => void;
  label: string;
}) {
  return (
    <span className="inline-flex h-8 items-center rounded-md border border-slate-200 bg-white dark:border-white/10 dark:bg-slate-900">
      <button
        type="button"
        onClick={() => onChange(-1)}
        aria-label={`One less ${label}`}
        className="flex h-full w-8 items-center justify-center rounded-l-md text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-white/5"
      >
        <Minus className="size-3.5" />
      </button>
      <span className="w-7 border-x border-slate-200 text-center text-sm leading-[1.875rem] font-medium tabular-nums dark:border-white/10">
        {qty}
      </span>
      <button
        type="button"
        onClick={() => onChange(1)}
        aria-label={`One more ${label}`}
        className="flex h-full w-8 items-center justify-center rounded-r-md text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-white/5"
      >
        <Plus className="size-3.5" />
      </button>
    </span>
  );
}
