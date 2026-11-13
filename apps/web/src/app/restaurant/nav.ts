import type { SessionProfile } from '@foodstack/types';
import {
  PackagePlus,
  Armchair,
  ArrowLeftRight,
  BadgePercent,
  BarChart3,
  Bell,
  Blocks,
  BookOpen,
  Boxes,
  Building2,
  CalendarCheck,
  CalendarClock,
  ChartColumnIncreasing,
  ChefHat,
  ClipboardList,
  CookingPot,
  CreditCard,
  FileText,
  Gift,
  HandPlatter,
  LayoutDashboard,
  LayoutGrid,
  type LucideIcon,
  MonitorSmartphone,
  PackageCheck,
  Printer,
  QrCode,
  Receipt,
  ReceiptText,
  Scale,
  Settings,
  ShieldCheck,
  ShoppingBasket,
  Sliders,
  SquareStack,
  Store,
  Timer,
  Truck,
  Undo2,
  UsersRound,
  Wallet,
  Warehouse,
  ScrollText,
  Landmark,
  Banknote,
  TrendingUp,
  Users,
} from 'lucide-react';
import { canAccessPath, hasPermissionAnywhere } from '@/lib/auth/access';

/*
 * The one navigation configuration for the restaurant area (sidebar, search, breadcrumbs).
 *
 * Restaurant workflow it follows: floor → table → dining session (a table can host several over
 * the day) → order → KOT → kitchen → serve → bill → payment → table settled.
 *
 * `href` only for routes that exist. Items without one are modules not built yet: they render as
 * "Soon" (never as links), and only for people whose permissions will cover them. Hiding is UX
 * only — every API is authorized again server-side, per tenant and branch.
 */

export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Live route. Omitted while the module is not built. */
  href?: string;
  /** Visible to users holding at least one of these, in any scope. */
  anyPermission: readonly string[];
  /** Key of a live count shown as a badge (only real data). */
  badge?: 'pendingInvites';
}

export interface NavGroup {
  id: string;
  title: string;
  items: readonly NavItem[];
}

// Permission sets reused below.
const MANAGE = ['restaurant:manage'] as const;

