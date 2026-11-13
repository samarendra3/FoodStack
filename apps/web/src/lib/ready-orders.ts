'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { type LiveState, useLiveEvents } from '@/lib/live-events';

/** An order the kitchen has marked ready, waiting for a waiter to take it to the table. */
export interface ReadyOrder {
  orderId: string;
  orderNumber: string;
  tableLabel: string | null;
  billLabel: string | null;
  branchId: string;
  readyAt: string;
  items: { id: string; name: string; qty: number; note: string | null; addons?: string[] }[];
}

type ServerEvent = ReadyOrder & { type: 'order.ready' | 'order.served' };
export type FeedState = LiveState;

/** One notification per order *per time it became ready*, so a re-ready rings again. */
const keyOf = (o: ReadyOrder) => `${o.orderId}:${o.readyAt}`;
const BACKSTOP_POLL_MS = 30_000;
const MAX_KEYS = 300;

function loadKeys(storageKey: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(storageKey) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}
function saveKeys(storageKey: string, keys: Set<string>) {
  try {
    localStorage.setItem(storageKey, JSON.stringify([...keys].slice(-MAX_KEYS)));
  } catch {
    /* storage unavailable: dedupe still works for this tab */
  }
}

/**
 * Live "order ready" feed for the waiter app. The server pushes events over SSE; the list
 * itself always comes from GET /waiter/ready-orders (the database), re-fetched on every
 * (re)connect and every 30 s as a backstop, so nothing is lost while offline. Each ready
 * order rings once per device (keys kept in localStorage), and stays highlighted until the
 * waiter acknowledges it.
 */
export function useReadyOrders(branchId: string, onNew: (orders: ReadyOrder[]) => void) {
  const { client } = useAuth();
  const profile = useProfile();
  const qc = useQueryClient();
  const tenantId = profile.activeTenant?.id;
  const userId = profile.user?.id ?? 'anon';
  const queryKey = ['ready-orders', tenantId, branchId] as const;
  const notifiedKey = `foodstack.ready.notified.${userId}.${branchId}`;
  const ackKey = `foodstack.ready.acked.${userId}.${branchId}`;

  // Callers key this hook's component by branch, so the keys are fixed for its lifetime.
  const [acked, setAcked] = useState<Set<string>>(() => loadKeys(ackKey));
  const notified = useRef<Set<string> | null>(null);
  const onNewRef = useRef(onNew);
  useEffect(() => {
    onNewRef.current = onNew;
  });

  const list = useQuery({
    queryKey,
    enabled: Boolean(tenantId && branchId),
    queryFn: () =>
      client.request<ReadyOrder[]>(`/waiter/ready-orders?${new URLSearchParams({ branchId })}`),
    refetchInterval: BACKSTOP_POLL_MS,
    refetchIntervalInBackground: true,
  });

  // Ring for anything not yet notified on this device: live events and backlog alike.
  useEffect(() => {
    if (!list.data) return;
    const seen = (notified.current ??= loadKeys(notifiedKey));
    const fresh = list.data.filter((o) => !seen.has(keyOf(o)));
    if (fresh.length === 0) return;
    fresh.forEach((o) => seen.add(keyOf(o)));
    saveKeys(notifiedKey, seen);
    onNewRef.current(fresh);
  }, [list.data, notifiedKey]);

  // Live events; every (re)connect re-reads the backlog so nothing missed offline is lost.
  const state = useLiveEvents(
    tenantId && branchId
      ? `/waiter/ready-orders/stream?${new URLSearchParams({ branchId })}`
      : null,
    (event, data) => {
      if (event === 'hello') {
        void qc.invalidateQueries({ queryKey });
        return;
      }
      if (event !== 'order.ready' && event !== 'order.served') return;
      const e = data as ServerEvent;
      if (e.branchId !== branchId) return;
      qc.setQueryData<ReadyOrder[]>(queryKey, (prev = []) => {
        const rest = prev.filter((o) => o.orderId !== e.orderId);
        if (e.type === 'order.served') return rest;
        const order: ReadyOrder = {
          orderId: e.orderId,
          orderNumber: e.orderNumber,
          tableLabel: e.tableLabel,
          billLabel: e.billLabel,
          branchId: e.branchId,
          readyAt: e.readyAt,
          items: e.items,
        };
        return [...rest, order].sort((x, y) => x.readyAt.localeCompare(y.readyAt));
      });
    },
  );

  // A browser coming back online should not wait out the back-off.
  useEffect(() => {
    const again = () => void qc.invalidateQueries({ queryKey });
    window.addEventListener('online', again);
    return () => window.removeEventListener('online', again);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc, tenantId, branchId]);

  const acknowledge = useCallback(
    (orders: ReadyOrder[]) =>
      setAcked((prev) => {
        const next = new Set(prev);
        orders.forEach((o) => next.add(keyOf(o)));
        saveKeys(ackKey, next);
        return next;
      }),
    [ackKey],
  );

  const served = useMutation({
    mutationFn: (orderId: string) =>
      client.request(`/waiter/orders/${orderId}/served`, { method: 'POST' }),
    onSuccess: (_r, orderId) => {
      qc.setQueryData<ReadyOrder[]>(queryKey, (prev = []) =>
        prev.filter((o) => o.orderId !== orderId),
      );
      void qc.invalidateQueries({ queryKey: ['orders'] });
    },
  });

  const orders = list.data ?? [];
  return {
    orders,
    unacknowledged: orders.filter((o) => !acked.has(keyOf(o))),
    isAcked: (o: ReadyOrder) => acked.has(keyOf(o)),
    acknowledge,
    markServed: served,
    state,
    isLoading: list.isPending,
  };
}
