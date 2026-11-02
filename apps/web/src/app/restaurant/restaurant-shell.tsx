'use client';

import {
  DashboardShell,
  type NavItem,
  type NavSection,
} from '@foodstack/ui/layouts/dashboard-shell';
import { ChefHat, ConciergeBell, LayoutDashboard, MonitorSmartphone } from 'lucide-react';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { AccountMenu } from '@/components/account-menu';
import { useProfile } from '@/components/auth/auth-provider';
import { canAccessPath } from '@/lib/auth/access';

/**
 * Restaurant admin area. Only links the user may open are shown; menu, tables, orders, billing
 * and inventory join the navigation as those modules are built.
 */
export function RestaurantShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const profile = useProfile();
  const workspaces: NavItem[] = [
    { label: 'Point of sale', href: '/pos', icon: <MonitorSmartphone className="size-4" /> },
    { label: 'Kitchen display', href: '/kitchen', icon: <ChefHat className="size-4" /> },
    { label: 'Waiter', href: '/waiter', icon: <ConciergeBell className="size-4" /> },
  ].filter((item) => canAccessPath(profile, item.href));

  const nav: NavSection[] = [
    {
      items: [
        {
          label: 'Dashboard',
          href: '/restaurant/dashboard',
          icon: <LayoutDashboard className="size-4" />,
          active: pathname === '/restaurant/dashboard',
        },
      ],
    },
    ...(workspaces.length > 0 ? [{ title: 'Workspaces', items: workspaces }] : []),
  ];

  return (
    <DashboardShell
      nav={nav}
      breadcrumbs={[
        { label: profile.activeTenant?.name ?? 'Restaurant', href: '/restaurant/dashboard' },
        { label: 'Dashboard' },
      ]}
      userArea={<AccountMenu />}
    >
      {children}
    </DashboardShell>
  );
}
