'use client';

import { ItemOptionsDialog, type OptionsItem } from '@/components/item-options-dialog';
import {
  type AddonGroup,
  addonProblem,
  decodeLine,
  encodeLine,
  pickedAddons,
} from '@/lib/cart-line';
import { ApiError } from '@foodstack/api-client';
import { cn } from '@foodstack/ui/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChefHat, Loader2, Minus, Plus, Receipt, ShoppingBag, UtensilsCrossed } from 'lucide-react';
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';

/*
 * What a guest sees after scanning a table's QR code. The device keeps a guest token per
 * restaurant; re-scanning restores the same guest, orders and balance. Each "Place order" is a
 * separate order with its own Idempotency-Key, so a double tap or a retry never orders twice.
 */

interface GuestOrder {
  id: string;
  orderNumber: number;
  createdAt: string;
  status: 'open' | 'completed' | 'cancelled';
  kitchenStatus: 'new' | 'accepted' | 'preparing' | 'ready' | 'served';
  itemCount: number;
  totalMinor: number;
  paidMinor: number;
  dueMinor: number;
}
interface GuestView {
  token?: string;
  restored?: boolean;
  restaurant: { id: string; name: string };
  session: {
    id: string;
    table: { label: string };
    branch: { id: string; name: string };
    currencyCode: string;
  };
  guest: {
    id: string;
    name: string;
    orders: GuestOrder[];
    totalMinor: number;
    paidMinor: number;
    outstandingMinor: number;
  };
  contact?: { phone: string | null; receiptConsent: boolean; marketingConsent: boolean };
}
type PayChoice = 'counter_cash' | 'counter_card';
const PAY_LABEL: Record<PayChoice, string> = {
  counter_cash: 'Cash at counter',
  counter_card: 'Card at counter',
};
/** The table's QR secret from the scanned link (`?k=`). */
const qrKey = () =>
  typeof window === 'undefined'
    ? undefined
    : (new URLSearchParams(window.location.search).get('k') ?? undefined);
interface PublicMenu {
  restaurant: { name: string; currencyCode: string; taxRateBp: number };
  categories: {
    id: string;
    name: string;
    items: {
      id: string;
      name: string;
      description: string | null;
      priceMinor: number;
      diet: 'veg' | 'non_veg' | 'egg';
      isAvailable: boolean;
      /** Portions such as Full / Half. When present, the guest must pick one. */
      variants?: { id: string; name: string; priceMinor: number }[];
      /** Add-on groups (only available options are sent to guests). */
      addonGroups?: AddonGroup[];
    }[];
  }[];
}

/** Cart keys: see lib/cart-line (portion, add-ons and instruction make a distinct line). */
const keyOf = (itemId: string, variantId?: string | null) =>
  encodeLine({ itemId, variantId: variantId ?? null, addonIds: [], note: '' });

const KITCHEN: Record<GuestOrder['kitchenStatus'], { label: string; cls: string }> = {
  new: { label: 'Sent to kitchen', cls: 'bg-sky-50 text-sky-700' },
  accepted: { label: 'Accepted', cls: 'bg-violet-50 text-violet-700' },
  preparing: { label: 'Preparing', cls: 'bg-amber-50 text-amber-700' },
  ready: { label: 'Ready', cls: 'bg-emerald-50 text-emerald-700' },
  served: { label: 'Served', cls: 'bg-slate-100 text-slate-600' },
};
const DIET = {
  veg: 'border-emerald-600',
  non_veg: 'border-red-600',
  egg: 'border-amber-500',
} as const;

const tokenKey = (tenantId: string) => `foodstack.guest.${tenantId}`;
const cartKey = (tenantId: string, tableId: string) => `foodstack.cart.${tenantId}.${tableId}`;
const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* private mode: works for this visit only */
  }
};
const codeOf = (e: unknown) =>
  e instanceof ApiError ? (e.problem as { code?: string }).code : undefined;
const messageOf = (e: unknown) =>
  e instanceof Error ? e.message : 'Something went wrong. Please try again.';