export const RESTAURANT_NAV: readonly NavGroup[] = [
  {
    id: 'workspace',
    title: 'Workspace',
    items: [
      {
        id: 'dashboard',
        label: 'Dashboard',
        href: '/restaurant/dashboard',
        icon: LayoutDashboard,
        anyPermission: ['restaurant:read', 'branch:manage'],
      },
    ],
  },
  {
    id: 'orders',
    title: 'Order management',
    items: [
      {
        id: 'pos',
        label: 'POS / Billing',
        href: '/pos',
        icon: MonitorSmartphone,
        anyPermission: ['pos:access'],
      },
      {
        id: 'orders',
        label: 'Orders',
        href: '/restaurant/orders',
        icon: ClipboardList,
        anyPermission: ['order:read'],
      },
      {
        id: 'reservations',
        label: 'Reservations',
        href: '/restaurant/reservations',
        icon: CalendarCheck,
        anyPermission: ['reservation:read'],
      },
      {
        id: 'kot',
        label: 'KOT / Kitchen Tickets',
        href: '/restaurant/kot',
        icon: ScrollText,
        anyPermission: ['kds:access'],
      },
      {
        id: 'kds',
        label: 'Kitchen Display',
        href: '/kitchen',
        icon: ChefHat,
        anyPermission: ['kds:access'],
      },
      {
        id: 'waiter',
        label: 'Waiter Management',
        href: '/waiter',
        icon: HandPlatter,
        anyPermission: ['waiter:access'],
      },
    ],
  },
  {
    id: 'floor',
    title: 'Floor management',
    items: [
      {
        id: 'floors',
        label: 'Floor Management',
        href: '/restaurant/floor-management',
        icon: LayoutGrid,
        anyPermission: ['branch:read'],
      },
      {
        id: 'tables',
        label: 'Tables & Sections',
        href: '/restaurant/tables',
        icon: Armchair,
        anyPermission: ['branch:read'],
      },
      {
        id: 'sessions',
        label: 'Dining Sessions',
        href: '/restaurant/dining-sessions',
        icon: Timer,
        anyPermission: ['order:read', 'pos:access', 'waiter:access'],
      },
    ],
  },
  {
    id: 'menu',
    title: 'Menu & catalog',
    items: [
      {
        id: 'menus',
        label: 'Menu Management',
        href: '/restaurant/menu',
        icon: BookOpen,
        anyPermission: ['menu:manage', 'menu:read'],
      },
      {
        id: 'addons',
        label: 'Add-ons & Variants',
        href: '/restaurant/menu-addons',
        icon: Sliders,
        anyPermission: ['menu:read'],
      },
      {
        id: 'combos',
        label: 'Combos & Meal Deals',
        href: '/restaurant/combos',
        icon: SquareStack,
        anyPermission: ['menu:read'],
      },
      {
        id: 'qr',
        label: 'QR Menu',
        href: '/restaurant/qr-menu',
        icon: QrCode,
        anyPermission: ['menu:read'],
      },
    ],
  },
  {
    id: 'inventory',
    title: 'Inventory & procurement',
    items: [
      {
        id: 'stock',
        label: 'Inventory',
        href: '/restaurant/inventory',
        icon: Warehouse,
        anyPermission: ['inventory:read', 'inventory:manage'],
      },
      {
        id: 'purchase-orders',
        label: 'Purchase Orders',
        href: '/restaurant/purchase-orders',
        icon: ShoppingBasket,
        anyPermission: ['inventory:read'],
      },
      {
        id: 'suppliers',
        label: 'Suppliers',
        href: '/restaurant/suppliers',
        icon: Truck,
        anyPermission: ['inventory:read'],
      },
      {
        id: 'transfers',
        label: 'Stock Transfers',
        href: '/restaurant/stock-transfers',
        icon: ArrowLeftRight,
        anyPermission: ['inventory:read'],
      },
      {
        id: 'adjustments',
        label: 'Stock Adjustments',
        href: '/restaurant/stock-adjustments',
        icon: PackageCheck,
        anyPermission: ['inventory:read'],
      },
      {
        id: 'recipes',
        label: 'Recipes & Ingredients',
        href: '/restaurant/recipes',
        icon: CookingPot,
        anyPermission: ['menu:read'],
      },
    ],
  },
  {
    id: 'customers',
    title: 'Customers',
    items: [
      {
        id: 'customers',
        label: 'Customer Management',
        href: '/restaurant/customers',
        icon: Users,
        anyPermission: ['order:read'],
      },
      {
        id: 'loyalty',
        label: 'Loyalty & Rewards',
        href: '/restaurant/loyalty',
        icon: Gift,
        anyPermission: ['order:read'],
      },
      {
        id: 'discounts',
        label: 'Discounts & Coupons',
        href: '/restaurant/menu/promotions',
        icon: BadgePercent,
        anyPermission: ['promotion:read'],
      },
    ],
  },
  {
    id: 'finance',
    title: 'Billing & finance',
    items: [
      {
        id: 'billing-desk',
        label: 'Billing desk',
        href: '/restaurant/billing',
        icon: Wallet,
        anyPermission: ['order:read', 'pos:access'],
      },
      {
        id: 'bills',
        label: 'Bills & Invoices',
        href: '/restaurant/orders?status=completed',
        icon: ReceiptText,
        anyPermission: ['order:read'],
      },
      {
        id: 'payments',
        label: 'Payments',
        href: '/restaurant/payments',
        icon: CreditCard,
        anyPermission: ['order:read'],
      },
      {
        id: 'usage-addons',
        label: 'Usage & Add-ons',
        href: '/restaurant/addons',
        icon: PackagePlus,
        anyPermission: ['restaurant:read'],
      },
      {
        id: 'refunds',
        label: 'Refunds & Voids',
        href: '/restaurant/refunds',
        icon: Undo2,
        anyPermission: ['order:read'],
      },
      {
        id: 'expenses',
        label: 'Expenses',
        href: '/restaurant/expenses',
        icon: Receipt,
        anyPermission: ['expense:read'],
      },
      {
        id: 'register',
        label: 'Cash Register',
        href: '/restaurant/cash-register',
        icon: Banknote,
        anyPermission: ['cash:read'],
      },
      {
        id: 'shift-closing',
        label: 'Shift Closing',
        href: '/restaurant/shift-closing',
        icon: Wallet,
        anyPermission: ['cash:read'],
      },
      {
        id: 'tax',
        label: 'Tax Management',
        href: '/restaurant/tax',
        icon: Landmark,
        anyPermission: ['restaurant:read'],
      },
    ],
  },
  {
    id: 'reports',
    title: 'Reports & analytics',
    items: [
      {
        id: 'sales-reports',
        label: 'Sales Reports',
        href: '/restaurant/sales-reports',
        icon: TrendingUp,
        anyPermission: ['report:view'],
      },
      {
        id: 'order-reports',
        label: 'Order Reports',
        href: '/restaurant/order-reports',
        icon: FileText,
        anyPermission: ['report:view'],
      },
      {
        id: 'product-performance',
        label: 'Product Performance',
        href: '/restaurant/product-performance',
        icon: ChartColumnIncreasing,
        anyPermission: ['report:view'],
      },
      {
        id: 'inventory-reports',
        label: 'Reports',
        href: '/restaurant/reports',
        icon: Boxes,
        anyPermission: ['report:view'],
      },
      {
        id: 'financial-reports',
        label: 'Financial Reports',
        href: '/restaurant/financial-reports',
        icon: Scale,
        anyPermission: ['report:view'],
      },
      {
        id: 'staff-performance',
        label: 'Staff Performance',
        href: '/restaurant/staff-performance',
        icon: BarChart3,
        anyPermission: ['report:view'],
      },
    ],
  },
  {
    id: 'people',
    title: 'Staff & branches',
    items: [
      {
        id: 'branches',
        label: 'Branch Management',
        href: '/restaurant/branches',
        icon: Building2,
        anyPermission: ['branch:read'],
      },
      {
        id: 'staff',
        label: 'Staff Management',
        href: '/restaurant/team',
        icon: UsersRound,
        anyPermission: ['member:read'],
        badge: 'pendingInvites',
      },
      {
        id: 'roles',
        label: 'Roles & Permissions',
        href: '/restaurant/roles',
        icon: ShieldCheck,
        anyPermission: ['member:read'],
      },
      {
        id: 'attendance',
        label: 'Attendance & Shifts',
        href: '/restaurant/attendance',
        icon: CalendarClock,
        anyPermission: ['attendance:self', 'member:read'],
      },
    ],
  },
  {
    id: 'settings',
    title: 'Settings',
    items: [
      {
        id: 'restaurant-settings',
        label: 'Restaurant Settings',
        href: '/restaurant/restaurant-settings',
        icon: Store,
        anyPermission: ['restaurant:read'],
      },
      {
        id: 'printers',
        label: 'Printers & Devices',
        href: '/restaurant/printers',
        icon: Printer,
        anyPermission: ['branch:read'],
      },
      {
        id: 'integrations',
        label: 'Integrations',
        href: '/restaurant/integrations',
        icon: Blocks,
        anyPermission: ['restaurant:read'],
      },
      {
        id: 'subscription',
        label: 'Subscription & Billing',
        href: '/restaurant/profile#subscription',
        icon: Settings,
        anyPermission: MANAGE,
      },
      {
        id: 'notifications',
        label: 'Notifications',
        href: '/restaurant/notifications',
        icon: Bell,
        anyPermission: ['restaurant:read'],
      },
    ],
  },
];

