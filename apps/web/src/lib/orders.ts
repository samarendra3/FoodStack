'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import type { Channel } from './promotions';

export type PaymentMethod = 'cash' | 'card' | 'upi';
export type KitchenStatus = 'new' | 'accepted' | 'preparing' | 'ready' | 'served';

export interface Order {
  id: string;
  branchId: string;
  orderNumber: number;
  channel: Channel;
  /** How a QR guest said they will pay (null for staff orders). */
  paymentPreference?: 'counter_cash' | 'counter_card' | 'online' | null;
  status: 'open' | 'completed' | 'cancelled';
  kitchenStatus: KitchenStatus;
  tableLabel: string | null;
  /** Which bill at the table; null = the table's only bill. */
  billLabel: string | null;
  note: string | null;
  couponCode: string | null;
  currencyCode: string;
  taxRateBp: number;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  refundedMinor: number;
  dueMinor: number;
  createdAt: string;
  completedAt: string | null;
  customer: { name: string | null; phone: string } | null;
  items: {
    id: string;
    name: string;
    variantName: string | null;
    /** Add-ons as ordered (snapshot names and prices). */
    addons?: { groupName: string; name: string; priceMinor: number }[];
    unitPriceMinor: number;
    quantity: number;
    lineTotalMinor: number;
    discountMinor: number;
    note: string | null;
    status: 'active' | 'void';
  }[];
  discounts: {
    promotionId: string;
    name: string;
    couponCode: string | null;
    discountMinor: number;
  }[];
  payments: {
    id: string;
    method: PaymentMethod;
    amountMinor: number;
    refundedMinor: number;
    createdAt: string;
  }[];
}

export interface NewOrder {
  branchId: string;
  channel: Channel;
  tableLabel: string | null;
  billLabel?: string | null;
  note: string | null;
  couponCode: string | null;
  customer: { phone: string; name: string | null } | null;
  lines: { menuItemId: string; variantId: string | null; quantity: number }[];
}

export function useOrderMutations() {
  const { client } = useAuth();
  const profile = useProfile();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['orders', profile.activeTenant?.id] });
  return {
    /** `requestId` makes retries safe: the server returns the same order for the same key. */
    create: useMutation({
      mutationFn: ({ requestId, ...body }: NewOrder & { requestId: string }) =>
        client.request<Order>('/orders', { method: 'POST', body, idempotencyKey: requestId }),
      onSuccess: refresh,
    }),
    pay: useMutation({
      mutationFn: ({
        orderId,
        ...body
      }: {
        orderId: string;
        method: PaymentMethod;
        amountMinor: number;
        reference: string | null;
        /** Same key for retries of one collection: the server never charges twice. */
        requestId?: string;
      }) => {
        const { requestId, ...payment } = body;
        return client.request<Order>(`/orders/${orderId}/payments`, {
          method: 'POST',
          body: payment,
          ...(requestId ? { idempotencyKey: requestId } : {}),
        });
      },
      onSuccess: refresh,
    }),
  };
}

export function useOrders(branchId: string, status?: Order['status']) {
  const { client } = useAuth();
  const profile = useProfile();
  return useQuery({
    queryKey: ['orders', profile.activeTenant?.id, branchId, status],
    queryFn: () =>
      client.request<
        (Omit<Order, 'items' | 'discounts' | 'payments' | 'customer'> & { itemCount: number })[]
      >(`/orders?branchId=${encodeURIComponent(branchId)}${status ? `&status=${status}` : ''}`),
    enabled: Boolean(branchId),
  });
}
