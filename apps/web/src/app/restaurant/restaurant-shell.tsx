'use client';

import { cn } from '@foodstack/ui/lib/utils';
import {
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Loader2,
  LogOut,
  MapPin,
  Menu,
  X,
} from 'lucide-react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { BrandMark, BrandName } from '@/components/auth/auth-layout';
import { useProfile } from '@/components/auth/auth-provider';
import { NotificationsButton, UserMenu, useSignOut } from '@/components/shell/header-widgets';
import { initials, roleLabel } from '@/lib/auth/roles';
import { navFor, pageLabel, type RestaurantNavGroup, type RestaurantNavItem } from './nav';

const COLLAPSED_KEY = 'fs-restaurant-sidebar-collapsed';
const GROUPS_KEY = 'fs-restaurant-nav-closed';

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked (private mode): the choice lasts for this visit only.
  }
}

/** Restaurant workspace layout: navy sidebar (drawer on small screens) and a light header. */
export function RestaurantShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const profile = useProfile();
  const groups = navFor(profile);
  const [collapsed, setCollapsed] = useState(false);
  const [closedGroups, setClosedGroups] = useState<string[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Remembered layout choices (read after mount so server and client render the same).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from storage
    setCollapsed(readStorage(COLLAPSED_KEY, false));
    setClosedGroups(readStorage<string[]>(GROUPS_KEY, []));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawerOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      writeStorage(COLLAPSED_KEY, !c);
      return !c;
    });
  const toggleGroup = (id: string) =>
    setClosedGroups((prev) => {
      const next = prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id];
      writeStorage(GROUPS_KEY, next);
      return next;
    });

  const sidebarProps = { groups, pathname, closedGroups, toggleGroup };

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex min-h-dvh bg-[#F8FAFC] text-[#0F172A]">
        <motion.aside
          animate={{ width: collapsed ? 76 : 264 }}
          transition={{ type: 'spring', stiffness: 380, damping: 38 }}
          className="sticky top-0 hidden h-dvh shrink-0 lg:block"
        >
          <Sidebar {...sidebarProps} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
        </motion.aside>

        <AnimatePresence>
          {drawerOpen ? (
            <div className="fixed inset-0 z-40 lg:hidden">
              <motion.div
                className="absolute inset-0 bg-[#0F172A]/60 backdrop-blur-[2px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setDrawerOpen(false)}
              />
              <motion.div
                className="absolute inset-y-0 left-0 w-[17rem] max-w-[85vw] shadow-2xl"
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={{ type: 'spring', stiffness: 380, damping: 36 }}
                onClickCapture={(e) => {
                  if ((e.target as HTMLElement).closest('a')) setDrawerOpen(false);
                }}
              >
                <Sidebar {...sidebarProps} collapsed={false} onClose={() => setDrawerOpen(false)} />
              </motion.div>
            </div>
          ) : null}
        </AnimatePresence>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-[#E2E8F0] bg-white/90 px-4 backdrop-blur sm:px-6">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
              className="flex size-9 items-center justify-center rounded-lg text-[#64748B] hover:bg-slate-100 lg:hidden"
            >
              <Menu className="size-5" />
            </button>
            <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
              <ol className="flex items-center gap-1.5 text-sm text-[#64748B]">
                <li className="hidden truncate sm:block">
                  <Link href="/restaurant/dashboard" className="hover:text-[#0F172A]">
                    {profile.activeTenant?.name ?? 'Restaurant'}
                  </Link>
                </li>
                <ChevronRight className="hidden size-4 shrink-0 sm:block" aria-hidden />
                <li className="truncate font-medium text-[#0F172A]" aria-current="page">
                  {pageLabel(pathname)}
                </li>
              </ol>
            </nav>
            <div className="flex items-center gap-1 sm:gap-2">
              <NotificationsButton />
              <UserMenu />
            </div>
          </header>
          <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
        </div>
      </div>
    </MotionConfig>
  );
}