function visible(profile: SessionProfile, item: NavItem): boolean {
  const permitted =
    item.anyPermission.length === 0 ||
    item.anyPermission.some((p) => hasPermissionAnywhere(profile, p));
  return permitted && (!item.href || canAccessPath(profile, item.href));
}

/** Groups and items this user may see; empty groups are dropped. */
/**
 * Groups and items this user may open. Modules that are not built yet are left out of the
 * sidebar (they appear automatically once they get an `href`); empty groups are dropped.
 */
export function navFor(profile: SessionProfile): NavGroup[] {
  return RESTAURANT_NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => Boolean(i.href) && visible(profile, i)),
  })).filter((g) => g.items.length > 0);
}

/** Modules on the way that this user will be able to use (for the "coming soon" hint). */
export function upcomingFor(profile: SessionProfile): NavItem[] {
  return RESTAURANT_NAV.flatMap((g) => g.items).filter((i) => !i.href && visible(profile, i));
}

export function isActive(item: NavItem, pathname: string): boolean {
  return Boolean(item.href && (pathname === item.href || pathname.startsWith(`${item.href}/`)));
}

/** Live destinations this user can open (for search). */
export function liveItemsFor(
  profile: SessionProfile,
): (NavItem & { href: string; group: string })[] {
  return navFor(profile).flatMap((g) =>
    g.items
      .filter((i): i is NavItem & { href: string } => Boolean(i.href))
      .map((i) => ({ ...i, group: g.title })),
  );
}

/** Page title for the breadcrumb, from the live nav. */
export function pageLabel(pathname: string): string {
  for (const g of RESTAURANT_NAV) {
    for (const i of g.items) if (isActive(i, pathname)) return i.label;
  }
  return 'Dashboard';
}
