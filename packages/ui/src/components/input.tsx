import type { ComponentProps } from 'react';
import { cn } from '../lib/utils';

export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return (
    <input
      data-slot="input"
      type={type}
      className={cn(
        'flex h-11 w-full min-w-0 rounded-md border bg-card px-3 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground sm:text-sm',
        'focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-ring/40',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
