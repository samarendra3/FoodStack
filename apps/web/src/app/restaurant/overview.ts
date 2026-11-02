'use client';

import { useQuery } from '@tanstack/react-query';
import { useAuth, useProfile } from '@/components/auth/auth-provider';

/** GET /restaurant/overview: what the signed-in member can see in their business. */
export interface RestaurantOverview {
  tenant: { id: string; name: string; status: string; trialEndsAt: string | null } | null;
  restaurants: {
    id: string;
    name: string;
    currencyCode: string;
    timezone: string;
    status: string;
  }[];
  branches: { id: string; name: string; code: string; restaurantId: string }[];
  /** Null when the caller may not see the team. */
  activeMembers: number | null;
  roles: string[];
}

export function useRestaurantOverview() {
  const { client } = useAuth();
  const profile = useProfile();
  return useQuery({
    queryKey: ['restaurant', 'overview', profile.activeTenant?.id],
    queryFn: () => client.request<RestaurantOverview>('/restaurant/overview'),
  });
}

/** Whole days until the trial ends (0 on the last day), or null when not on trial. */
export function trialDaysLeft(tenant: RestaurantOverview['tenant']): number | null {
  if (!tenant || tenant.status !== 'trial' || !tenant.trialEndsAt) return null;
  return Math.max(0, Math.ceil((new Date(tenant.trialEndsAt).getTime() - Date.now()) / 86_400_000));
}
