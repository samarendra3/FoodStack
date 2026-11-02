'use client';

import { Input } from '@foodstack/ui/components/input';
import { Label } from '@foodstack/ui/components/label';
import { cn } from '@foodstack/ui/lib/utils';
import { AlertCircle, CheckCircle2, Eye, EyeOff } from 'lucide-react';
import { type ComponentProps, type ReactNode, useId, useState } from 'react';

interface FieldProps extends Omit<ComponentProps<'input'>, 'id'> {
  label: string;
  error?: string | undefined;
  hint?: string;
  /** Rendered to the right of the label (e.g. "Forgot password?"). */
  labelAside?: ReactNode;
  icon?: ReactNode;
  /** Rendered inside the input on the right (e.g. a show/hide button). */
  trailing?: ReactNode;
}

/** Labelled input with accessible error text. */
export function Field({
  label,
  error,
  hint,
  labelAside,
  icon,
  trailing,
  className,
  ...props
}: FieldProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {labelAside}
      </div>
      <div className="relative">
        {icon ? (
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground [&_svg]:size-4">
            {icon}
          </span>
        ) : null}
        <Input
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(icon && 'pl-9', className)}
          {...props}
        />
        {trailing ? (
          <span className="absolute top-1/2 right-1 -translate-y-1/2">{trailing}</span>
        ) : null}
      </div>
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Password field with a show/hide toggle. */
export function PasswordField(props: Omit<FieldProps, 'type'>) {
  const [visible, setVisible] = useState(false);
  return (
    <Field
      {...props}
      type={visible ? 'text' : 'password'}
      className={cn('pr-11', props.className)}
      trailing={
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {visible ? (
            <EyeOff className="size-4" aria-hidden />
          ) : (
            <Eye className="size-4" aria-hidden />
          )}
        </button>
      }
    />
  );
}

export function FormAlert({
  tone = 'error',
  children,
}: {
  tone?: 'error' | 'success';
  children: ReactNode;
}) {
  const Icon = tone === 'error' ? AlertCircle : CheckCircle2;
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-3 rounded-lg border px-4 py-3 text-sm',
        tone === 'error'
          ? 'border-destructive/30 bg-destructive/5 text-destructive'
          : 'border-primary/30 bg-primary/5 text-foreground',
      )}
    >
      <Icon
        className={cn('mt-0.5 size-4 shrink-0', tone === 'success' && 'text-primary')}
        aria-hidden
      />
      <div className="space-y-1">{children}</div>
    </div>
  );
}

/** Maps Zod issues to the first message per top-level field. */
export function fieldErrors(
  issues: { path: PropertyKey[]; message: string }[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? '');
    errors[key] ??= issue.message;
  }
  return errors;
}
