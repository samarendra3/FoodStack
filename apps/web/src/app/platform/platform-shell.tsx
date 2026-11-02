'use client';

import { DashboardShell, type NavSection } from '@foodstack/ui/layouts/dashboard-shell';
import { Building2, LayoutDashboard } from 'lucide-react';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { AccountMenu } from '@/components/account-menu';

/** Super Admin area. Further sections (plans, platform users, settings) arrive with their APIs. */
export function PlatformShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const nav: NavSection[] = [
    {
      title: 'Platform',
      items: [
        {
          label: 'Dashboard',
          href: '/platform/dashboard',
          icon: <LayoutDashboard className="size-4" />,
          active: pathname === '/platform/dashboard',
        },
        {
          label: 'Restaurants',
          href: '/platform/dashboard#restaurants',
          icon: <Building2 className="size-4" />,
        },
      ],
    },
  ];
  return (
    <DashboardShell
      nav={nav}
      breadcrumbs={[{ label: 'Platform', href: '/platform/dashboard' }, { label: 'Dashboard' }]}
      userArea={<AccountMenu />}
    >
      {children}
    </DashboardShell>
  );
}
