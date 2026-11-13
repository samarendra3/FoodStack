'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth, useProfile } from '@/components/auth/auth-provider';

/** An order the kitchen has marked ready, waiting for a waiter to take it to the table. */
export interface ReadyOrder {
  orderId: string;
  orderNumber: string;
  tableLabel: string | null;
  billLabel: string | null;
  branchId: string;
  readyAt: string;
  items: { id: string; name: string; qty: number; note: string | null }[];
}

type ServerEvent = ReadyOrder & { type: 'order.ready' | 'order.served' };
export type FeedState = 'connecting' | 'live' | 'offline';

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

// ---- sound (autoplay-safe) ----

let audioCtx: AudioContext | null = null;

/** Must run inside a user gesture the first time; browsers block audio until then. */
export function unlockAudio(): boolean {
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return true;
  } catch {
    return false;
  }
}
export const audioReady = () => audioCtx?.state === 'running';

/**
 * A classic "ring-ring … ring-ring" telephone ringtone, synthesised (no asset to load or block):
 * two warbling tones (a fast on/off trill gives the bell-hammer "trrring"), played as two
 * double-rings about 3 seconds in total.
 */
export function playBell() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const ctx = audioCtx;
  const RING = 0.4; // one "ring"
  const pattern = [0, 0.6, 1.6, 2.2]; // ring ring … ring ring
  const start = ctx.currentTime + 0.02;

  const out = ctx.createGain();
  out.gain.value = 0.18;
  out.connect(ctx.destination);

  for (const offset of pattern) {
    const t = start + offset;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(1, t + 0.02);
    env.gain.setValueAtTime(1, t + RING - 0.04);
    env.gain.exponentialRampToValueAtTime(0.0001, t + RING);
    env.connect(out);

    // Trill: square-wave LFO at 20 Hz gates the tones on and off, like a ringer's hammer.
    const trill = ctx.createGain();
    trill.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 20;
    const depth = ctx.createGain();
    depth.gain.value = 0.5;
    lfo.connect(depth).connect(trill.gain);
    trill.connect(env);

    for (const freq of [1046, 1318]) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      osc.connect(trill);
      osc.start(t);
      osc.stop(t + RING + 0.05);
    }
    lfo.start(t);
    lfo.stop(t + RING + 0.05);
  }
}

/** Reads a fetch body as Server-Sent Events until it ends or is aborted. */
async function readEvents(res: Response, onEvent: (event: string, data: string) => void) {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let cut: number;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) onEvent(event, data.join('\n'));
    }
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

  const [state, setState] = useState<FeedState>('connecting');
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

  // The live stream, with capped exponential back-off on failure.
  useEffect(() => {
    if (!tenantId || !branchId) return;
    const abort = new AbortController();
    let attempt = 0;
    const upsert = (e: ServerEvent) =>
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
        return [...rest, order].sort((a, b) => a.readyAt.localeCompare(b.readyAt));
      });

    void (async () => {
      while (!abort.signal.aborted) {
        setState('connecting');
        try {
          const res = await client.stream(
            `/waiter/ready-orders/stream?${new URLSearchParams({ branchId })}`,
            abort.signal,
          );
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          await readEvents(res, (event, data) => {
            if (event === 'hello') {
              attempt = 0;
              setState('live');
              // Connected (or re-connected): pull whatever became ready while we were away.
              void qc.invalidateQueries({ queryKey });
            } else if (event === 'order.ready' || event === 'order.served') {
              const e = JSON.parse(data) as ServerEvent;
              if (e.branchId === branchId) upsert(e);
            }
          });
          // Server closed the stream on schedule: reconnect straight away.
        } catch {
          if (abort.signal.aborted) return;
          setState('offline');
          attempt += 1;
        }
        if (abort.signal.aborted) return;
        const delay = attempt === 0 ? 250 : Math.min(30_000, 1_000 * 2 ** (attempt - 1));
        await new Promise((r) => setTimeout(r, delay * (0.75 + Math.random() * 0.5)));
      }
    })();
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryKey is derived from these
  }, [client, qc, tenantId, branchId]);

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