function Sidebar({
  groups,
  pathname,
  collapsed,
  closedGroups,
  toggleGroup,
  onToggleCollapsed,
  onClose,
}: {
  groups: RestaurantNavGroup[];
  pathname: string;
  collapsed: boolean;
  closedGroups: string[];
  toggleGroup: (id: string) => void;
  onToggleCollapsed?: () => void;
  onClose?: () => void;
}) {
  return (
    <div className="flex h-full flex-col bg-[#0F172A] text-slate-300">
      <div
        className={cn(
          'flex h-16 shrink-0 items-center border-b border-white/5',
          collapsed ? 'justify-center px-2' : 'justify-between px-5',
        )}
      >
        <Link
          href="/restaurant/dashboard"
          className="flex items-center gap-2.5"
          aria-label="FoodStack home"
        >
          <BrandMark className="size-9 shadow-none" />
          {collapsed ? null : <BrandName className="text-xl text-white" />}
        </Link>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="flex size-8 items-center justify-center rounded-lg hover:bg-white/10"
          >
            <X className="size-5" />
          </button>
        ) : null}
      </div>

      <ContextCard collapsed={collapsed} />

      <nav
        aria-label="Restaurant"
        className="flex-1 space-y-1 overflow-x-hidden overflow-y-auto px-3 pb-4 [scrollbar-width:thin] [scrollbar-color:rgb(255_255_255/0.1)_transparent]"
      >
        {groups.map((group) => {
          const open = collapsed || !closedGroups.includes(group.id);
          return (
            <div key={group.id} className="pt-3">
              {collapsed ? (
                <div className="mx-3 mb-2 h-px bg-white/5" aria-hidden />
              ) : (
                <button
                  type="button"
                  onClick={() => toggleGroup(group.id)}
                  aria-expanded={open}
                  className="flex w-full items-center justify-between rounded-md px-3 py-1.5 text-[11px] font-semibold tracking-wider text-slate-500 uppercase transition-colors hover:text-slate-300"
                >
                  {group.title}
                  <ChevronDown
                    className={cn(
                      'size-3.5 transition-transform duration-200',
                      !open && '-rotate-90',
                    )}
                    aria-hidden
                  />
                </button>
              )}
              <AnimatePresence initial={false}>
                {open ? (
                  <motion.ul
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                    className="space-y-0.5 overflow-hidden"
                  >
                    {group.items.map((item) => (
                      <li key={item.label}>
                        <NavLink item={item} pathname={pathname} collapsed={collapsed} />
                      </li>
                    ))}
                  </motion.ul>
                ) : null}
              </AnimatePresence>
            </div>
          );
        })}
      </nav>

      <ProfileFooter collapsed={collapsed} onToggleCollapsed={onToggleCollapsed} />
    </div>
  );
}

function NavLink({
  item,
  pathname,
  collapsed,
}: {
  item: RestaurantNavItem;
  pathname: string;
  collapsed: boolean;
}) {
  const Icon = item.icon;
  const active = Boolean(
    item.href && (pathname === item.href || pathname.startsWith(`${item.href}/`)),
  );
  const base = cn(
    'group relative flex items-center gap-3 rounded-lg text-sm transition-colors',
    collapsed ? 'size-11 justify-center' : 'px-3 py-2',
  );
  const content = (
    <>
      {active ? (
        <motion.span
          layoutId="restaurant-nav-active"
          className="absolute inset-0 rounded-lg bg-emerald-500/10"
          transition={{ type: 'spring', stiffness: 420, damping: 36 }}
          aria-hidden
        >
          <span className="absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full bg-[#059669]" />
        </motion.span>
      ) : null}
      <Icon
        className={cn(
          'relative size-[18px] shrink-0',
          active ? 'text-emerald-400' : 'text-slate-400 group-hover:text-slate-200',
        )}
        aria-hidden
      />
      {collapsed ? (
        <span className="sr-only">{item.label}</span>
      ) : (
        <>
          <span className={cn('relative flex-1 truncate', active && 'font-medium text-white')}>
            {item.label}
          </span>
          {!item.href ? (
            <span className="relative rounded-full bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
              Soon
            </span>
          ) : null}
        </>
      )}
      {collapsed ? <Tooltip label={item.href ? item.label : `${item.label} · Soon`} /> : null}
    </>
  );

  if (!item.href) {
    return (
      <span
        aria-disabled="true"
        title={collapsed ? undefined : 'Coming soon'}
        className={cn(base, 'cursor-not-allowed opacity-50')}
      >
        {content}
      </span>
    );
  }
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        base,
        'focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:outline-none',
        active ? 'text-white' : 'hover:bg-white/5 hover:text-white',
      )}
    >
      {content}
    </Link>
  );
}

