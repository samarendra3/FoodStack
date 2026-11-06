'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronsUpDown,
  CircleHelp,
  Loader2,
  LogOut,
  MapPin,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings2,
  Sparkles,
  Sun,
  UserRound,
  X,
} from 'lucide-react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { BrandMark } from '@/components/auth/auth-layout';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import {
  NotificationsButton,
  UserMenu,
  usePopover,
  useSignOut,
} from '@/components/shell/header-widgets';
import { OrderUsageBanner } from '@/components/subscription/order-usage-banner';
import { TrialReminderBanner } from '@/components/subscription/subscription-gate';
import { hasPermissionAnywhere } from '@/lib/auth/access';
import { initials, roleLabel } from '@/lib/auth/roles';
import { isActive, liveItemsFor, type NavItem, navFor, upcomingFor } from './nav';

const THEME_KEY = 'fs-app-theme';
const COLLAPSED_KEY = 'fs-restaurant-sidebar-collapsed';

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
    // Storage blocked (private mode): the choice lasts for this visit.
  }
}

/** Live counts for nav badges (real data only; absent when the user cannot see it). */
function useBadges(): Partial<Record<NonNullable<NavItem['badge']>, number>> {
  const { client } = useAuth();
  const profile = useProfile();
  const team = useQuery({
    queryKey: ['restaurant', 'team', profile.activeTenant?.id],
    queryFn: () => client.request<{ members: { status: string }[] }>('/team'),
    enabled: hasPermissionAnywhere(profile, 'member:read'),
    staleTime: 60_000,
  });
  const invited = team.data?.members.filter((m) => m.status === 'invited').length;
  return invited ? { pendingInvites: invited } : {};
}

