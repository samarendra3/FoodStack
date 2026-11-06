'use client';

import { useToast } from '@foodstack/ui/components/toast';
import { useMemo } from 'react';
import { authErrorMessage } from '@/lib/auth/errors';

/**
 * The app's single way to report an outcome: success / info / warning toasts, and errors turned
 * into the server's own message (authErrorMessage) so API errors read the same everywhere.
 */
export function useNotify() {
  const toast = useToast();
  return useMemo(
    () => ({
      success: (title: string, description?: string) => toast.success(title, { description }),
      info: (title: string, description?: string) => toast.info(title, { description }),
      warning: (title: string, description?: string) => toast.warning(title, { description }),
      /** `error` may be an API error, an Error or a plain message. */
      error: (error: unknown, title?: string) =>
        title
          ? toast.error(title, { description: authErrorMessage(error) })
          : toast.error(typeof error === 'string' ? error : authErrorMessage(error)),
    }),
    [toast],
  );
}