export default function GuestTablePage({
  params,
}: {
  params: Promise<{ tenantId: string; tableId: string }>;
}) {
  const { tenantId, tableId } = use(params);
  const qc = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [cart, setCart] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(read(cartKey(tenantId, tableId)) ?? '{}') as Record<string, number>;
    } catch {
      return {};
    }
  });
  const [tab, setTab] = useState<'menu' | 'bill'>('menu');
  const [placing, setPlacing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const pendingKey = useRef<string | null>(null);
  const [checkout, setCheckout] = useState(false);
  const [pay, setPay] = useState<PayChoice>('counter_cash');
  const [phone, setPhone] = useState<string | null>(null);
  const [receiptConsent, setReceiptConsent] = useState<boolean | null>(null);
  const [marketingConsent, setMarketingConsent] = useState<boolean | null>(null);

  /** Joins or restores; always safe to call again (re-scan, expiry, closed sitting). */
  const joinQuery = useQuery({
    queryKey: ['guest', tenantId, tableId, 'join'],
    queryFn: async () => {
      const saved = read(tokenKey(tenantId));
      const v = await api.request<GuestView>('/public/guest/join', {
        method: 'POST',
        body: { tenantId, tableId, ...(qrKey() ? { key: qrKey() } : {}) },
        headers: saved ? { 'X-Guest-Token': saved } : undefined,
      });
      write(tokenKey(tenantId), v.token!);
      setToken(v.token!);
      return v;
    },
    retry: false,
    staleTime: Infinity,
  });

  useEffect(
    () => write(cartKey(tenantId, tableId), Object.keys(cart).length ? JSON.stringify(cart) : null),
    [cart, tenantId, tableId],
  );

  const rejoin = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ['guest', tenantId, tableId, 'join'] });
  }, [qc, tenantId, tableId]);

  const bill = useQuery({
    queryKey: ['guest', tenantId, tableId, 'bill', token],
    queryFn: async () => {
      try {
        return await api.request<GuestView>('/public/guest', {
          headers: { 'X-Guest-Token': token! },
        });
      } catch (e) {
        const c = codeOf(e);
        if (c === 'GUEST_SESSION_EXPIRED' || c === 'SESSION_CLOSED' || c === 'GUEST_TOKEN_INVALID')
          await rejoin();
        throw e;
      }
    },
    enabled: Boolean(token),
    refetchInterval: 10_000,
  });

  const view = bill.data ?? joinQuery.data;
  const menu = useQuery({
    queryKey: ['guest', 'menu', tenantId, view?.restaurant.id, view?.session.branch.id],
    queryFn: () =>
      api.request<PublicMenu>(
        `/public/menu/${tenantId}/${view!.restaurant.id}?branchId=${view!.session.branch.id}`,
      ),
    enabled: Boolean(view),
    staleTime: 60_000,
  });

  const currency = view?.session.currencyCode ?? 'INR';
  const money = (m: number) =>
    new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(m / 100);
  const items = useMemo(
    () => new Map((menu.data?.categories ?? []).flatMap((c) => c.items).map((i) => [i.id, i])),
    [menu.data],
  );
  // Resolve each cart entry to an item (and portion). Entries whose item or portion no longer
  // exists, or an item that now has portions but was saved without one, are dropped.
  const lines = Object.entries(cart).flatMap(([key, quantity]) => {
    const { itemId, variantId, addonIds, note } = decodeLine(key);
    const item = items.get(itemId);
    if (!item?.isAvailable || quantity <= 0) return [];
    const variants = item.variants ?? [];
    const variant = variantId ? variants.find((v) => v.id === variantId) : undefined;
    if (variants.length ? !variant : variantId) return [];
    // Add-ons that were removed or sold out since the guest picked them drop the line, and so
    // does a line that no longer satisfies a required group; the guest picks again.
    const addons = pickedAddons(item.addonGroups, addonIds);
    if (addons.length !== addonIds.length || addonProblem(item.addonGroups, addonIds)) return [];
    return [
      {
        key,
        menuItemId: item.id,
        variantId: variant?.id ?? null,
        addonOptionIds: addonIds,
        note,
        quantity,
        label: [item.name, variant?.name, ...addons.map((a) => a.name)].filter(Boolean).join(' · '),
        priceMinor:
          (variant?.priceMinor ?? item.priceMinor) + addons.reduce((t, a) => t + a.priceMinor, 0),
      },
    ];
  });
  const [options, setOptions] = useState<OptionsItem | null>(null);
  const countOf = (itemId: string) =>
    lines.filter((l) => l.menuItemId === itemId).reduce((t, l) => t + l.quantity, 0);
  const cartTotal = lines.reduce((t, l) => t + l.priceMinor * l.quantity, 0);
  const cartCount = lines.reduce((t, l) => t + l.quantity, 0);
  const add = (id: string, d: number) =>
    setCart((c) => ({ ...c, [id]: Math.max(0, Math.min(99, (c[id] ?? 0) + d)) }));

  const place = async () => {
    if (!token || lines.length === 0 || placing) return;
    setPlacing(true);
    setNotice(null);
    // Contact details are optional; save them first if the guest changed anything.
    const saved = view?.contact;
    const nextPhone = (phone ?? saved?.phone ?? '').trim();
    const nextReceipt = receiptConsent ?? saved?.receiptConsent ?? true;
    const nextMarketing = marketingConsent ?? saved?.marketingConsent ?? false;
    if (
      nextPhone !== (saved?.phone ?? '') ||
      nextReceipt !== (saved?.receiptConsent ?? false) ||
      nextMarketing !== (saved?.marketingConsent ?? false)
    ) {
      try {
        await api.request('/public/guest/contact', {
          method: 'PUT',
          headers: { 'X-Guest-Token': token },
          body: {
            phone: nextPhone || null,
            receiptConsent: Boolean(nextPhone) && nextReceipt,
            marketingConsent: nextMarketing,
          },
        });
      } catch (e) {
        setPlacing(false);
        setNotice(messageOf(e));
        return;
      }
    }
    // Same key for retries of this cart; a new key only after success.
    pendingKey.current ??= crypto.randomUUID();
    try {
      await api.request('/public/guest/orders', {
        method: 'POST',
        headers: { 'X-Guest-Token': token },
        idempotencyKey: pendingKey.current,
        body: {
          paymentPreference: pay,
          lines: lines.map(({ menuItemId, variantId, quantity, addonOptionIds, note }) => ({
            menuItemId,
            quantity,
            ...(variantId ? { variantId } : {}),
            ...(addonOptionIds.length ? { addonOptionIds } : {}),
            ...(note ? { note } : {}),
          })),
        },
      });
      pendingKey.current = null;
      setCheckout(false);
      setCart({});
      setTab('bill');
      setNotice('Order sent to the kitchen.');
      await qc.invalidateQueries({ queryKey: ['guest', tenantId, tableId, 'bill'] });
    } catch (e) {
      const c = codeOf(e);
      if (c === 'SESSION_CLOSED' || c === 'GUEST_SESSION_EXPIRED') {
        pendingKey.current = null;
        setNotice(
          c === 'SESSION_CLOSED'
            ? 'This table was closed. We started a new bill for you; please place the order again.'
            : 'Welcome back! Please place the order again.',
        );
        await rejoin();
      } else {
        setNotice(messageOf(e));
      }
    } finally {
      setPlacing(false);
    }
  };

  if (joinQuery.isPending) {
    return (
      <Center>
        <Loader2 className="size-6 animate-spin text-emerald-600" />
        <p className="mt-3 text-sm text-slate-500">Opening your table…</p>
      </Center>
    );
  }
  if (joinQuery.isError || !view) {
    return (
      <Center>
        <UtensilsCrossed className="size-8 text-slate-300" />
        <p className="mt-3 font-semibold">We couldn’t open this table</p>
        <p className="mt-1 max-w-xs text-center text-sm text-slate-500">
          {messageOf(joinQuery.error)}
        </p>
      </Center>
    );
  }

  const g = view.guest;
  return (
    <div className="mx-auto min-h-dvh max-w-xl bg-slate-50 pb-28 text-slate-900">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
        <p className="text-lg font-semibold">{view.restaurant.name}</p>
        <p className="text-sm text-slate-500">
          Table {view.session.table.label} · {g.name}
          {view.restored ? ' · welcome back' : ''}
        </p>
        <div
          role="tablist"
          className="mt-3 grid grid-cols-2 rounded-lg bg-slate-100 p-1 text-sm font-medium"
        >
          {(
            [
              ['menu', 'Menu'],
              ['bill', `My orders${g.orders.length ? ` (${g.orders.length})` : ''}`],
            ] as const
          ).map(([k, l]) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              type="button"
              onClick={() => setTab(k)}
              className={cn(
                'rounded-md py-1.5',
                tab === k ? 'bg-white shadow-sm' : 'text-slate-500',
              )}
            >
              {l}
            </button>
          ))}
        </div>
      </header>

      {notice ? (
        <p className="mx-4 mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {notice}
        </p>
      ) : null}

      {tab === 'menu' ? (
        <div className="space-y-6 px-4 pt-4">
          {menu.isPending ? (
            <Loader2 className="mx-auto size-5 animate-spin text-slate-400" />
          ) : null}
          {menu.data?.categories.map((c) => (
            <section key={c.id}>
              <h2 className="mb-2 text-sm font-semibold tracking-wide text-slate-500 uppercase">
                {c.name}
              </h2>
              <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
                {c.items.map((i) => (
                  <li
                    key={i.id}
                    className={cn('flex items-start gap-3 p-3', !i.isAvailable && 'opacity-50')}
                  >
                    <span
                      className={cn(
                        'mt-1 flex size-3.5 shrink-0 items-center justify-center border-2',
                        DIET[i.diet],
                      )}
                      aria-label={i.diet}
                    >
                      <span
                        className={cn(
                          'size-1.5 rounded-full',
                          i.diet === 'veg'
                            ? 'bg-emerald-600'
                            : i.diet === 'egg'
                              ? 'bg-amber-500'
                              : 'bg-red-600',
                        )}
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{i.name}</p>
                      {i.description ? (
                        <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">
                          {i.description}
                        </p>
                      ) : null}
                      {!i.isAvailable ? (
                        <p className="mt-1 text-xs text-slate-500">Sold out</p>
                      ) : (
                        <div className="mt-2 space-y-2">
                          {i.addonGroups?.length ? (
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-sm text-slate-600 tabular-nums">
                                {money(
                                  Math.min(
                                    i.priceMinor,
                                    ...(i.variants ?? []).map((v) => v.priceMinor),
                                  ),
                                )}
                                {countOf(i.id) ? (
                                  <span className="ml-2 font-semibold text-emerald-700">
                                    {countOf(i.id)} in cart
                                  </span>
                                ) : null}
                              </span>
                              <button
                                type="button"
                                onClick={() => setOptions(i)}
                                className="rounded-lg border border-emerald-600 px-4 py-1.5 text-sm font-semibold text-emerald-700"
                              >
                                {countOf(i.id) ? 'Add more' : 'Choose'}
                              </button>
                            </div>
                          ) : null}
                          {i.addonGroups?.length
                            ? null
                            : (i.variants?.length
                                ? i.variants.map((v) => ({
                                    key: keyOf(i.id, v.id),
                                    label: v.name as string | null,
                                    price: v.priceMinor,
                                  }))
                                : [{ key: keyOf(i.id), label: null, price: i.priceMinor }]
                              ).map((o) => {
                                const qty = cart[o.key] ?? 0;
                                const what = o.label ? `${i.name} (${o.label})` : i.name;
                                return (
                                  <div
                                    key={o.key}
                                    className="flex items-center justify-between gap-3"
                                  >
                                    <span className="text-sm text-slate-600">
                                      {o.label ? (
                                        <span className="font-medium text-slate-800">
                                          {o.label} ·{' '}
                                        </span>
                                      ) : null}
                                      <span className="tabular-nums">{money(o.price)}</span>
                                    </span>
                                    {qty ? (
                                      <div className="flex items-center gap-2 rounded-lg border border-emerald-600 px-1">
                                        <button
                                          type="button"
                                          aria-label={`Remove one ${what}`}
                                          onClick={() => add(o.key, -1)}
                                          className="p-1.5 text-emerald-700"
                                        >
                                          <Minus className="size-4" />
                                        </button>
                                        <span className="w-4 text-center text-sm font-semibold tabular-nums">
                                          {qty}
                                        </span>
                                        <button
                                          type="button"
                                          aria-label={`Add one ${what}`}
                                          onClick={() => add(o.key, 1)}
                                          className="p-1.5 text-emerald-700"
                                        >
                                          <Plus className="size-4" />
                                        </button>
                                      </div>
                                    ) : (
                                      <button
                                        type="button"
                                        aria-label={`Add ${what}`}
                                        onClick={() => add(o.key, 1)}
                                        className="rounded-lg border border-emerald-600 px-4 py-1.5 text-sm font-semibold text-emerald-700"
                                      >
                                        Add
                                      </button>
                                    )}
                                  </div>
                                );
                              })}
                          <button
                            type="button"
                            onClick={() => setOptions(i)}
                            className="text-xs text-slate-500 underline-offset-2 hover:underline"
                          >
                            Add with instructions
                          </button>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <div className="space-y-4 px-4 pt-4">
          <section className="grid grid-cols-3 gap-2 rounded-xl border border-slate-200 bg-white p-3 text-center">
            <div>
              <p className="text-xs text-slate-500">Total</p>
              <p className="font-semibold tabular-nums">{money(g.totalMinor)}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Paid</p>
              <p className="font-semibold text-emerald-700 tabular-nums">{money(g.paidMinor)}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">To pay</p>
              <p className="font-semibold text-amber-700 tabular-nums">
                {money(g.outstandingMinor)}
              </p>
            </div>
          </section>
          {g.orders.length === 0 ? (
            <div className="flex flex-col items-center py-10 text-center text-sm text-slate-500">
              <Receipt className="size-8 text-slate-300" />
              <p className="mt-2">No orders yet. Pick something from the menu.</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {[...g.orders].reverse().map((o) => (
                <li
                  key={o.id}
                  className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3"
                >
                  <ChefHat className="size-5 shrink-0 text-slate-400" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      Order #{o.orderNumber}{' '}
                      <span className="text-sm font-normal text-slate-500">
                        · {o.itemCount} items
                      </span>
                    </p>
                    <p className="text-xs text-slate-500">
                      {new Date(o.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold tabular-nums">{money(o.totalMinor)}</p>
                    {o.status === 'cancelled' ? (
                      <span className="text-xs text-red-600">Cancelled</span>
                    ) : o.status === 'completed' ? (
                      <span className="text-xs text-emerald-700">Paid</span>
                    ) : (
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 text-xs font-medium',
                          KITCHEN[o.kitchenStatus].cls,
                        )}
                      >
                        {KITCHEN[o.kitchenStatus].label}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="text-center text-xs text-slate-500">
            Pay at the counter or ask your server. You can keep ordering after paying.
          </p>
        </div>
      )}

      {options ? (
        <ItemOptionsDialog
          item={options}
          money={money}
          onClose={() => setOptions(null)}
          onAdd={(choice, qty) => {
            const key = encodeLine(choice);
            setCart((c) => ({ ...c, [key]: Math.min(99, (c[key] ?? 0) + qty) }));
            setOptions(null);
          }}
        />
      ) : null}

      {checkout && cartCount > 0 ? (
        <CheckoutSheet
          total={money(cartTotal)}
          count={cartCount}
          lines={lines.map((l) => ({
            key: l.key,
            label: l.label,
            note: l.note,
            quantity: l.quantity,
            amount: money(l.priceMinor * l.quantity),
          }))}
          onQty={add}
          pay={pay}
          setPay={setPay}
          phone={phone ?? view?.contact?.phone ?? ''}
          setPhone={setPhone}
          receipt={receiptConsent ?? view?.contact?.receiptConsent ?? true}
          setReceipt={setReceiptConsent}
          marketing={marketingConsent ?? view?.contact?.marketingConsent ?? false}
          setMarketing={setMarketingConsent}
          placing={placing}
          notice={notice}
          onClose={() => setCheckout(false)}
          onConfirm={place}
        />
      ) : null}

      {cartCount > 0 && tab === 'menu' ? (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white p-3">
          <button
            type="button"
            onClick={() => setCheckout(true)}
            disabled={placing}
            className="mx-auto flex w-full max-w-xl items-center justify-between rounded-xl bg-emerald-600 px-4 py-3 font-semibold text-white disabled:opacity-70"
          >
            <span className="flex items-center gap-2">
              {placing ? (
                <Loader2 className="size-5 animate-spin" />
              ) : (
                <ShoppingBag className="size-5" />
              )}
              {cartCount} item{cartCount === 1 ? '' : 's'} · {money(cartTotal)}
            </span>
            <span>Checkout</span>
          </button>
          {menu.data && menu.data.restaurant.taxRateBp ? (
            <p className="mt-1 text-center text-xs text-slate-500">
              Prices before {menu.data.restaurant.taxRateBp / 100}% tax
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Checkout: payment choice and (optional) mobile number with consent, then place the order. */
function CheckoutSheet(p: {
  total: string;
  count: number;
  lines: { key: string; label: string; note: string; quantity: number; amount: string }[];
  onQty: (key: string, delta: number) => void;
  pay: PayChoice;
  setPay: (v: PayChoice) => void;
  phone: string;
  setPhone: (v: string) => void;
  receipt: boolean;
  setReceipt: (v: boolean) => void;
  marketing: boolean;
  setMarketing: (v: boolean) => void;
  placing: boolean;
  notice: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-30 flex items-end justify-center bg-slate-900/40"
      onClick={p.onClose}
    >
      <div
        role="dialog"
        aria-label="Checkout"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl space-y-4 rounded-t-2xl bg-white p-4 pb-6"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Checkout</h2>
          <button type="button" onClick={p.onClose} className="text-sm text-slate-500">
            Back to menu
          </button>
        </div>

        <ul className="max-h-48 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200">
          {p.lines.map((l) => (
            <li key={l.key} className="flex items-center gap-3 p-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{l.label}</p>
                {l.note ? <p className="text-xs text-slate-500">“{l.note}”</p> : null}
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={`Remove one ${l.label}`}
                  onClick={() => p.onQty(l.key, -1)}
                  className="p-1 text-emerald-700"
                >
                  <Minus className="size-4" />
                </button>
                <span className="w-5 text-center tabular-nums">{l.quantity}</span>
                <button
                  type="button"
                  aria-label={`Add one ${l.label}`}
                  onClick={() => p.onQty(l.key, 1)}
                  className="p-1 text-emerald-700"
                >
                  <Plus className="size-4" />
                </button>
              </div>
              <span className="w-16 text-right tabular-nums">{l.amount}</span>
            </li>
          ))}
        </ul>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">How will you pay?</legend>
          {(Object.keys(PAY_LABEL) as PayChoice[]).map((k) => (
            <label
              key={k}
              className={cn(
                'flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm',
                p.pay === k ? 'border-emerald-600 bg-emerald-50' : 'border-slate-200',
              )}
            >
              <input
                type="radio"
                name="pay"
                checked={p.pay === k}
                onChange={() => p.setPay(k)}
                className="accent-emerald-600"
              />
              {PAY_LABEL[k]}
            </label>
          ))}
          <p className="text-xs text-slate-500">
            Your order goes to the kitchen now; pay at the counter whenever you are ready.
          </p>
        </fieldset>

        <div className="space-y-2">
          <label className="block text-sm font-medium" htmlFor="guest-phone">
            Mobile number <span className="font-normal text-slate-500">(optional)</span>
          </label>
          <input
            id="guest-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="98765 43210"
            value={p.phone}
            onChange={(e) => p.setPhone(e.target.value)}
            className="h-11 w-full rounded-lg border border-slate-300 px-3 text-base outline-none focus:border-emerald-600"
          />
          {p.phone.trim() ? (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={p.receipt}
                onChange={(e) => p.setReceipt(e.target.checked)}
                className="mt-0.5 accent-emerald-600"
              />
              Send my bill / receipt to this number
            </label>
          ) : null}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={p.marketing}
              onChange={(e) => p.setMarketing(e.target.checked)}
              className="mt-0.5 accent-emerald-600"
            />
            I&apos;d like to receive offers from this restaurant
          </label>
        </div>

        {p.notice ? <p className="text-sm text-red-600">{p.notice}</p> : null}

        <button
          type="button"
          onClick={p.onConfirm}
          disabled={p.placing}
          className="flex w-full items-center justify-between rounded-xl bg-emerald-600 px-4 py-3 font-semibold text-white disabled:opacity-70"
        >
          <span className="flex items-center gap-2">
            {p.placing ? (
              <Loader2 className="size-5 animate-spin" />
            ) : (
              <ShoppingBag className="size-5" />
            )}
            {p.count} item{p.count === 1 ? '' : 's'} · {p.total}
          </span>
          <span>{p.placing ? 'Placing…' : 'Place order'}</span>
        </button>
      </div>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-slate-50 p-6 text-slate-900">
      {children}
    </div>
  );
}
