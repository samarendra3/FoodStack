'use client';

import { Badge, type BadgeProps } from '@foodstack/ui/components/badge';
import { Card, CardDescription, CardHeader, CardTitle } from '@foodstack/ui/components/card';
import { EmptyState } from '@foodstack/ui/components/empty-state';
import { useQuery } from '@tanstack/react-query';
import { Activity, Building2, ShieldAlert, UserRound } from 'lucide-react';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { StatCard, StatCardSkeleton } from '@/components/dashboard/stat-card';
import { authErrorMessage } from '@/lib/auth/errors';

interface PlatformDashboard {
  tenants: { total: number; byStatus: Record<string, number>; newLast7Days: number };
  users: number;
  activeSessions: number;
  failedLoginsLast24h: number;
}

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  trialEndsAt: string | null;
  createdAt: string;
  activeMembers: number;
}

const STATUS_BADGE: Record<string, BadgeProps['variant']> = {
  active: 'default',
  trial: 'info',
  suspended: 'warning',
  deactivated: 'destructive',
};

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export default function PlatformDashboardPage() {
  const { client } = useAuth();
  const profile = useProfile();
  const dashboard = useQuery({
    queryKey: ['platform', 'dashboard'],
    queryFn: () => client.request<PlatformDashboard>('/platform/dashboard'),
  });
  const tenants = useQuery({
    queryKey: ['platform', 'tenants'],
    queryFn: () => client.request<TenantRow[]>('/platform/tenants'),
  });
  const d = dashboard.data;

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Platform overview</h1>
        <p className="text-sm text-muted-foreground">
          Signed in as {profile.user.fullName}. Figures are live from the platform database.
        </p>
      </div>

      {dashboard.isError ? (
        <Card className="border-destructive/30 text-sm text-destructive">
          {authErrorMessage(dashboard.error)}
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {d ? (
            <>
              <StatCard
                label="Restaurants"
                value={d.tenants.total}
                hint={`${d.tenants.newLast7Days} new in the last 7 days`}
                icon={<Building2 />}
              />
              <StatCard
                label="Active or in trial"
                value={(d.tenants.byStatus.active ?? 0) + (d.tenants.byStatus.trial ?? 0)}
                hint={`${d.tenants.byStatus.suspended ?? 0} suspended`}
                icon={<Activity />}
              />
              <StatCard
                label="Users"
                value={d.users}
                hint={`${d.activeSessions} active sessions`}
                icon={<UserRound />}
              />
              <StatCard
                label="Failed sign-ins"
                value={d.failedLoginsLast24h}
                hint="Last 24 hours"
                icon={<ShieldAlert />}
              />
            </>
          ) : (
            Array.from({ length: 4 }, (_, i) => <StatCardSkeleton key={i} />)
          )}
        </div>
      )}

      <Card id="restaurants" className="scroll-mt-24 gap-0 p-0">
        <CardHeader className="border-b p-5">
          <CardTitle>Restaurant accounts</CardTitle>
          <CardDescription>Every registered restaurant, newest first.</CardDescription>
        </CardHeader>
        {tenants.isPending ? (
          <div className="space-y-3 p-5" aria-hidden>
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : tenants.isError ? (
          <p className="p-5 text-sm text-destructive">{authErrorMessage(tenants.error)}</p>
        ) : tenants.data.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={<Building2 className="size-5" />}
              title="No restaurants yet"
              description="Restaurants appear here as soon as they are registered."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="bg-muted/50 text-left text-xs tracking-wide text-muted-foreground uppercase">
                <tr>
                  <th className="px-5 py-3 font-medium">Restaurant</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 text-right font-medium">Team</th>
                  <th className="px-5 py-3 font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {tenants.data.map((t) => (
                  <tr key={t.id} className="hover:bg-muted/30">
                    <td className="px-5 py-3">
                      <p className="font-medium">{t.name}</p>
                      <p className="text-xs text-muted-foreground">{t.slug}</p>
                    </td>
                    <td className="px-5 py-3">
                      <Badge variant={STATUS_BADGE[t.status] ?? 'outline'} className="capitalize">
                        {t.status}
                      </Badge>
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums">{t.activeMembers}</td>
                    <td className="px-5 py-3 text-muted-foreground">
                      {dateFormat.format(new Date(t.createdAt))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
