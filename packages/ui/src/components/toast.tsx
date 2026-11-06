'use client';

import { AlertCircle, AlertTriangle, CheckCircle2, Info, type LucideIcon, X } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn } from '../lib/utils';

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface ToastInput {
  title: string;
  description?: string;
  /** ms before auto-dismiss; 0 keeps it until closed. Defaults by variant. */
  duration?: number;
}

interface ToastItem extends ToastInput {
  id: number;
  variant: ToastVariant;
}

/** Errors stay longer: people need time to read what went wrong. */
const DURATION: Record<ToastVariant, number> = {
  success: 4000,
  info: 5000,
  warning: 6000,
  error: 8000,
};

const STYLE: Record<ToastVariant, { icon: LucideIcon; color: string }> = {
  success: { icon: CheckCircle2, color: 'text-emerald-600 dark:text-emerald-400' },
  error: { icon: AlertCircle, color: 'text-red-600 dark:text-red-400' },
  warning: { icon: AlertTriangle, color: 'text-amber-600 dark:text-amber-400' },
  info: { icon: Info, color: 'text-sky-600 dark:text-sky-400' },
};

export interface ToastApi {
  success: (title: string, opts?: Omit<ToastInput, 'title'>) => number;
  error: (title: string, opts?: Omit<ToastInput, 'title'>) => number;
  warning: (title: string, opts?: Omit<ToastInput, 'title'>) => number;
  info: (title: string, opts?: Omit<ToastInput, 'title'>) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const MAX = 4;

/** App-wide toasts: one live region, newest on top, at most four at a time. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((s) => s.filter((t) => t.id !== id)), []);
  const push = useCallback((variant: ToastVariant, input: ToastInput) => {
    const id = next.current++;
    setItems((s) => {
      // The same message twice in a row (e.g. a double click) shows once.
      const rest = s.filter((t) => !(t.variant === variant && t.title === input.title));
      return [{ ...input, id, variant }, ...rest].slice(0, MAX);
    });
    return id;
  }, []);
  const api = useMemo<ToastApi>(
    () => ({
      success: (title, o) => push('success', { title, ...o }),
      error: (title, o) => push('error', { title, ...o }),
      warning: (title, o) => push('warning', { title, ...o }),
      info: (title, o) => push('info', { title, ...o }),
      dismiss,
    }),
    [push, dismiss],
  );
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[70] flex flex-col items-center gap-2 p-4 sm:top-0 sm:bottom-auto sm:items-end"
        aria-live="polite"
        aria-relevant="additions"
      >
        {items.map((t) => (
          <ToastNotification key={t.id} toast={t} onClose={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

/** One toast. Pauses its timer while hovered or focused; Escape or × closes it. */
export function ToastNotification({
  toast: t,
  onClose,
}: {
  toast: ToastItem;
  onClose: () => void;
}) {
  const [paused, setPaused] = useState(false);
  const duration = t.duration ?? DURATION[t.variant];
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (!duration || paused) return;
    const timer = setTimeout(() => close.current(), duration);
    return () => clearTimeout(timer);
  }, [duration, paused]);
  const s = STYLE[t.variant];
  const Icon = s.icon;
  return (
    <div
      role={t.variant === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      className="animate-in fade-in slide-in-from-bottom-2 sm:slide-in-from-top-2 sm:slide-in-from-bottom-0 pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border bg-card p-4 text-card-foreground shadow-lg duration-200"
    >
      <Icon className={cn('mt-0.5 size-5 shrink-0', s.color)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t.title}</p>
        {t.description ? (
          <p className="mt-0.5 text-sm text-muted-foreground">{t.description}</p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss notification"
        className="-m-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
