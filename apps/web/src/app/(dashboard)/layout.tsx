import { DashboardShell, type NavSection } from '@foodstack/ui/layouts/dashboard-shell';
import {
  BarChart3,
  Boxes,
  LayoutDashboard,
  Receipt,
  Settings,
  ShoppingBag,
  Users,
  UtensilsCrossed,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { UserMenu } from '@/components/user-menu';

// Navigation skeleton; routes are implemented in later phases.
const nav: NavSection[] = [
  {
    items: [
      {
        label: 'Dashboard',
        href: '/dashboard',
        icon: <LayoutDashboard className="size-4" />,
        active: true,
      },
    ],
  },
  {
    title: 'Operations',
    items: [
      { label: 'Orders', href: '/orders', icon: <ShoppingBag className="size-4" /> },
      { label: 'Menu', href: '/menu', icon: <UtensilsCrossed className="size-4" /> },
      { label: 'Billing', href: '/billing', icon: <Receipt className="size-4" /> },
      { label: 'Inventory', href: '/inventory', icon: <Boxes className="size-4" /> },
    ],
  },
  {
    title: 'Business',
    items: [
      { label: 'Customers', href: '/customers', icon: <Users className="size-4" /> },
      { label: 'Reports', href: '/reports', icon: <BarChart3 className="size-4" /> },
      { label: 'Settings', href: '/settings', icon: <Settings className="size-4" /> },
    ],
  },
];

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <DashboardShell
      nav={nav}
      breadcrumbs={[{ label: 'Home', href: '/dashboard' }, { label: 'Dashboard' }]}
      userArea={<UserMenu />}
    >
      {children}
    </DashboardShell>
  );
}
