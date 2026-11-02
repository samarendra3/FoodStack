'use client';

import { Badge } from '@foodstack/ui/components/badge';
import { Card, CardDescription, CardHeader, CardTitle } from '@foodstack/ui/components/card';
import { EmptyState } from '@foodstack/ui/components/empty-state';
import { useQuery } from '@tanstack/react-query';
import { Building2, ClipboardList, MapPin, ShieldCheck, Store, Users } from 'lucide-react';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { StatCard, StatCardSkeleton } from '@/components/dashboard/stat-card';
import { authErrorMessage } from '@/lib/auth/errors';
import { roleLabel } from '@/lib/auth/roles';

interface Overview {
  tenant: { id: string; name: string; status: string; trialEndsAt: string | null } | null;
  restaurants: {
    id: string;
    name: string;
    currencyCode: string;
    timezone: string;
    status: string;
  }[];
  branches: { id: string; name: string; code: string; restaurantId: string }[];
  activeMembers: number | null;
  roles: string[];
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export default function RestaurantDashboardPage() {
  const { client } = useAuth();
  const profile = useProfile();
  const overview = useQuery({
    queryKey: ['restaurant', 'overview', profile.activeTenant?.id],
    queryFn: () => client.request<Overview>('/restaurant/overview'),
  });
  const data = overview.data;
  const firstName = profile.user.fullName.split(' ')[0];

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Welcome back, {firstName}</h1>
          <p className="text-sm text-muted-foreground">
            {profile.activeTenant?.name} · {profile.roles.map(roleLabel).join(', ')}
          </p>
        </div>
        {data?.tenant ? (
          <Badge variant={data.tenant.status === 'trial' ? 'info' : 'default'} className="w-fit">
            {data.tenant.status === 'trial' && data.tenant.trialEndsAt
              ? `Trial until ${dateFormat.format(new Date(data.tenant.trialEndsAt))}`
              : data.tenant.status.charAt(0).toUpperCase() + data.tenant.status.slice(1)}
          </Badge>
        ) : null}
      </div>

      {overview.isError ? (
        <Card className="border-destructive/30 text-sm text-destructive">
          {authErrorMessage(overview.error)}
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {data ? (
            <>
              <StatCard label="Restaurants" value={data.restaurants.length} icon={<Store />} />
              <StatCard
                label="Branches you manage"
                value={data.branches.length}
                icon={<MapPin />}
              />
              <StatCard
                label="Team members"
                value={data.activeMembers ?? '—'}
                hint={data.activeMembers === null ? 'Requires team access' : 'Active members'}
                icon={<Users />}
              />
              <StatCard
                label="Your access"
                value={
                  <span className="text-lg">{data.roles.map(roleLabel).join(', ') || '—'}</span>
                }
                icon={<ShieldCheck />}
              />
            </>
          ) : (
            Array.from({ length: 4 }, (_, i) => <StatCardSkeleton key={i} />)
          )}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card className="gap-0 p-0">
          <CardHeader className="border-b p-5">
            <CardTitle>Branches</CardTitle>
            <CardDescription>Locations you can work in.</CardDescription>
          </CardHeader>
          {!data ? (
            <div className="space-y-3 p-5" aria-hidden>
              {Array.from({ length: 2 }, (_, i) => (
                <div key={i} className="h-12 animate-pulse rounded bg-muted" />
              ))}
            </div>
          ) : (
            <ul className="divide-y">
              {data.branches.map((b) => (
                <li key={b.id} className="flex items-center gap-3 px-5 py-3.5">
                  <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Building2 className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{b.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {data.restaurants.find((r) => r.id === b.restaurantId)?.name} · {b.code}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <EmptyState
          className="bg-card"
          icon={<ClipboardList className="size-5" />}
          title="Menu, tables and orders are next"
          description="Floors, tables, menus, orders, kitchen tickets, billing and inventory appear here as each module is released."
        />
      </div>
    </div>
  );
}
