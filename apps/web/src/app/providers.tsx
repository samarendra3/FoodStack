'use client';

import { ApiError } from '@foodstack/api-client';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { AuthProvider } from '@/components/auth/auth-provider';
import { SUBSCRIPTION_ERROR_CODES } from '@/lib/billing';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => {
    // A 402 from any request means the trial or plan lapsed mid-session: re-check entitlement so
    // the subscription screen replaces the page instead of a string of failing requests.
    const onError = (error: unknown) => {
      if (error instanceof ApiError && SUBSCRIPTION_ERROR_CODES.includes(error.problem.code)) {
        void client.invalidateQueries({
          predicate: (q) => q.queryKey[0] === 'billing' && q.queryKey[2] === 'entitlement',
        });
      }
    };
    const client: QueryClient = new QueryClient({
      queryCache: new QueryCache({ onError }),
      mutationCache: new MutationCache({ onError }),
      defaultOptions: {
        queries: {
          staleTime: 30_000,
          refetchOnWindowFocus: false,
          retry: (count, error) =>
            !(error instanceof ApiError && error.problem.status === 402) && count < 1,
        },
      },
    });
    return client;
  });
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}
