'use client';

import { cn } from '@foodstack/ui/lib/utils';
import {
  Armchair,
  Bike,
  ChefHat,
  ChevronDown,
  Loader2,
  Minus,
  Plus,
  ShoppingBag,
  StickyNote,
  Tag,
  Trash2,
  UtensilsCrossed,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { COUPON_REASON, type QuoteResult } from '@/lib/promotions';
import type { PosTable } from './catalog';
import { FoodImage } from './food-image';
import { inr, type OrderLine, orderTotals, unitPrice } from './order-math';
import { type PaymentMethod, PaymentSection } from './payment-section';

export const ORDER_TYPES = [
  { id: 'dine-in', label: 'Dine In', icon: UtensilsCrossed },
  { id: 'takeaway', label: 'Takeaway', icon: ShoppingBag },
  { id: 'delivery', label: 'Delivery', icon: Bike },
] as const;
export type OrderType = (typeof ORDER_TYPES)[number]['id'];

export interface OrderPanelProps {
  lines: OrderLine[];
  tables: PosTable[];
  orderType: OrderType;
  onOrderType: (t: OrderType) => void;
  tableId: string | null;
  onTable: (id: string) => void;
  note: string;
  onNote: (n: string) => void;
  /** Server quote for the current cart (null while empty). */
  quote: QuoteResult | null;
  quoting: boolean;
  quoteError: string | null;
  couponCode: string | null;
  onCoupon: (code: string | null) => void;
  payment: PaymentMethod | null;
  onPayment: (m: PaymentMethod) => void;
  onChange: (id: string, delta: number) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onPlaceOrder?: () => void;
  placing?: boolean;
  placeError?: string | null;
}

export function OrderPanel(p: OrderPanelProps) {
  const [tablesOpen, setTablesOpen] = useState(true);
  const totals = orderTotals(p.lines, p.quote?.discountMinor ?? 0);
  const empty = p.lines.length === 0;
  const needsTable = p.orderType === 'dine-in' && !p.tableId;
  const table = p.tables.find((t) => t.id === p.tableId);

  return (
    <div className="flex min-h-0 w-full flex-col bg-white dark:bg-slate-950">
      <div className="flex items-center justify-between px-5 pt-4 pb-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">Current Order</h2>
          <p className="text-xs text-slate-500">
            {p.orderType === 'dine-in'
              ? table
                ? `Table ${table.label}`
                : 'No table selected'
              : ORDER_TYPES.find((o) => o.id === p.orderType)?.label}
            {' · '}
            {p.lines.reduce((n, l) => n + l.qty, 0)} items
          </p>
        </div>
        <button
          type="button"
          onClick={p.onClear}
          disabled={empty}
          className="mr-8 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:pointer-events-none disabled:opacity-0 lg:mr-0 dark:hover:bg-red-500/10"
        >
          <Trash2 className="size-4" />
          Clear All
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-5 pb-4">
        {/* Order type */}
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Order type">
          {ORDER_TYPES.map(({ id, label, icon: Icon }) => {
            const on = p.orderType === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => p.onOrderType(id)}
                className={cn(
                  'flex h-11 items-center justify-center gap-1.5 rounded-xl border text-sm font-medium transition-all',
                  on
                    ? 'border-emerald-600 bg-emerald-600 text-white shadow-sm shadow-emerald-600/20'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50 dark:border-white/10 dark:bg-transparent dark:text-slate-300',
                )}
              >
                <Icon className="size-4" />
                {label}
              </button>
            );
          })}
        </div>

        {/* Tables */}
        {p.orderType === 'dine-in' ? (
          <div className="rounded-xl border border-slate-200 dark:border-white/10">
            <button
              type="button"
              onClick={() => setTablesOpen((o) => !o)}
              aria-expanded={tablesOpen}
              className="flex w-full items-center justify-between px-3.5 py-3 text-sm font-semibold text-slate-900 dark:text-white"
            >
              <span className="flex items-center gap-2">
                <Armchair className="size-4 text-slate-500" />
                Table Selection
                {table ? (
                  <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                    {table.label}
                  </span>
                ) : null}
              </span>
              <ChevronDown
                className={cn(
                  'size-4 text-slate-500 transition-transform',
                  tablesOpen && 'rotate-180',
                )}
              />
            </button>
            <AnimatePresence initial={false}>
              {tablesOpen ? (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <div className="grid grid-cols-6 gap-2 px-3.5">
                    {p.tables.map((t) => {
                      const on = p.tableId === t.id;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          disabled={t.occupied}
                          onClick={() => p.onTable(t.id)}
                          aria-pressed={on}
                          aria-label={`Table ${t.label}${t.occupied ? ', occupied' : ', available'}`}
                          className={cn(
                            'relative h-9 rounded-lg border text-xs font-semibold transition-all',
                            on
                              ? 'border-emerald-600 bg-emerald-600 text-white'
                              : t.occupied
                                ? 'cursor-not-allowed border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'
                                : 'border-slate-200 bg-white text-slate-700 hover:border-emerald-400 dark:border-white/10 dark:bg-transparent dark:text-slate-300',
                          )}
                        >
                          {t.label}
                          <span
                            className={cn(
                              'absolute top-1 right-1 size-1.5 rounded-full',
                              t.occupied ? 'bg-amber-500' : on ? 'bg-white' : 'bg-emerald-500',
                            )}
                          />
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex gap-4 px-3.5 pt-2.5 pb-3 text-[11px] text-slate-500">
                    <span className="flex items-center gap-1.5">
                      <span className="size-1.5 rounded-full bg-emerald-500" />
                      Available
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="size-1.5 rounded-full bg-amber-500" />
                      Occupied
                    </span>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        ) : null}

        {/* Cart lines */}
        {empty ? (
          <div className="flex flex-col items-center rounded-xl border border-dashed border-slate-200 px-6 py-10 text-center dark:border-white/10">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400 dark:bg-white/5">
              <ShoppingBag className="size-5" />
            </div>
            <p className="mt-3 text-sm font-semibold text-slate-900 dark:text-white">
              Order is empty
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Add dishes from the menu to start an order.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-white/5">
            <AnimatePresence initial={false}>
              {p.lines.map((line) => {
                const { key, item, variant, qty } = line;
                const label = variant ? `${item.name} (${variant.name})` : item.name;
                return (
                  <motion.li
                    key={key}
                    layout
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="flex items-center gap-3 py-3">
                      <FoodImage
                        src={item.imageUrl}
                        alt=""
                        className="size-12 shrink-0 rounded-xl"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                          {item.name}
                          {variant ? (
                            <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600 dark:bg-white/10 dark:text-slate-300">
                              {variant.name}
                            </span>
                          ) : null}
                        </p>
                        <p className="text-xs text-slate-500 tabular-nums">
                          {inr.format(unitPrice(line))} each
                        </p>
                      </div>
                      <div className="flex items-center rounded-lg border border-slate-200 dark:border-white/10">
                        <button
                          type="button"
                          onClick={() => p.onChange(key, -1)}
                          aria-label={`Decrease ${label}`}
                          className="flex size-8 items-center justify-center rounded-l-lg text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/10"
                        >
                          <Minus className="size-3.5" />
                        </button>
                        <span
                          className="w-6 text-center text-sm font-semibold tabular-nums"
                          aria-live="polite"
                        >
                          {qty}
                        </span>
                        <button
                          type="button"
                          onClick={() => p.onChange(key, 1)}
                          aria-label={`Increase ${label}`}
                          className="flex size-8 items-center justify-center rounded-r-lg text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/10"
                        >
                          <Plus className="size-3.5" />
                        </button>
                      </div>
                      <span className="w-[4.5rem] text-right text-sm font-semibold tabular-nums text-slate-900 dark:text-white">
                        {inr.format(unitPrice(line) * qty)}
                      </span>
                      <button
                        type="button"
                        onClick={() => p.onRemove(key)}
                        aria-label={`Remove ${label}`}
                        className="rounded-md p-1 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        )}

        {/* Kitchen note */}
        <label className="flex items-center gap-2.5 rounded-xl border border-slate-200 px-3.5 focus-within:border-emerald-500 focus-within:ring-4 focus-within:ring-emerald-500/10 dark:border-white/10">
          <StickyNote className="size-4 shrink-0 text-slate-400" />
          <span className="sr-only">Kitchen note</span>
          <input
            value={p.note}
            onChange={(e) => p.onNote(e.target.value)}
            placeholder="Add a note for the kitchen…"
            maxLength={200}
            className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
          />
        </label>
      </div>

      {/* Totals + payment */}
      <div className="space-y-3 border-t border-slate-200 bg-white px-5 pt-4 pb-5 dark:border-white/10 dark:bg-slate-950">
        <CouponBox
          code={p.couponCode}
          status={p.quote?.coupon ?? null}
          disabled={empty}
          onApply={p.onCoupon}
        />
        {p.quoteError ? (
          <p role="alert" className="text-xs text-red-600">
            {p.quoteError}
          </p>
        ) : null}
        <dl className={cn('space-y-2 text-sm transition-opacity', p.quoting && 'opacity-60')}>
          <Row label="Subtotal" value={inr.format(totals.subtotal)} />
          {p.quote?.applied.map((a) => (
            <div key={a.promotionId} className="flex items-center justify-between">
              <dt className="flex min-w-0 items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
                <Tag className="size-3.5 shrink-0" />
                <span className="truncate">{a.name}</span>
              </dt>
              <dd className="font-medium text-emerald-600 tabular-nums">
                − {inr.format(a.discountMinor / 100)}
              </dd>
            </div>
          ))}
          <Row label="GST (5%)" value={inr.format(totals.gst)} />
        </dl>
        <div className="flex items-center justify-between rounded-xl bg-emerald-50 px-4 py-3 dark:bg-emerald-500/10">
          <span className="font-semibold text-slate-900 dark:text-white">Total</span>
          <motion.span
            key={totals.total}
            initial={{ opacity: 0.4, y: -2 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-xl font-bold tabular-nums text-slate-900 dark:text-white"
          >
            {inr.format(totals.total)}
          </motion.span>
        </div>

        <PaymentSection method={p.payment} onMethod={p.onPayment} disabled={empty} />

        <button
          type="button"
          onClick={p.onPlaceOrder}
          disabled={empty || needsTable || !p.onPlaceOrder || p.placing || Boolean(p.quoteError)}
          className="flex h-13 w-full items-center justify-center gap-2.5 rounded-xl bg-emerald-600 text-base font-semibold text-white shadow-md shadow-emerald-600/20 transition-all hover:bg-emerald-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500 disabled:shadow-none dark:disabled:bg-white/10"
        >
          {p.placing ? <Loader2 className="size-5 animate-spin" /> : <ChefHat className="size-5" />}
          {p.placing ? 'Sending…' : 'Send to Kitchen'}
        </button>
        {p.placeError ? (
          <p role="alert" className="text-center text-xs text-red-600">
            {p.placeError}
          </p>
        ) : (
          <p className="text-center text-xs text-slate-500" aria-live="polite">
            {empty
              ? 'Add items to place an order'
              : needsTable
                ? 'Select a table for dine-in orders'
                : 'The bill can be paid now or after the meal'}
          </p>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-slate-500">{label}</dt>
      <dd className="tabular-nums text-slate-700 dark:text-slate-300">{value}</dd>
    </div>
  );
}

function CouponBox(p: {
  code: string | null;
  status: QuoteResult['coupon'];
  disabled: boolean;
  onApply: (code: string | null) => void;
}) {
  const [draft, setDraft] = useState('');
  if (p.code) {
    const rejected = p.status?.status === 'rejected';
    return (
      <div
        className={cn(
          'flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm',
          rejected
            ? 'border-red-200 bg-red-50 dark:bg-red-500/10'
            : 'border-emerald-200 bg-emerald-50 dark:bg-emerald-500/10',
        )}
      >
        <div className="min-w-0">
          <p className="font-mono font-semibold">{p.code}</p>
          <p
            className={cn(
              'text-xs',
              rejected ? 'text-red-600' : 'text-emerald-700 dark:text-emerald-300',
            )}
          >
            {rejected
              ? (COUPON_REASON[p.status!.reason ?? ''] ?? 'Not valid.')
              : p.status
                ? 'Applied'
                : 'Checking…'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => p.onApply(null)}
          className="text-xs font-medium text-slate-600 hover:underline dark:text-slate-300"
        >
          Remove
        </button>
      </div>
    );
  }
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.trim()) p.onApply(draft.trim().toUpperCase());
        setDraft('');
      }}
    >
      <label className="flex flex-1 items-center gap-2 rounded-xl border border-slate-200 px-3 focus-within:border-emerald-500 dark:border-white/10">
        <Tag className="size-4 shrink-0 text-slate-400" />
        <span className="sr-only">Coupon code</span>
        <input
          value={draft}
          disabled={p.disabled}
          onChange={(e) => setDraft(e.target.value.toUpperCase().replace(/\s/g, ''))}
          maxLength={32}
          placeholder="Coupon code"
          className="h-10 flex-1 bg-transparent font-mono text-sm uppercase outline-none placeholder:font-sans placeholder:normal-case placeholder:text-slate-400"
        />
      </label>
      <button
        type="submit"
        disabled={p.disabled || !draft.trim()}
        className="h-10 rounded-xl border border-slate-200 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-white/10 dark:text-slate-200"
      >
        Apply
      </button>
    </form>
  );
}
