'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/*
 * Kitchen ticket feed. The kitchen/orders REST endpoints and the Socket.IO gateway are not built
 * yet (apps/api/src/modules/kitchen and orders hold no controllers), so this hook reports
 * `connection: 'unavailable'` and serves no tickets — never invented ones. When the gateway ships:
 *   1. load the branch's open tickets via React Query,
 *   2. subscribe to `kitchen:ticket.created` / `kitchen:ticket.updated` for `branchId`,
 *   3. feed every payload through `mergeTickets` (dedupes by id, newest version wins),
 *   4. implement `advance` as the status-transition mutation.
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
  error: string | null;
  /** Undefined until the status-transition API exists. */
  advance?: (ticketId: string, to: TicketStatus) => Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- branch scoping applies once the API exists
export function useKitchenFeed(branchId: string): KitchenFeed {
  return { tickets: [], connection: 'unavailable', isLoading: false, error: null };
}

const MUTE_KEY = 'foodstack.kds.muted';

/** Plays a short chime when a ticket id appears that was not seen before. Mute is remembered. */
export function useNewTicketChime(tickets: KitchenTicket[]) {
  const [muted, setMutedState] = useState(() => {
    try {
      return typeof window !== 'undefined' && localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      return false; // storage unavailable: default to sound on
    }
  });
  const seen = useRef<Set<string> | null>(null);

  const setMuted = useCallback((m: boolean) => {
    setMutedState(m);
    try {
      localStorage.setItem(MUTE_KEY, m ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const ids = tickets.filter((t) => t.status === 'new').map((t) => t.id);
    if (seen.current === null) {
      seen.current = new Set(ids); // first load: don't chime for tickets already waiting
      return;
    }
    const fresh = ids.filter((id) => !seen.current!.has(id));
    fresh.forEach((id) => seen.current!.add(id));
    if (fresh.length > 0 && !muted) chime();
  }, [tickets, muted]);

  return { muted, setMuted };
}

function chime() {
  try {
    const ctx = new AudioContext();
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.32);
    });
    setTimeout(() => void ctx.close(), 800);
  } catch {
    /* audio blocked until the user interacts with the page */
  }
}
