import { AlertCircle, AlertTriangle, CheckCircle2, Info, type LucideIcon, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

export type AlertBannerVariant = 'info' | 'success' | 'warning' | 'danger';

const STYLE: Record<AlertBannerVariant, { icon: LucideIcon; box: string }> = {
  info: {
    icon: Info,
    box: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-500/25 dark:bg-sky-500/10 dark:text-sky-100',
  },
  success: {
    icon: CheckCircle2,
    box: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-100',
  },
  warning: {
    icon: AlertTriangle,
    box: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100',
  },
  danger: {
    icon: AlertCircle,
    box: 'border-red-200 bg-red-50 text-red-900 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-100',
  },
};

export interface AlertBannerProps {
  variant?: AlertBannerVariant;
  title?: ReactNode;
  children?: ReactNode;
  /** Buttons or links on the right (stacks below on mobile). */
  action?: ReactNode;
  onDismiss?: () => void;
  /** "bar": full-width strip under a header; "inline": rounded box inside content. */
  layout?: 'inline' | 'bar';
  icon?: LucideIcon;
  className?: string;
}

/**
 * Persistent status message: trial ending, subscription expired, order or branch limit reached,
 * payment pending, account suspended, form-level errors. Warnings and dangers are announced.
 */
export function AlertBanner({
  variant = 'info',
  title,
  children,
  action,
  onDismiss,
  layout = 'inline',
  icon,
  className,
}: AlertBannerProps) {
  const s = STYLE[variant];
  const Icon = icon ?? s.icon;
  return (
    <div
      role={variant === 'danger' || variant === 'warning' ? 'alert' : 'status'}
      className={cn(
        'flex flex-col gap-3 text-sm sm:flex-row sm:items-center',
        layout === 'bar' ? 'border-b px-4 py-2.5 sm:px-6' : 'rounded-xl border p-4',
        s.box,
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          {title ? <p className="font-semibold">{title}</p> : null}
          {children ? <div className={cn(title && 'mt-0.5', 'opacity-90')}>{children}</div> : null}
        </div>
      </div>
      {action || onDismiss ? (
        <div className="flex shrink-0 items-center gap-2 max-sm:pl-7">
          {action}
          {onDismiss ? (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss"
              className="rounded-md p-1 opacity-70 transition-opacity hover:opacity-100"
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
