'use client';

import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Info,
  Loader2,
  type LucideIcon,
  ShieldOff,
  Trash2,
} from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { cn } from '../lib/utils';
import { Button } from './button';
import { Dialog, useDialogIds } from './dialog';

export type ConfirmVariant = 'default' | 'warning' | 'danger' | 'success';

const VARIANT: Record<ConfirmVariant, { icon: LucideIcon; tile: string; button: string }> = {
  default: {
    icon: Info,
    tile: 'bg-sky-50 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300',
    button: '',
  },
  warning: {
    icon: AlertTriangle,
    tile: 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
    button: 'bg-amber-600 text-white hover:bg-amber-700',
  },
  danger: {
    icon: AlertTriangle,
    tile: 'bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-300',
    button: 'bg-red-600 text-white hover:bg-red-700',
  },
  success: {
    icon: CheckCircle2,
    tile: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
    button: 'bg-emerald-600 text-white hover:bg-emerald-700',
  },
};

export interface ConfirmDetail {
  label: string;
  value: ReactNode;
}

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * Runs the action. While its promise is pending the dialog shows a spinner, ignores repeat
   * clicks and cannot be dismissed. A rejection keeps the dialog open and shows the message.
   */
  onConfirm: () => unknown | Promise<unknown>;
  title: ReactNode;
  description?: ReactNode;
  /** Facts about the record being acted on (name, plan, amount, …). */
  details?: ConfirmDetail[];
  /** Extra content such as a reason field. */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
  icon?: LucideIcon;
  /** Block confirming (e.g. until a required reason is typed). */
  confirmDisabled?: boolean;
  /** Turn a thrown error into a message (defaults to its `message`). */
  errorMessage?: (error: unknown) => string;
}

/** Premium confirmation modal used for every irreversible or impactful action. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  details,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  icon,
  confirmDisabled,
  errorMessage = (e) =>
    e instanceof Error ? e.message : 'Something went wrong. Please try again.',
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { titleId, descriptionId } = useDialogIds();
  const v = VARIANT[variant];
  const Icon = icon ?? v.icon;

  const close = () => {
    if (pending) return;
    setError(null);
    onClose();
  };
  const confirm = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      setPending(false);
      onClose();
    } catch (e) {
      setPending(false);
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissible={!pending}
      labelledBy={titleId}
      describedBy={description ? descriptionId : undefined}
      // Destructive dialogs open on Cancel so Enter never confirms by accident.
      initialFocus={variant === 'danger' || variant === 'warning' ? cancelRef : undefined}
      role="alertdialog"
      size="md"
    >
      <div className="flex gap-4 p-6 max-sm:flex-col">
        <span
          className={cn('flex size-11 shrink-0 items-center justify-center rounded-full', v.tile)}
        >
          <Icon className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="space-y-1.5">
            <h2 id={titleId} className="text-base font-semibold tracking-tight">
              {title}
            </h2>
            {description ? (
              <div id={descriptionId} className="text-sm leading-relaxed text-muted-foreground">
                {description}
              </div>
            ) : null}
          </div>
          {details?.length ? (
            <dl className="divide-y rounded-lg border bg-muted/40 text-sm">
              {details.map((d) => (
                <div key={d.label} className="flex justify-between gap-4 px-3 py-2">
                  <dt className="text-muted-foreground">{d.label}</dt>
                  <dd className="text-right font-medium">{d.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {children}
          {error ? (
            <p
              role="alert"
              className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300"
            >
              {error}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-col-reverse gap-2 border-t bg-muted/30 px-6 py-4 sm:flex-row sm:justify-end">
        <Button ref={cancelRef} variant="outline" onClick={close} disabled={pending}>
          {cancelLabel}
        </Button>
        <Button
          className={v.button}
          onClick={() => void confirm()}
          disabled={pending || confirmDisabled}
          aria-busy={pending}
        >
          {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}

type PresetProps = Omit<ConfirmDialogProps, 'title' | 'variant' | 'icon' | 'confirmLabel'> & {
  /** What is being acted on, e.g. "subscription plan". */
  entity: string;
  /** The record's name, shown in the title area. */
  name?: string;
  title?: ReactNode;
  confirmLabel?: string;
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Permanent removal. Danger styling; focus starts on Cancel. */
export function DeleteConfirmDialog({ entity, name, title, confirmLabel, ...p }: PresetProps) {
  return (
    <ConfirmDialog
      variant="danger"
      icon={Trash2}
      title={title ?? `Delete ${entity}?`}
      confirmLabel={confirmLabel ?? `Delete ${cap(entity.split(' ').pop()!)}`}
      description={
        p.description ?? (
          <>
            {name ? <strong className="text-foreground">{name}</strong> : `This ${entity}`} will be
            permanently deleted. This cannot be undone.
          </>
        )
      }
      {...p}
    />
  );
}

/** Reversible removal from use (can be restored). Warning styling. */
export function ArchiveConfirmDialog({ entity, name, title, confirmLabel, ...p }: PresetProps) {
  return (
    <ConfirmDialog
      variant="warning"
      icon={Archive}
      title={title ?? `Archive ${entity}?`}
      confirmLabel={confirmLabel ?? `Archive ${cap(entity.split(' ').pop()!)}`}
      description={
        p.description ?? (
          <>
            {name ? <strong className="text-foreground">{name}</strong> : `This ${entity}`} will be
            archived. You can restore it later.
          </>
        )
      }
      {...p}
    />
  );
}

/** Blocks access for an account or restaurant until reinstated. Danger styling. */
export function SuspendConfirmDialog({ entity, name, title, confirmLabel, ...p }: PresetProps) {
  return (
    <ConfirmDialog
      variant="danger"
      icon={ShieldOff}
      title={title ?? `Suspend ${entity}?`}
      confirmLabel={confirmLabel ?? 'Suspend'}
      description={
        p.description ?? (
          <>
            {name ? <strong className="text-foreground">{name}</strong> : `This ${entity}`} will
            lose access immediately until it is reinstated.
          </>
        )
      }
      {...p}
    />
  );
}

/** Blocking progress for a long operation that must not be interrupted (e.g. confirming a payment). */
export function LoadingDialog({
  open,
  title,
  description,
}: {
  open: boolean;
  title: string;
  description?: string;
}) {
  const { titleId, descriptionId } = useDialogIds();
  return (
    <Dialog
      open={open}
      onClose={() => undefined}
      dismissible={false}
      labelledBy={titleId}
      describedBy={description ? descriptionId : undefined}
      size="sm"
    >
      <div
        className="flex flex-col items-center gap-3 p-8 text-center"
        aria-live="polite"
        aria-busy
      >
        <Loader2 className="size-8 animate-spin text-emerald-600" aria-hidden />
        <h2 id={titleId} className="font-semibold">
          {title}
        </h2>
        {description ? (
          <p id={descriptionId} className="text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
