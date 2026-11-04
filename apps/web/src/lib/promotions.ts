'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth, useProfile } from '@/components/auth/auth-provider';

export type PromotionType = 'percentage' | 'fixed_amount' | 'bogo';
export type Channel = 'dine_in' | 'takeaway' | 'delivery' | 'qr';
export type PromotionState = 'active' | 'scheduled' | 'expired' | 'paused';

export interface PromotionFields {
  name: string;
  description: string | null;
  type: PromotionType;
  scope: 'order' | 'items';
  /** percentage/bogo: basis points (1000 = 10%); fixed_amount: minor units. */
  value: number;
  buyQuantity: number | null;
  getQuantity: number | null;
  couponCode: string | null;
  minOrderMinor: number | null;
  maxDiscountMinor: number | null;
  startsAt: string | null;
  endsAt: string | null;
  daysOfWeek: number[] | null;
  timeFrom: string | null;
  timeTo: string | null;
  channels: Channel[];
  branchIds: string[];
  itemIds: string[];
  categoryIds: string[];
  stackable: boolean;
  usageLimitTotal: number | null;
  usageLimitPerCustomer: number | null;
  status: 'active' | 'paused';
}

export interface Promotion extends PromotionFields {
  id: string;
  restaurantId: string;
  state: PromotionState;
  updatedAt: string;
}

export interface QuoteResult {
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  applied: {
    promotionId: string;
    name: string;
    type: PromotionType;
    couponCode: string | null;
    discountMinor: number;
  }[];
  lines: {
    menuItemId: string;
    quantity: number;
    unitPriceMinor: number;
    lineTotalMinor: number;
    discountMinor: number;
  }[];
  coupon: { code: string; status: 'applied' | 'rejected'; reason?: string } | null;
}

export const TYPE_LABEL: Record<PromotionType, string> = {
  percentage: 'Percentage off',
  fixed_amount: 'Fixed amount off',
  bogo: 'Buy X get Y',
};
export const CHANNEL_LABEL: Record<Channel, string> = {
  dine_in: 'Dine-in',
  takeaway: 'Takeaway',
  delivery: 'Delivery',
  qr: 'QR ordering',
};
export const STATE_STYLE: Record<PromotionState, { label: string; cls: string }> = {
  active: {
    label: 'Active',
    cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  },
  scheduled: {
    label: 'Scheduled',
    cls: 'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  },
  expired: {
    label: 'Expired',
    cls: 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300',
  },
  paused: {
    label: 'Paused',
    cls: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  },
};
export const COUPON_REASON: Record<string, string> = {
  not_found: 'This code does not exist.',
  paused: 'This offer is paused.',
  not_started: 'This offer has not started yet.',
  expired: 'This code has expired.',
  wrong_time: 'This offer is not valid at this time.',
  wrong_branch: 'Not valid at this branch.',
  wrong_channel: 'Not valid for this order type.',
  min_order: 'The order is below the minimum for this code.',
  no_eligible_items: 'No items in the order qualify.',
};

const key = (tenantId?: string) => ['promotions', tenantId] as const;

export function usePromotion(id: string) {
  const { client } = useAuth();
  const profile = useProfile();
  return useQuery({
    queryKey: [...key(profile.activeTenant?.id), id],
    queryFn: () => client.request<Promotion & { canManage: boolean }>(`/promotions/${id}`),
  });
}

export function usePromotionMutations() {
  const { client } = useAuth();
  const profile = useProfile();
  const qc = useQueryClient();
  const done = {
    onSuccess: () => qc.invalidateQueries({ queryKey: key(profile.activeTenant?.id) }),
  };
  return {
    create: useMutation({
      mutationFn: (body: PromotionFields) =>
        client.request<{ id: string }>('/promotions', { method: 'POST', body }),
      ...done,
    }),
    update: useMutation({
      mutationFn: ({ id, ...body }: Partial<PromotionFields> & { id: string }) =>
        client.request<void>(`/promotions/${id}`, { method: 'PATCH', body }),
      ...done,
    }),
    remove: useMutation({
      mutationFn: (id: string) => client.request<void>(`/promotions/${id}`, { method: 'DELETE' }),
      ...done,
    }),
  };
}

/** Plain-language summary, e.g. "10% off, up to ₹100" or "Buy 2 get 1 free". */
export function describeOffer(p: PromotionFields, money: (minor: number) => string): string {
  const cap = p.maxDiscountMinor ? `, up to ${money(p.maxDiscountMinor)}` : '';
  if (p.type === 'percentage') return `${p.value / 100}% off${cap}`;
  if (p.type === 'fixed_amount') return `${money(p.value)} off`;
  const pct = p.value === 10000 ? 'free' : `${p.value / 100}% off`;
  return `Buy ${p.buyQuantity} get ${p.getQuantity} ${pct}${cap}`;
}

/** Server-side price check for a POS cart (discounts are never computed in the browser). */
export function useQuote(input: {
  branchId: string;
  channel: Channel;
  couponCode: string | null;
  lines: { menuItemId: string; quantity: number }[];
}) {
  const { client } = useAuth();
  const profile = useProfile();
  return useQuery({
    queryKey: ['quote', profile.activeTenant?.id, input],
    queryFn: () =>
      client.request<QuoteResult>('/promotions/quote', { method: 'POST', body: input }),
    enabled: Boolean(input.branchId) && input.lines.length > 0,
    placeholderData: (prev) => prev,
    staleTime: 15_000,
  });
}
