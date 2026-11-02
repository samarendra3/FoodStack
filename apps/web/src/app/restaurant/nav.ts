import type { SessionProfile } from '@foodstack/types';
import {
  BarChart3,
  Boxes,
  Building2,
  ChefHat,
  ClipboardList,
  ConciergeBell,
  CreditCard,
  LayoutDashboard,
  type LucideIcon,
  MonitorSmartphone,
  Settings,
  ShieldCheck,
  Tags,
  UsersRound,
  UtensilsCrossed,
  LayoutGrid,
} from 'lucide-react';
import { canAccessPath, hasPermissionAnywhere } from '@/lib/auth/access';

export interface RestaurantNavItem {
  label: string;
  icon: LucideIcon;
  /** Live route. Without one the module is not built yet and is shown as "Soon". */
  href?: string;
  /** Shown only to users holding at least one of these (any scope). */
  anyPermission: string[];
}

export interface RestaurantNavGroup {
  id: string;
  title: string;
  items: RestaurantNavItem[];
}

/**
 * Restaurant navigation. Live items point at implemented routes; modules that do not exist yet
 * have no href and render as disabled "Soon" entries, only for people who will be able to use
 * them. Every API behind these pages is authorized again by the server.
 */
export const RESTAURANT_NAV: RestaurantNavGroup[] = [
  {
    id: 'overview',
    title: 'Overview',
    items: [
      {
        label: 'Dashboard',
        href: '/restaurant/dashboard',
        icon: LayoutDashboard,
        anyPermission: ['restaurant:read', 'branch:manage'],
      },
    ],
  },
  {
    id: 'management',
    title: 'Restaurant management',
    items: [
      {
        label: 'Branches',
        href: '/restaurant/branches',
        icon: Building2,
        anyPermission: ['branch:read'],
      },
      {
        label: 'Team & Staff',
        href: '/restaurant/team',
        icon: UsersRound,
        anyPermission: ['member:read'],
      },
    ],
  },
  {
    id: 'operations',
    title: 'Operations',
    items: [
      {
        label: 'Point of Sale',
        href: '/pos',
        icon: MonitorSmartphone,
        anyPermission: ['pos:access'],
      },
      { label: 'Floor & Tables', icon: LayoutGrid, anyPermission: ['branch:manage'] },
      { label: 'Orders', icon: ClipboardList, anyPermission: ['branch:manage', 'pos:access'] },
      { label: 'Kitchen Display', href: '/kitchen', icon: ChefHat, anyPermission: ['kds:access'] },
      { label: 'Waiter', href: '/waiter', icon: ConciergeBell, anyPermission: ['waiter:access'] },
    ],
  },
  {
    id: 'menu',
    title: 'Menu & inventory',
    items: [
      { label: 'Menu Management', icon: UtensilsCrossed, anyPermission: ['restaurant:manage'] },
      { label: 'Categories & Add-ons', icon: Tags, anyPermission: ['restaurant:manage'] },
      { label: 'Inventory', icon: Boxes, anyPermission: ['restaurant:manage'] },
    ],
  },
  {
    id: 'finance',
    title: 'Finance & analytics',
    items: [
      { label: 'Billing & Payments', icon: CreditCard, anyPermission: ['restaurant:manage'] },
      { label: 'Reports & Analytics', icon: BarChart3, anyPermission: ['audit:view'] },
    ],
  },
  {
    id: 'configuration',
    title: 'Configuration',
    items: [
      { label: 'Restaurant Settings', icon: Settings, anyPermission: ['restaurant:manage'] },
      { label: 'Roles & Permissions', icon: ShieldCheck, anyPermission: ['role:manage'] },
    ],
  },
];

/** Groups and items this user may see; empty groups are dropped. */
export function navFor(profile: SessionProfile): RestaurantNavGroup[] {
  return RESTAURANT_NAV.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) =>
        item.anyPermission.some((p) => hasPermissionAnywhere(profile, p)) &&
        (!item.href || canAccessPath(profile, item.href)),
    ),
  })).filter((group) => group.items.length > 0);
}

/** Page title for the breadcrumb, from the live nav. */
export function pageLabel(pathname: string): string {
  for (const group of RESTAURANT_NAV) {
    for (const item of group.items) {
      if (item.href && (pathname === item.href || pathname.startsWith(`${item.href}/`))) {
        return item.label;
      }
    }
  }
  return 'Dashboard';
}
