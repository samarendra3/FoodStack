'use client';

import { AlertBanner } from '@foodstack/ui/components/alert-banner';
import { ShoppingBag, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { type Diet, usePosCatalog } from './catalog';
import { TableBillsButton } from './table-bills';
import { useWorkspaceBranch } from '@/components/workspace/workspace-page';
import { authErrorMessage } from '@/lib/auth/errors';
import { useNotify } from '@/lib/notify';
import { useQuote } from '@/lib/promotions';
import { type Order, useOrderMutations } from '@/lib/orders';
import { inr, lineKey, type OrderLine, orderTotals } from './order-math';
import { PaymentDialog } from './payment-dialog';
import { OrderPanel, type OrderType } from './order-panel';
import type { PaymentMethod } from './payment-section';
import { ProductSection } from './product-grid';

const newRequestId = () => `pos-${crypto.randomUUID()}`;

const CHANNEL = { 'dine-in': 'dine_in', takeaway: 'takeaway', delivery: 'delivery' } as const;

export function PosTerminal() {
  const catalog = usePosCatalog();
  const notify = useNotify();
  const [category, setCategory] = useState('All');
  const [query, setQuery] = useState('');
  const [diet, setDiet] = useState<Diet | null>(null);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [orderType, setOrderType] = useState<OrderType>('dine-in');
  const [tableId, setTableId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [couponCode, setCouponCode] = useState<string | null>(null);
  const branchId = useWorkspaceBranch();
  const [payment, setPayment] = useState<PaymentMethod | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const { create } = useOrderMutations();
  const [placed, setPlaced] = useState<Order | null>(null);
  const [placeError, setPlaceError] = useState<string | null>(null);
  // One key per attempt: a retried click after a network error cannot create a second order.
  const [requestId, setRequestId] = useState(newRequestId);

  const lines: OrderLine[] = Object.entries(cart).flatMap(([key, qty]) => {
    const [itemId, variantId] = key.split(':');
    const item = catalog.items.find((i) => i.id === itemId);
    if (!item) return [];
    const variant = variantId ? (item.variants.find((v) => v.id === variantId) ?? null) : null;
    if (variantId && !variant) return [];
    return [{ key, item, variant, qty }];
  });
  const qtyByItem: Record<string, number> = {};
  for (const l of lines) qtyByItem[l.item.id] = (qtyByItem[l.item.id] ?? 0) + l.qty;
  const count = lines.reduce((n, l) => n + l.qty, 0);
  const quote = useQuote({
    branchId,
    channel: CHANNEL[orderType],
    couponCode,
    lines: lines.map((l) => ({
      menuItemId: l.item.id,
      variantId: l.variant?.id ?? null,
      quantity: l.qty,
    })),
  });
  const currentQuote = lines.length > 0 ? (quote.data ?? null) : null;
  const { total } = orderTotals(lines, currentQuote?.discountMinor ?? 0);

  const change = (id: string, delta: number) =>
    setCart((c) => {
      const qty = (c[id] ?? 0) + delta;
      const next = { ...c };
      if (qty <= 0) delete next[id];
      else next[id] = qty;
      return next;
    });

  const reset = () => {
    setCart({});
    setNote('');
    setCouponCode(null);
    setPayment(null);
    setPlaceError(null);
    setRequestId(newRequestId());
  };

  const placeOrder = async () => {
    setPlaceError(null);
    try {
      const order = await create.mutateAsync({
        requestId,
        branchId,
        channel: CHANNEL[orderType],
        tableLabel:
          orderType === 'dine-in'
            ? (catalog.tables.find((t) => t.id === tableId)?.label ?? null)
            : null,
        note: note.trim() || null,
        couponCode: currentQuote?.coupon?.status === 'applied' ? couponCode : null,
        customer: null,
        lines: lines.map((l) => ({
          menuItemId: l.item.id,
          variantId: l.variant?.id ?? null,
          quantity: l.qty,
        })),
      });
      setPlaced(order);
      notify.success(`Order ${order.orderNumber} placed`, 'Sent to the kitchen.');
      setSheetOpen(false);
    } catch (e) {
      setPlaceError(authErrorMessage(e));
      notify.error(e, 'Order not placed');
    }
  };

  const remove = (id: string) =>
    setCart((c) => {
      const next = { ...c };
      delete next[id];
      return next;
    });

  const panel = (
    <OrderPanel
      lines={lines}
      tables={catalog.tables}
      orderType={orderType}
      onOrderType={setOrderType}
      tableId={tableId}
      onTable={setTableId}
      note={note}
      onNote={setNote}
      quote={currentQuote}
      quoting={quote.isFetching}
      quoteError={quote.isError && lines.length > 0 ? authErrorMessage(quote.error) : null}
      couponCode={couponCode}
      onCoupon={setCouponCode}
      payment={payment}
      onPayment={setPayment}
      onChange={change}
      onRemove={remove}
      onClear={reset}
      onPlaceOrder={placeOrder}
      placing={create.isPending}
      placeError={placeError}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {catalog.tablesAreSample ? (
        <AlertBanner layout="bar" variant="info" className="py-1.5 text-xs">
          Live menu and orders. Table numbers are placeholders until floors &amp; tables are set up.
        </AlertBanner>
      ) : null}
      {catalog.error ? (
        <AlertBanner layout="bar" variant="danger" title="The menu could not be loaded">
          {catalog.error}
        </AlertBanner>
      ) : null}

      {catalog.tablesAreSample ? null : (
        <div className="flex items-center justify-end border-b border-slate-200 px-4 py-2 dark:border-white/10">
          <TableBillsButton branchId={branchId} />
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <ProductSection
          items={catalog.items}
          categories={catalog.categories}
          isLoading={catalog.isLoading}
          menuEmpty={!catalog.isLoading && !catalog.error && catalog.items.length === 0}
          category={category}
          onCategory={setCategory}
          query={query}
          onQuery={setQuery}
          diet={diet}
          onDiet={setDiet}
          cart={qtyByItem}
          onAdd={(id, variantId) => change(lineKey(id, variantId), 1)}
        />

        <aside className="hidden w-[24rem] shrink-0 border-l border-slate-200 lg:flex dark:border-white/10">
          {panel}
        </aside>
      </div>

      {/* Tablet / mobile: summary bar opens the order as a sheet */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 p-3 backdrop-blur lg:hidden dark:border-white/10 dark:bg-slate-950/95">
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className="flex h-12 w-full items-center justify-between rounded-xl bg-emerald-600 px-4 font-semibold text-white shadow-sm active:scale-[0.99]"
        >
          <span className="flex items-center gap-2">
            <span className="relative">
              <ShoppingBag className="size-5" />
              {count > 0 ? (
                <span className="absolute -top-2 -right-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-white px-1 text-[10px] font-bold text-emerald-700">
                  {count}
                </span>
              ) : null}
            </span>
            View order
          </span>
          <span className="tabular-nums">{inr.format(total)}</span>
        </button>
      </div>

      {placed ? (
        <PaymentDialog
          order={placed}
          defaultMethod={payment === 'split' ? null : payment}
          onClose={() => {
            setPlaced(null);
            reset();
          }}
        />
      ) : null}

      <AnimatePresence>
        {sheetOpen ? (
          <div
            className="fixed inset-0 z-30 lg:hidden"
            role="dialog"
            aria-modal="true"
            aria-label="Current order"
          >
            <motion.div
              className="absolute inset-0 bg-slate-950/50 backdrop-blur-[2px]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSheetOpen(false)}
            />
            <motion.div
              className="absolute inset-y-0 right-0 flex w-full max-w-[26rem] shadow-2xl"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 32, stiffness: 320 }}
            >
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                aria-label="Close order"
                className="absolute top-4 right-3 z-10 rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-white/10"
              >
                <X className="size-5" />
              </button>
              {panel}
            </motion.div>
          </div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
