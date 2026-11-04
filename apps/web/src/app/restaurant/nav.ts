import type { SessionProfile } from '@foodstack/types';
import {
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
const BRANCH_OPS = ['branch:manage'] as const;
const TILL = ['pos:access', 'branch:manage'] as const;
const FLOOR = ['waiter:access', 'branch:manage'] as const;
const KITCHEN = ['kds:access', 'branch:manage'] as const;
const REPORTS = ['report:view', 'audit:view'] as const;

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
      { id: 'reservations', label: 'Reservations', icon: CalendarCheck, anyPermission: FLOOR },
      { id: 'kot', label: 'KOT / Kitchen Tickets', icon: ScrollText, anyPermission: KITCHEN },
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
      { id: 'floors', label: 'Floor Management', icon: LayoutGrid, anyPermission: BRANCH_OPS },
      { id: 'tables', label: 'Tables & Sections', icon: Armchair, anyPermission: FLOOR },
      { id: 'sessions', label: 'Dining Sessions', icon: Timer, anyPermission: FLOOR },
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
      { id: 'addons', label: 'Add-ons & Variants', icon: Sliders, anyPermission: MANAGE },
      { id: 'combos', label: 'Combos & Meal Deals', icon: SquareStack, anyPermission: MANAGE },
      { id: 'qr', label: 'QR Menu', icon: QrCode, anyPermission: MANAGE },
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
        icon: ShoppingBasket,
        anyPermission: MANAGE,
      },
      { id: 'suppliers', label: 'Suppliers', icon: Truck, anyPermission: MANAGE },
      { id: 'transfers', label: 'Stock Transfers', icon: ArrowLeftRight, anyPermission: MANAGE },
      { id: 'adjustments', label: 'Stock Adjustments', icon: PackageCheck, anyPermission: MANAGE },
      { id: 'recipes', label: 'Recipes & Ingredients', icon: CookingPot, anyPermission: MANAGE },
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
      { id: 'loyalty', label: 'Loyalty & Rewards', icon: Gift, anyPermission: MANAGE },
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
      { id: 'refunds', label: 'Refunds & Voids', icon: Undo2, anyPermission: BRANCH_OPS },
      { id: 'expenses', label: 'Expenses', icon: Receipt, anyPermission: MANAGE },
      { id: 'register', label: 'Cash Register', icon: Banknote, anyPermission: TILL },
      { id: 'shift-closing', label: 'Shift Closing', icon: Wallet, anyPermission: TILL },
      { id: 'tax', label: 'Tax Management', icon: Landmark, anyPermission: MANAGE },
    ],
  },
  {
    id: 'reports',
    title: 'Reports & analytics',
    items: [
      { id: 'sales-reports', label: 'Sales Reports', icon: TrendingUp, anyPermission: REPORTS },
      { id: 'order-reports', label: 'Order Reports', icon: FileText, anyPermission: REPORTS },
      {
        id: 'product-performance',
        label: 'Product Performance',
        icon: ChartColumnIncreasing,
        anyPermission: REPORTS,
      },
      {
        id: 'inventory-reports',
        label: 'Reports',
        href: '/restaurant/reports',
        icon: Boxes,
        anyPermission: ['report:view'],
      },
      { id: 'financial-reports', label: 'Financial Reports', icon: Scale, anyPermission: REPORTS },
      {
        id: 'staff-performance',
        label: 'Staff Performance',
        icon: BarChart3,
        anyPermission: REPORTS,
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
        icon: ShieldCheck,
        anyPermission: ['role:manage'],
      },
      {
        id: 'attendance',
        label: 'Attendance & Shifts',
        icon: CalendarClock,
        anyPermission: ['member:manage'],
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
        icon: Store,
        anyPermission: MANAGE,
      },
      {
        id: 'printers',
        label: 'Printers & Devices',
        icon: Printer,
        anyPermission: [...MANAGE, ...BRANCH_OPS],
      },
      { id: 'integrations', label: 'Integrations', icon: Blocks, anyPermission: MANAGE },
      {
        id: 'subscription',
        label: 'Subscription & Billing',
        icon: Settings,
        anyPermission: MANAGE,
      },
      {
        id: 'notifications',
        label: 'Notifications',
        icon: Bell,
        anyPermission: ['restaurant:read', 'branch:manage'],
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
