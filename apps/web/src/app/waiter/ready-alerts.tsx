'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { useToast } from '@foodstack/ui/components/toast';
import {
  Bell,
  BellRing,
  Check,
  Eye,
  Loader2,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useState } from 'react';
import { authErrorMessage } from '@/lib/auth/errors';
import { type ReadyOrder, useReadyOrders } from '@/lib/ready-orders';
import { audioReady, playReadyChime, unlockAudio } from '@/lib/sound';
import { VolumeSlider } from '@/components/volume-slider';

const MUTE_KEY = 'foodstack.waiter.bell-muted';
/** The ready chime lasts ~1.6 s; repeat it until the waiter acknowledges. */
const RING_EVERY_MS = 4_000;

function minutesAgo(iso: string) {
  const m = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  return m === 0 ? 'just now' : `${m} min ago`;
}
const where = (o: ReadyOrder) => o.tableLabel ?? o.billLabel ?? 'Counter';

/**
 * Kitchen → waiter pickup alerts: bell button with a live counter, a toast and a bell sound for
 * every order that becomes ready, and a panel listing all ready orders until they are served.
 */
export function ReadyAlerts({
  branchId,
  onViewTable,
}: {
  branchId: string;
  /** Opens that table's order on the floor; null when the order has no table. */
  onViewTable: (tableLabel: string) => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  const [muted, setMuted] = useState(() => {
    try {
      return localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      return false;
    }
  });

  // Browsers block audio until the user interacts: arm it on the first tap/keypress.
  useEffect(() => {
    const arm = () => {
      unlockAudio();
      setTimeout(() => setSoundOn(audioReady()), 50);
    };
    window.addEventListener('pointerdown', arm);
    window.addEventListener('keydown', arm);
    return () => {
      window.removeEventListener('pointerdown', arm);
      window.removeEventListener('keydown', arm);
    };
  }, []);

  const onNew = useCallback(
    (fresh: ReadyOrder[]) => {
      for (const o of fresh.slice(0, 3)) {
        toast.success(`Ready · ${where(o)}`, {
          description: `Order #${o.orderNumber} · ${o.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}`,
          duration: 10_000,
        });
      }
      if (fresh.length > 3) toast.info(`${fresh.length - 3} more orders ready`);
    },
    [toast],
  );

  const feed = useReadyOrders(branchId, onNew);
  const pending = feed.unacknowledged.length;
  const total = feed.orders.length;

  // Keep ringing (every RING_EVERY_MS) while any ready order is unacknowledged. Stops as soon as
  // the waiter acknowledges, views or serves them all, another waiter serves them, or on mute.
  const ringing = pending > 0 && !muted && soundOn;
  useEffect(() => {
    if (!ringing) return;
    playReadyChime();
    const timer = setInterval(playReadyChime, RING_EVERY_MS);
    return () => clearInterval(timer);
  }, [ringing]);

  const toggleMute = () => {
    const m = !muted;
    setMuted(m);
    try {
      localStorage.setItem(MUTE_KEY, m ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  const serve = (o: ReadyOrder) =>
    feed.markServed.mutate(o.orderId, {
      onSuccess: () => toast.success(`Order #${o.orderNumber} served`),
      onError: (e) => toast.error('Could not mark served', { description: authErrorMessage(e) }),
    });

  return (
    <>
      <div className="flex items-center gap-2">
        <span
          title={
            feed.state === 'live'
              ? 'Live: kitchen updates arrive instantly'
              : feed.state === 'connecting'
                ? 'Connecting to kitchen…'
                : 'Offline: retrying. Missed orders will load when back.'
          }
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium',
            feed.state === 'live'
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
              : feed.state === 'connecting'
                ? 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300'
                : 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300',
          )}
        >
          {feed.state === 'offline' ? (
            <WifiOff className="size-3.5" />
          ) : (
            <Wifi className="size-3.5" />
          )}
          <span className="hidden sm:inline">
            {feed.state === 'live'
              ? 'Live'
              : feed.state === 'connecting'
                ? 'Connecting'
                : 'Offline'}
          </span>
        </span>
        <button
          type="button"
          onClick={() => {
            unlockAudio();
            setOpen(true);
          }}
          aria-label={`Ready orders: ${total}${pending ? `, ${pending} new` : ''}`}
          className={cn(
            'relative inline-flex h-10 items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition',
            pending
              ? 'border-amber-400 bg-amber-400 text-amber-950 shadow-lg shadow-amber-500/30'
              : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200',
          )}
        >
          {pending ? (
            <BellRing className="size-4 motion-safe:animate-pulse" />
          ) : (
            <Bell className="size-4" />
          )}
          Ready
          <span
            className={cn(
              'min-w-6 rounded-full px-1.5 py-0.5 text-center text-xs tabular-nums',
              pending
                ? 'bg-amber-950 text-amber-50'
                : 'bg-slate-100 text-slate-700 dark:bg-white/10 dark:text-slate-200',
            )}
          >
            {total}
          </span>
          {pending ? (
            <span className="absolute -top-1 -right-1 flex size-3">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-75 motion-reduce:animate-none" />
              <span className="relative inline-flex size-3 rounded-full bg-red-500" />
            </span>
          ) : null}
        </button>
      </div>

      {!soundOn && !muted ? (
        <button
          type="button"
          onClick={() => {
            unlockAudio();
            setTimeout(() => {
              setSoundOn(audioReady());
              playReadyChime();
            }, 50);
          }}
          className="fixed bottom-4 left-1/2 z-40 inline-flex -translate-x-1/2 items-center gap-2 rounded-full bg-slate-900 px-4 py-2.5 text-sm font-medium text-white shadow-xl dark:bg-white dark:text-slate-900"
        >
          <Volume2 className="size-4" /> Tap to enable the order-ready bell
        </button>
      ) : null}

      <AnimatePresence>
        {open ? (
          <motion.div
            className="fixed inset-0 z-50 flex justify-end bg-slate-950/40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpen(false)}
          >
            <motion.aside
              role="dialog"
              aria-label="Ready orders"
              initial={{ x: 40 }}
              animate={{ x: 0 }}
              exit={{ x: 40 }}
              onClick={(e) => e.stopPropagation()}
              className="flex h-full w-full max-w-md flex-col bg-white shadow-2xl dark:bg-slate-950"
            >
              <header className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-white/10">
                <BellRing className="size-5 text-amber-500" />
                <h2 className="flex-1 text-base font-semibold">Ready for pickup ({total})</h2>
                <VolumeSlider className="hidden w-24 sm:flex" onChange={() => playReadyChime()} />
                <button
                  type="button"
                  onClick={toggleMute}
                  aria-label={muted ? 'Turn bell on' : 'Mute bell'}
                  title={muted ? 'Bell off' : 'Bell on'}
                  className="rounded-md p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-white/10"
                >
                  {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
                </button>
                {pending ? (
                  <button
                    type="button"
                    onClick={() => feed.acknowledge(feed.unacknowledged)}
                    className="rounded-md px-2 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
                  >
                    Acknowledge all
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className="rounded-md p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-white/10"
                >
                  <X className="size-4" />
                </button>
              </header>

              <div className="flex-1 space-y-3 overflow-y-auto p-4">
                {feed.isLoading ? (
                  <Loader2 className="mx-auto mt-10 size-5 animate-spin text-slate-400" />
                ) : total === 0 ? (
                  <p className="mt-10 text-center text-sm text-slate-500">
                    Nothing waiting. New ready orders will ring here.
                  </p>
                ) : (
                  feed.orders.map((o) => {
                    const fresh = !feed.isAcked(o);
                    return (
                      <article
                        key={o.orderId}
                        onClick={() => fresh && feed.acknowledge([o])}
                        className={cn(
                          'rounded-xl border p-3 transition',
                          fresh
                            ? 'border-amber-400 bg-amber-50 ring-2 ring-amber-400/40 dark:bg-amber-500/10'
                            : 'border-slate-200 dark:border-white/10',
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-2xl leading-none font-bold tracking-tight">
                              {where(o)}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              Order #{o.orderNumber}
                              {o.tableLabel && o.billLabel ? ` · ${o.billLabel}` : ''} ·{' '}
                              {minutesAgo(o.readyAt)}
                            </p>
                          </div>
                          <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-xs font-semibold text-white">
                            READY
                          </span>
                        </div>
                        <ul className="mt-2 space-y-0.5 text-sm">
                          {o.items.map((i) => (
                            <li key={i.id}>
                              <span className="font-semibold tabular-nums">{i.qty}×</span> {i.name}
                              {i.note ? (
                                <span className="text-xs text-slate-500"> · {i.note}</span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                        <div className="mt-3 flex gap-2">
                          {o.tableLabel ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                feed.acknowledge([o]);
                                setOpen(false);
                                onViewTable(o.tableLabel!);
                              }}
                              className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-200 text-sm font-medium hover:bg-slate-50 dark:border-white/10 dark:hover:bg-white/5"
                            >
                              <Eye className="size-4" /> View order
                            </button>
                          ) : null}
                          <button
                            type="button"
                            disabled={
                              feed.markServed.isPending && feed.markServed.variables === o.orderId
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              serve(o);
                            }}
                            className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                          >
                            {feed.markServed.isPending &&
                            feed.markServed.variables === o.orderId ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <Check className="size-4" />
                            )}
                            Mark served
                          </button>
                        </div>
                      </article>
                    );
                  })
                )}
              </div>
            </motion.aside>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
