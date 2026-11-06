import { AlertCircle } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * Message under a form field. Give the field `aria-invalid` and `aria-describedby={id}` so screen
 * readers read the message with the field. Renders nothing without a message.
 */
export function FormFieldError({
  id,
  message,
  className,
}: {
  id?: string;
  message?: string | null;
  className?: string;
}) {
  if (!message) return null;
  return (
    <span
      id={id}
      role="alert"
      className={cn('flex items-center gap-1 text-xs text-red-600 dark:text-red-400', className)}
    >
      <AlertCircle className="size-3.5 shrink-0" aria-hidden />
      {message}
    </span>
  );
}
