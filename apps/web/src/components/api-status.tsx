'use client';

import { Badge } from '@foodstack/ui/components/badge';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Shows whether the FoodStack API is reachable (uses the shared API client). */
export function ApiStatus() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => api.health.check(signal),
    refetchInterval: 60_000,
  });

  if (isPending) return <Badge variant="outline">Checking API…</Badge>;
  if (isError || data.status !== 'ok') return <Badge variant="destructive">API unavailable</Badge>;
  return <Badge>API online</Badge>;
}
