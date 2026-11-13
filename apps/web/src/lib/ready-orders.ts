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
  /** Who is taking it to the table (null for orders from before assignment existed). */
  assignment?: Assignment | null;
}

export interface Assignment {
  id: string;
  status: 'unassigned' | 'assigned' | 'accepted';
  waiterUserId: string | null;
  waiterName: string | null;
  assignedAt: string | null;
  acceptedAt: string | null;
  problemNote: string | null;
}
export interface WaiterStaff {
  userId: string;
  name: string;
  clockedIn: boolean;
  openTasks: number;
}

type ServerEvent = ReadyOrder & { type: 'order.ready' | 'order.served' };
export type FeedState = LiveState;

/** One notification per hand-over: a new assignment (or re-queue) of the order rings again. */
const keyOf = (o: ReadyOrder) => `${o.orderId}:${o.assignment?.id ?? o.readyAt}`;
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
  // Supervisor in this branch: tenant-wide, restaurant-level or branch-level grant (the server
  // re-checks every assignment; this only decides what to show).
  const restaurantId = profile.branches.find((b) => b.id === branchId)?.restaurantId;
  const canAssign =
    profile.permissions.tenant.includes('waiter:assign') ||
    (restaurantId ? (profile.permissions.byRestaurant[restaurantId] ?? []) : []).includes(
      'waiter:assign',
    ) ||
    (profile.permissions.byBranch[branchId] ?? []).includes('waiter:assign');
  /** Needs this waiter: assigned to them and not yet accepted, or nobody has it. */
  const mustAct = (o: ReadyOrder) =>
    !o.assignment ||
    o.assignment.status === 'unassigned' ||
    (o.assignment.status === 'assigned' && o.assignment.waiterUserId === userId);
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
    // Only what this waiter must act on: their own new assignment or the open queue.
    const fresh = list.data.filter((o) => mustAct(o) && !seen.has(keyOf(o)));
    if (fresh.length === 0) return;
    fresh.forEach((o) => seen.add(keyOf(o)));
    saveKeys(notifiedKey, seen);
    onNewRef.current(fresh);
  }, [list.data, notifiedKey, userId]); // eslint-disable-line react-hooks/exhaustive-deps -- mustAct depends only on userId

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
      const e = data as ServerEvent;
      if (e.branchId !== branchId) return;
      if (event === 'order.served') {
        qc.setQueryData<ReadyOrder[]>(queryKey, (prev = []) =>
          prev.filter((o) => o.orderId !== e.orderId),
        );
        return;
      }
      // ready / assignment changes: re-read the list (it carries the assignment).
      if (event === 'order.ready' || event.startsWith('waiter.')) {
        void qc.invalidateQueries({ queryKey });
      }
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

  const act = (path: string, body?: object) =>
    client.request(path, { method: 'POST', ...(body ? { body } : {}) });
  const refresh = () => void qc.invalidateQueries({ queryKey });
  const accept = useMutation({
    mutationFn: (id: string) => act(`/waiter/assignments/${id}/accept`),
    onSettled: refresh,
  });
  const claim = useMutation({
    mutationFn: (id: string) => act(`/waiter/assignments/${id}/claim`),
    onSettled: refresh,
  });
  const problem = useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      act(`/waiter/assignments/${v.id}/problem`, { reason: v.reason }),
    onSettled: refresh,
  });
  const assign = useMutation({
    mutationFn: (v: { id: string; waiterUserId: string }) =>
      act(`/waiter/assignments/${v.id}/assign`, { waiterUserId: v.waiterUserId }),
    onSettled: refresh,
  });
  const staff = useQuery({
    queryKey: ['waiter-staff', tenantId, branchId],
    enabled: Boolean(tenantId && branchId && canAssign),
    queryFn: () =>
      client.request<WaiterStaff[]>(`/waiter/staff?${new URLSearchParams({ branchId })}`),
    staleTime: 15_000,
  });

  const orders = list.data ?? [];
  return {
    me: userId,
    canAssign,
    orders,
    mine: orders.filter((o) => o.assignment?.waiterUserId === userId),
    queue: orders.filter((o) => !o.assignment || o.assignment.status === 'unassigned'),
    others: orders.filter(
      (o) =>
        o.assignment &&
        o.assignment.status !== 'unassigned' &&
        o.assignment.waiterUserId !== userId,
    ),
    staff: staff.data ?? [],
    accept,
    claim,
    problem,
    assign,
    unacknowledged: orders.filter((o) => mustAct(o) && !acked.has(keyOf(o))),
    isAcked: (o: ReadyOrder) => acked.has(keyOf(o)),
    acknowledge,
    markServed: served,
    state,
    isLoading: list.isPending,
  };
}