/** Restaurant workspace layout: navy sidebar (drawer on small screens) and a light header. */
export function RestaurantShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // Saved theme and sidebar state (read after mount so server and client render the same).
  useEffect(() => {
    try {
      if (localStorage.getItem(THEME_KEY) === 'dark') {
        document.documentElement.classList.add('dark');
      }
    } catch {
      // Storage blocked: stay light.
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from storage
    setCollapsed(readStorage(COLLAPSED_KEY, false));
    return () => document.documentElement.classList.remove('dark');
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

  const sidebar = { pathname };

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex min-h-dvh bg-[#F8FAFC] text-[#0F172A] dark:bg-[#0B1120] dark:text-slate-100">
        <motion.aside
          initial={false}
          animate={{ width: collapsed ? 76 : 260 }}
          transition={{ type: 'spring', stiffness: 380, damping: 38 }}
          className="sticky top-0 hidden h-dvh shrink-0 lg:block"
        >
          <Sidebar {...sidebar} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
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
                className="absolute inset-y-0 left-0 w-[260px] max-w-[85vw] shadow-2xl"
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={{ type: 'spring', stiffness: 380, damping: 36 }}
                onClickCapture={(e) => {
                  if ((e.target as HTMLElement).closest('a')) setDrawerOpen(false);
                }}
              >
                <Sidebar {...sidebar} collapsed={false} onClose={() => setDrawerOpen(false)} />
              </motion.div>
            </div>
          ) : null}
        </AnimatePresence>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 bg-white px-4 py-3 sm:h-16 sm:flex-nowrap sm:px-6 sm:py-0 dark:border-white/[0.06] dark:bg-[#0F172A]">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
              className="flex size-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 lg:hidden dark:hover:bg-white/5"
            >
              <Menu className="size-5" />
            </button>
            <CommandSearch />
            <div className="ml-auto flex items-center gap-0.5 sm:gap-1.5">
              <ThemeButton />
              <NotificationsButton />
              <span
                className="mx-1.5 hidden h-6 w-px bg-slate-200 sm:block dark:bg-white/10"
                aria-hidden
              />
              <UserMenu />
            </div>
          </header>
          <TrialReminderBanner />
          <OrderUsageBanner />
          <main className="min-w-0 flex-1 px-4 py-5 sm:px-6">
            <motion.div
              key={pathname}
              className="fs-stagger"
              initial={{ opacity: 0, y: 10, filter: 'blur(6px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)', transitionEnd: { filter: 'none' } }}
              transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            >
              {children}
            </motion.div>
          </main>
        </div>
      </div>
    </MotionConfig>
  );
}

function Sidebar({
  pathname,
  collapsed,
  onToggleCollapsed,
  onClose,
}: {
  pathname: string;
  collapsed: boolean;
  onToggleCollapsed?: () => void;
  onClose?: () => void;
}) {
  const profile = useProfile();
  const groups = navFor(profile);
  const upcoming = upcomingFor(profile).length;
  const badges = useBadges();
  const navRef = useRef<HTMLElement>(null);

  // Arrow keys move between items; Home/End jump to the ends.
  const onNavKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = [...(navRef.current?.querySelectorAll<HTMLElement>('a') ?? [])];
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : e.key === 'ArrowDown'
            ? Math.min(items.length - 1, at + 1)
            : Math.max(0, at - 1);
    items[next]?.focus();
  };

  return (
    <div className="flex h-full flex-col border-r border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#0F172A] text-slate-600 dark:text-slate-300">
      {/* Brand */}
      <div
        className={cn(
          'flex h-16 shrink-0 items-center border-b border-slate-200 dark:border-white/[0.06]',
          collapsed ? 'justify-center' : 'justify-between px-4',
        )}
      >
        <Link
          href="/restaurant/dashboard"
          className="flex items-center gap-2.5 rounded-md focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:outline-none"
          aria-label="FoodStack dashboard"
        >
          <BrandMark className="size-8 rounded-lg shadow-none" />
          {collapsed ? null : (
            <span className="text-[17px] font-semibold tracking-tight text-slate-900 dark:text-white">
              FoodStack
            </span>
          )}
        </Link>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="flex size-8 items-center justify-center rounded-md hover:bg-slate-100 dark:hover:bg-white/[0.06]"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>

      <Workspace collapsed={collapsed} />

      <nav
        ref={navRef}
        aria-label="Restaurant"
        onKeyDown={onNavKey}
        className="mt-2 flex-1 space-y-5 overflow-x-hidden overflow-y-auto px-3 py-2 [scrollbar-width:none]"
      >
        {groups.map((group) => (
          <div key={group.id}>
            {collapsed ? (
              <div
                className="mx-auto mb-2 h-px w-6 bg-slate-200 dark:bg-white/[0.08]"
                aria-hidden
              />
            ) : (
              <p className="mb-1 px-2.5 text-[11px] font-medium text-slate-500">{group.title}</p>
            )}
            <ul className="space-y-px">
              {group.items.map((item) => (
                <li key={item.id}>
                  <Item
                    item={item}
                    active={isActive(item, pathname)}
                    collapsed={collapsed}
                    badge={item.badge ? badges[item.badge] : undefined}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
        {!collapsed && upcoming > 0 ? (
          <p className="flex items-center gap-2 px-2.5 pt-1 text-[12px] text-slate-500">
            <Sparkles className="size-3.5 shrink-0" aria-hidden />
            {upcoming} more modules coming soon
          </p>
        ) : null}
      </nav>

      <div className="shrink-0 space-y-1 border-t border-slate-200 p-3 dark:border-white/[0.06]">
        {onToggleCollapsed ? (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={cn(
              'group relative flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] text-slate-500 transition-colors hover:bg-slate-100 dark:hover:bg-white/[0.04] hover:text-slate-700 dark:hover:text-slate-300',
              collapsed && 'justify-center px-0',
            )}
          >
            {collapsed ? (
              <>
                <PanelLeftOpen className="size-4" aria-hidden />
                <Tooltip label="Expand sidebar" />
              </>
            ) : (
              <>
                <PanelLeftClose className="size-4" aria-hidden />
                Collapse
              </>
            )}
          </button>
        ) : null}
        <AccountRow collapsed={collapsed} />
      </div>
    </div>
  );
}

function Item({
  item,
  active,
  collapsed,
  badge,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  badge?: number;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href!}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative isolate flex h-9 items-center gap-2.5 rounded-md text-sm transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:outline-none',
        collapsed ? 'mx-auto w-10 justify-center' : 'px-2.5',
        active
          ? 'font-medium text-emerald-700 dark:text-white'
          : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/[0.04] hover:text-slate-900 dark:hover:text-slate-100',
      )}
    >
      {active ? (
        // One shared element glides between items as the route changes.
        <motion.span
          layoutId="restaurant-nav-active"
          aria-hidden
          className="absolute inset-0 -z-10 rounded-md bg-emerald-50 ring-1 ring-emerald-100 dark:bg-white/[0.08] dark:ring-white/[0.06]"
          transition={{ type: 'spring', stiffness: 500, damping: 38 }}
        />
      ) : null}
      <Icon
        className={cn(
          'size-[18px] shrink-0 transition-transform duration-200 group-hover:scale-110',
          active
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-slate-400 group-hover:text-slate-600 dark:text-slate-500 dark:group-hover:text-slate-300',
        )}
        strokeWidth={active ? 2.2 : 1.9}
        aria-hidden
      />
      {collapsed ? (
        <>
          <span className="sr-only">{item.label}</span>
          {badge ? (
            <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-emerald-400" />
          ) : null}
          <Tooltip label={item.label} />
        </>
      ) : (
        <>
          <span className="flex-1 truncate">{item.label}</span>
          {badge ? (
            <span
              className="rounded bg-emerald-500/15 px-1.5 text-[11px] leading-5 font-medium text-emerald-700 dark:text-emerald-300 tabular-nums"
              aria-label={`${badge} pending`}
            >
              {badge > 99 ? '99+' : badge}
            </span>
          ) : null}
        </>
      )}
    </Link>
  );
}

/** Label beside an icon in the collapsed sidebar (hover and keyboard focus). */
function Tooltip({ label }: { label: string }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none fixed z-50 ml-14 rounded-md bg-slate-800 px-2 py-1 text-xs font-medium whitespace-nowrap text-white opacity-0 shadow-lg ring-1 ring-white/10 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
    >
      {label}
    </span>
  );
}

/** Restaurant in context; the menu lists the branches this person works in. */
function Workspace({ collapsed }: { collapsed: boolean }) {
  const profile = useProfile();
  const { open, setOpen, ref } = usePopover();
  const branches = profile.branches;
  const name = profile.activeTenant?.name ?? 'Restaurant';
  const subtitle =
    branches.length === 1
      ? branches[0]!.name
      : profile.permissions.tenant.length > 0
        ? `All branches · ${branches.length}`
        : `${branches.length} branches`;
  const mark = (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-emerald-500/15 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
      {name.charAt(0).toUpperCase()}
    </span>
  );

  if (collapsed) {
    return (
      <div className="group relative mx-auto flex size-10 items-center justify-center">
        {mark}
        <Tooltip label={`${name} · ${subtitle}`} />
      </div>
    );
  }
  return (
    <div ref={ref} className="relative px-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-slate-100 dark:hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:outline-none"
      >
        {mark}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-slate-900 dark:text-white">
            {name}
          </span>
          <span className="block truncate text-xs text-slate-500">{subtitle}</span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-slate-500" aria-hidden />
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className="absolute inset-x-3 top-full z-20 mt-1 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-[#1E293B] p-1 shadow-xl"
          >
            <p className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-slate-500">Branches</p>
            {branches.map((b) => (
              <div key={b.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">
                <MapPin className="size-3.5 text-slate-500" aria-hidden />
                <span className="truncate text-slate-700 dark:text-slate-200">{b.name}</span>
                <span className="ml-auto text-[11px] text-slate-500">{b.code}</span>
              </div>
            ))}
            <div className="my-1 h-px bg-slate-200 dark:bg-white/[0.06]" />
            <Link
              href="/restaurant/branches"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.06]"
            >
              <Settings2 className="size-3.5" aria-hidden />
              Manage branches
            </Link>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** Bottom account row: opens a small menu with profile, help and log out. */
function AccountRow({ collapsed }: { collapsed: boolean }) {
  const profile = useProfile();
  const { leaving, leave } = useSignOut();
  const { open, setOpen, ref } = usePopover();
  const [showHelp, setShowHelp] = useState(false);
  const role = profile.roles[0] ? roleLabel(profile.roles[0]) : '';
  const menuItem =
    'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.06]';

  return (
    <div ref={ref} className="relative">
      <AnimatePresence>
        {open ? (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.12 }}
            className={cn(
              'absolute bottom-full z-30 mb-1 w-56 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-[#1E293B] p-1 shadow-xl',
              collapsed ? 'left-0' : 'inset-x-0 w-auto',
            )}
          >
            <div className="px-2 py-1.5">
              <p className="truncate text-sm font-medium text-slate-900 dark:text-white">
                {profile.user.fullName}
              </p>
              <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                {profile.user.email}
              </p>
            </div>
            <div className="my-1 h-px bg-slate-200 dark:bg-white/[0.06]" />
            <span
              role="menuitem"
              aria-disabled="true"
              className={cn(menuItem, 'cursor-not-allowed text-slate-500 hover:bg-transparent')}
            >
              <UserRound className="size-4" aria-hidden /> My Profile
              <span className="ml-auto text-[10px]">Soon</span>
            </span>
            <button
              type="button"
              role="menuitem"
              onClick={() => setShowHelp((s) => !s)}
              className={menuItem}
            >
              <CircleHelp className="size-4" aria-hidden /> Help &amp; Support
            </button>
            {showHelp ? (
              <p className="px-2 pb-1.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                Press{' '}
                <kbd className="rounded border border-slate-300 dark:border-white/15 px-1">
                  Ctrl K
                </kbd>{' '}
                to jump to any page. For account questions, contact your restaurant owner.
              </p>
            ) : null}
            <div className="my-1 h-px bg-slate-200 dark:bg-white/[0.06]" />
            <button
              type="button"
              role="menuitem"
              onClick={leave}
              disabled={leaving}
              className={cn(menuItem, 'hover:bg-red-500/10 hover:text-red-300')}
            >
              {leaving ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <LogOut className="size-4" aria-hidden />
              )}
              Log out
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Account menu"
        className={cn(
          'group relative flex w-full items-center gap-2.5 rounded-md text-left transition-colors hover:bg-slate-100 dark:hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:outline-none',
          collapsed ? 'justify-center py-1.5' : 'px-2 py-1.5',
        )}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-xs font-semibold text-white">
          {initials(profile.user.fullName)}
        </span>
        {collapsed ? (
          <Tooltip label={profile.user.fullName} />
        ) : (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-slate-900 dark:text-white">
                {profile.user.fullName}
              </span>
              <span className="block truncate text-xs text-slate-500">{role}</span>
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-slate-500" aria-hidden />
          </>
        )}
      </button>
    </div>
  );
}

/** Ctrl/⌘+K search over pages this person can open. */
function CommandSearch() {
  const profile = useProfile();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);

  const q = query.trim().toLowerCase();
  const results = liveItemsFor(profile)
    .filter((t) => !q || t.label.toLowerCase().includes(q) || t.group.toLowerCase().includes(q))
    .slice(0, 8);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const go = (href: string) => {
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
    router.push(href);
  };

  return (
    <div className="relative order-last w-full sm:order-none sm:w-auto sm:max-w-md sm:flex-1">
      <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-slate-400" />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={open}
        aria-controls="restaurant-search-results"
        aria-label="Search pages"
        placeholder="Search pages…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setCursor(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setCursor((c) => Math.min(c + 1, results.length - 1));
          if (e.key === 'ArrowUp') setCursor((c) => Math.max(c - 1, 0));
          if (e.key === 'Enter' && results[cursor]) go(results[cursor].href);
          if (e.key === 'Escape') inputRef.current?.blur();
        }}
        className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 pr-16 pl-10 text-sm outline-none placeholder:text-slate-400 focus:border-[#059669] focus:bg-white focus:ring-4 focus:ring-[#059669]/15 dark:border-white/10 dark:bg-white/5"
      />
      <kbd className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 rounded border border-[#E2E8F0] bg-white px-1.5 py-0.5 text-[11px] text-slate-500 sm:block dark:border-white/10 dark:bg-white/5">
        Ctrl K
      </kbd>
      <AnimatePresence>
        {open && results.length > 0 ? (
          <motion.ul
            id="restaurant-search-results"
            role="listbox"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className="absolute inset-x-0 top-full z-50 mt-2 overflow-hidden rounded-xl border border-[#E2E8F0] bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-[#1E293B]"
          >
            {results.map((r, i) => (
              <li key={r.id} role="option" aria-selected={i === cursor}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => go(r.href)}
                  onMouseEnter={() => setCursor(i)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm',
                    i === cursor && 'bg-emerald-50 dark:bg-emerald-500/10',
                  )}
                >
                  <r.icon className="size-4 text-[#059669]" aria-hidden />
                  <span className="flex-1">{r.label}</span>
                  <span className="text-xs text-slate-400">{r.group}</span>
                </button>
              </li>
            ))}
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ThemeButton() {
  const toggle = () => {
    const dark = document.documentElement.classList.toggle('dark');
    try {
      localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
    } catch {
      // Storage blocked: the change still applies for this visit.
    }
  };
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle dark mode"
      className="flex size-9 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-white"
    >
      <Moon className="size-[18px] dark:hidden" />
      <Sun className="hidden size-[18px] dark:block" />
    </button>
  );
}