/** Label shown beside an icon in the collapsed sidebar (on hover and keyboard focus). */
function Tooltip({ label }: { label: string }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none fixed z-50 ml-14 rounded-md bg-slate-800 px-2.5 py-1.5 text-xs font-medium whitespace-nowrap text-white opacity-0 shadow-lg ring-1 ring-white/10 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
    >
      {label}
    </span>
  );
}

/** Which restaurant and branch the person is working in. */
function ContextCard({ collapsed }: { collapsed: boolean }) {
  const profile = useProfile();
  const tenant = profile.activeTenant;
  const branches = profile.branches;
  const allAccess = profile.permissions.tenant.length > 0;
  const branchLabel =
    branches.length === 1
      ? branches[0]!.name
      : allAccess
        ? `All branches (${branches.length})`
        : `${branches.length} branches`;

  if (collapsed) {
    return (
      <div className="group relative mx-auto mt-3 flex size-11 items-center justify-center rounded-lg bg-white/5 text-sm font-semibold text-white">
        {(tenant?.name ?? 'R').charAt(0).toUpperCase()}
        <Tooltip label={`${tenant?.name ?? 'Restaurant'} · ${branchLabel}`} />
      </div>
    );
  }
  return (
    <div className="mx-3 mt-3 rounded-xl border border-white/5 bg-white/[0.03] p-3">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#059669]/20 text-sm font-semibold text-emerald-300">
          {(tenant?.name ?? 'R').charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-white">
            {tenant?.name ?? 'Restaurant'}
          </p>
          <p className="flex items-center gap-1 truncate text-xs text-slate-400">
            <MapPin className="size-3 shrink-0" aria-hidden />
            {branchLabel}
          </p>
        </div>
      </div>
    </div>
  );
}

function ProfileFooter({
  collapsed,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  onToggleCollapsed?: () => void;
}) {
  const profile = useProfile();
  const { leaving, leave } = useSignOut();
  const role = profile.roles[0] ? roleLabel(profile.roles[0]) : '';

  return (
    <div className="shrink-0 border-t border-white/5 p-3">
      <div className={cn('flex items-center gap-3', collapsed && 'flex-col')}>
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#059669] text-xs font-semibold text-white"
          aria-hidden
        >
          {initials(profile.user.fullName)}
        </span>
        {collapsed ? null : (
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-white">{profile.user.fullName}</p>
            <p className="truncate text-xs text-slate-400">{role}</p>
          </div>
        )}
        <button
          type="button"
          onClick={leave}
          disabled={leaving}
          aria-label="Sign out"
          className="group relative flex size-9 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/5 hover:text-red-400"
        >
          {leaving ? <Loader2 className="size-4 animate-spin" /> : <LogOut className="size-4" />}
          {collapsed ? <Tooltip label="Sign out" /> : null}
        </button>
      </div>
      {onToggleCollapsed ? (
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={cn(
            'mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-slate-500 transition-colors hover:bg-white/5 hover:text-slate-300',
            collapsed && 'justify-center px-0',
          )}
        >
          {collapsed ? (
            <ChevronsRight className="size-4" />
          ) : (
            <>
              <ChevronsLeft className="size-4" /> Collapse
            </>
          )}
        </button>
      ) : null}
    </div>
  );
}
