'use client';

import { type ReactNode, type RefObject, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/utils';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  open: boolean;
  /** Called on Escape, backdrop click or a close button — never while `dismissible` is false. */
  onClose: () => void;
  /** False while work is in progress, so a half-finished action cannot be dismissed. */
  dismissible?: boolean;
  /** Accessible name; pass the id of the visible title via `labelledBy` instead when there is one. */
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  /** Element to focus when the dialog opens (default: the first focusable element). */
  initialFocus?: RefObject<HTMLElement | null>;
  role?: 'dialog' | 'alertdialog';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  children: ReactNode;
}

const SIZES = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-2xl', xl: 'max-w-4xl' } as const;

/**
 * Accessible modal: portalled to <body>, traps focus, restores focus to the opener on close,
 * locks page scroll, closes on Escape / backdrop when dismissible. Bottom sheet on small screens.
 */
export function Dialog({
  open,
  onClose,
  dismissible = true,
  label,
  labelledBy,
  describedBy,
  initialFocus,
  role = 'dialog',
  size = 'md',
  className,
  children,
}: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const dismissRef = useRef(dismissible);
  const closeRef = useRef(onClose);
  useEffect(() => {
    dismissRef.current = dismissible;
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusFirst = () => {
      const target =
        initialFocus?.current ??
        panel.current?.querySelector<HTMLElement>(FOCUSABLE) ??
        panel.current;
      target?.focus();
    };
    const raf = requestAnimationFrame(focusFirst);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (dismissRef.current) {
          e.stopPropagation();
          closeRef.current();
        }
        return;
      }
      if (e.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null,
      );
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = overflow;
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [open]); // focus once per opening

  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div
        aria-hidden
        className="animate-in fade-in absolute inset-0 bg-slate-950/50 backdrop-blur-sm duration-150"
        onClick={() => dismissible && onClose()}
      />
      <div
        ref={panel}
        role={role}
        aria-modal="true"
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={cn(
          'animate-in fade-in slide-in-from-bottom-4 sm:zoom-in-95 sm:slide-in-from-bottom-0 relative max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl border bg-card text-card-foreground shadow-xl outline-none duration-200 sm:rounded-xl',
          SIZES[size],
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Stable ids for a dialog's title and description. */
export function useDialogIds() {
  const id = useId();
  return { titleId: `${id}-title`, descriptionId: `${id}-desc` };
}
