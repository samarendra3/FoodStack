'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { authErrorMessage } from '@/lib/auth/errors';
import { useLiveEvents } from '@/lib/live-events';
import { audio } from '@/lib/sound';

/*
 * Kitchen ticket feed from GET /kitchen/tickets (open orders plus those served in the last
 * 12 hours). The server pushes `order.created` (POS, waiter and QR orders alike) and ticket
 * changes over the live event stream; each event — and each (re)connect, which recovers
 * anything missed while offline — re-reads the list at once. A slow poll is only a backstop.
 * The server list is authoritative on each refresh; `mergeTickets` only guards duplicates.
 */

export type TicketStatus = 'new' | 'accepted' | 'preparing' | 'ready' | 'completed';
export type TicketOrderType = 'dine-in' | 'takeaway' | 'delivery';
export type TicketPriority = 'normal' | 'rush';
export type Connection = 'unavailable' | 'connecting' | 'online' | 'reconnecting' | 'offline';

export interface KitchenTicket {
  id: string;
  orderNumber: string;
  orderType: TicketOrderType;
  tableLabel?: string;
  billLabel?: string;
  customerName?: string;
  createdAt: string;
  updatedAt: string;
  status: TicketStatus;
  priority: TicketPriority;
  note?: string;
  items: { id: string; name: string; qty: number; note?: string }[];
}

/** Valid forward transitions and the label of the button that performs each. */
export const NEXT_STATUS: Record<TicketStatus, { to: TicketStatus; label: string } | null> = {
  new: { to: 'accepted', label: 'Accept' },
  accepted: { to: 'preparing', label: 'Start preparing' },
  preparing: { to: 'ready', label: 'Mark ready' },
  ready: { to: 'completed', label: 'Complete' },
  completed: null,
};

/** Merges incoming tickets into the list without duplicates; the most recently updated wins. */
export function mergeTickets(current: KitchenTicket[], incoming: KitchenTicket[]): KitchenTicket[] {
  const byId = new Map(current.map((t) => [t.id, t]));
  for (const t of incoming) {
    const prev = byId.get(t.id);
    if (!prev || prev.updatedAt <= t.updatedAt) byId.set(t.id, t);
  }
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export interface KitchenFeed {
  tickets: KitchenTicket[];
  connection: Connection;
  isLoading: boolean;
  /** True once the first ticket list has loaded (used to seed the new-order bell). */
  loaded: boolean;
  error: string | null;
  /** Undefined until the status-transition API exists. */
  advance?: (ticketId: string, to: TicketStatus) => Promise<void>;
}

interface ServerTicket {
  id: string;
  orderNumber: string;
  orderType: 'dine_in' | 'takeaway' | 'delivery' | 'qr';
  tableLabel: string | null;
  billLabel?: string | null;
  customerName: string | null;
  createdAt: string;
  updatedAt: string;
  status: 'new' | 'accepted' | 'preparing' | 'ready' | 'served';
  note: string | null;
  items: { id: string; name: string; qty: number; note: string | null }[];
}

const TYPE: Record<ServerTicket['orderType'], TicketOrderType> = {
  dine_in: 'dine-in',
  qr: 'dine-in',
  takeaway: 'takeaway',
  delivery: 'delivery',
};

/** Live kitchen tickets for a branch. */
export function useKitchenFeed(branchId: string): KitchenFeed {
  const { client } = useAuth();
  const profile = useProfile();
  const qc = useQueryClient();
  const key = ['kitchen', profile.activeTenant?.id, branchId];
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const rows = await client.request<ServerTicket[]>(
        `/kitchen/tickets?branchId=${encodeURIComponent(branchId)}`,
      );
      return mergeTickets(
        [],
        rows.map((t): KitchenTicket => ({
          id: t.id,
          orderNumber: t.orderNumber,
          orderType: TYPE[t.orderType],
          tableLabel: t.tableLabel ?? undefined,
          billLabel: t.billLabel ?? undefined,
          customerName: t.customerName ?? undefined,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          status: t.status === 'served' ? 'completed' : t.status,
          priority: 'normal',
          note: t.note ?? undefined,
          items: t.items.map((i) => ({
            id: i.id,
            name: i.name,
            qty: i.qty,
            note: i.note ?? undefined,
          })),
        })),
      );
    },
    enabled: Boolean(branchId),
    refetchInterval: BACKSTOP_POLL_MS,
    refetchIntervalInBackground: true,
  });

  // Any kitchen event for this branch (or a (re)connect) → re-read the tickets now.
  const live = useLiveEvents(
    branchId ? `/kitchen/tickets/stream?branchId=${encodeURIComponent(branchId)}` : null,
    () => void qc.invalidateQueries({ queryKey: key }),
  );

  return {
    tickets: query.data ?? [],
    connection: !branchId
      ? 'unavailable'
      : query.isPending
        ? 'connecting'
        : query.isError
          ? query.data
            ? 'reconnecting'
            : 'offline'
          : live === 'live'
            ? 'online'
            : 'reconnecting',
    isLoading: query.isPending && Boolean(branchId),
    loaded: query.isSuccess,
    error: query.isError && !query.data ? authErrorMessage(query.error) : null,
    advance: async (ticketId, to) => {
      await client.request(`/kitchen/tickets/${ticketId}/status`, {
        method: 'POST',
        body: { to: to === 'completed' ? 'served' : to },
      });
      await qc.invalidateQueries({ queryKey: key });
    },
  };
}

const MUTE_KEY = 'foodstack.kds.muted';
/** Pushed events make updates instant; this poll only covers a stream that is down. */
const BACKSTOP_POLL_MS = 15_000;

/**
 * Rings once per new ticket (by order id, so duplicate events or refreshes never ring twice)
 * and reports the new tickets so the screen can show a NEW ORDER alert. Seeded from the first
 * *loaded* list, so tickets already waiting when the screen opens don't ring. Mute is remembered.
 */
export function useNewTicketChime(
  tickets: KitchenTicket[],
  loaded: boolean,
  onNew?: (fresh: KitchenTicket[]) => void,
) {
  const [muted, setMutedState] = useState(() => {
    try {
      return typeof window !== 'undefined' && localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      return false; // storage unavailable: default to sound on
    }
  });
  const seen = useRef<Set<string> | null>(null);
  const onNewRef = useRef(onNew);
  useEffect(() => {
    onNewRef.current = onNew;
  });

  const setMuted = useCallback((m: boolean) => {
    setMutedState(m);
    try {
      localStorage.setItem(MUTE_KEY, m ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!loaded) return; // the empty list shown while loading must not seed the set
    // QR orders arrive already in Preparing, so an unseen Preparing ticket is a new order too.
    const waiting = tickets.filter((t) => t.status === 'new' || t.status === 'preparing');
    if (seen.current === null) {
      seen.current = new Set(tickets.map((t) => t.id)); // first load: don't ring for old tickets
      return;
    }
    const fresh = waiting.filter((t) => !seen.current!.has(t.id));
    tickets.forEach((t) => seen.current!.add(t.id));
    if (fresh.length === 0) return;
    if (!muted) chime();
    onNewRef.current?.(fresh);
  }, [tickets, loaded, muted]);

  return { muted, setMuted };
}

/** Kitchen "ding-dong" through the shared, user-unlocked audio context (see lib/sound). */
export function chime() {
  const ctx = audio();
  if (!ctx) return; // browser still blocks audio: the screen shows "tap to enable sound"
  [880, 1320, 880, 1320].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    const t = ctx.currentTime + i * 0.18 + (i >= 2 ? 0.35 : 0);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.32);
  });
}
