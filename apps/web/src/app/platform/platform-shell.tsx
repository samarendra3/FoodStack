'use client';

import { cn } from '@foodstack/ui/lib/utils';
import {
  FileClock,
  Inbox,
  LayoutGrid,
  Menu,
  Moon,
  Search,
  Settings,
  ShieldCheck,
  Store,
  Sun,
  UsersRound,
  X,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { BrandMark, BrandName } from '@/components/auth/auth-layout';
import { useAuth } from '@/components/auth/auth-provider';
import { NotificationsButton, UserMenu } from '@/components/shell/header-widgets';

const THEME_KEY = 'fs-app-theme';
const ease = [0.22, 1, 0.36, 1] as const;

/** Header search text, read by pages that can filter (the restaurant list). */
const SearchContext = createContext('');
export const usePlatformSearch = () => useContext(SearchContext);

type NavLink = { label: string; href?: string; icon: typeof LayoutGrid; badge?: number };

const MAIN_NAV: NavLink[] = [
  { label: 'Dashboard', href: '/platform/dashboard', icon: LayoutGrid },
  { label: 'Restaurants', href: '/platform/restaurants', icon: Store },
  { label: 'Requests', href: '/platform/requests', icon: Inbox },
  { label: 'Subscriptions', href: '/platform/subscriptions', icon: ShieldCheck },
];
// Platform administration.
const PLATFORM_NAV: NavLink[] = [
  { label: 'Users', href: '/platform/users', icon: UsersRound },
  { label: 'Settings', href: '/platform/settings', icon: Settings },
  { label: 'Audit Logs', href: '/platform/audit-logs', icon: FileClock },
];

/** Super Admin layout: green sidebar (drawer on small screens), header with search and account. */
export function PlatformShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [query, setQuery] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Saved theme for the signed-in area; removed again when leaving it (sign-in pages are light).
  useEffect(() => {
    try {
      if (localStorage.getItem(THEME_KEY) === 'dark')
        document.documentElement.classList.add('dark');
    } catch {
      // Storage blocked: stay light.
    }
    return () => document.documentElement.classList.remove('dark');
  }, []);

  // Ctrl/⌘ + K focuses search; Escape closes the drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <SearchContext.Provider value={query}>
      <MotionConfig reducedMotion="user">
        <div className="flex min-h-dvh bg-[#f6f9f8] text-foreground dark:bg-[#0b1411]">
          {/* Desktop sidebar */}
          <aside className="sticky top-0 hidden h-dvh w-[17rem] shrink-0 lg:block">
            <Sidebar pathname={pathname} layoutKey="desktop" />
          </aside>

          {/* Mobile drawer */}
          <AnimatePresence>
            {drawerOpen ? (
              <div className="fixed inset-0 z-40 lg:hidden">
                <motion.div
                  className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
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
                  <Sidebar
                    pathname={pathname}
                    onClose={() => setDrawerOpen(false)}
                    layoutKey="drawer"
                  />
                </motion.div>
              </div>
            ) : null}
          </AnimatePresence>

          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-30 flex flex-wrap items-center gap-x-3 gap-y-2 py-3 sm:h-[4.5rem] sm:flex-nowrap sm:py-0 border-b border-transparent bg-[#f6f9f8]/85 px-4 backdrop-blur-md sm:px-6 lg:px-8 dark:bg-[#0b1411]/85">
              <button
                type="button"
                onClick={() => setDrawerOpen(true)}
                aria-label="Open menu"
                className="flex size-10 items-center justify-center rounded-[10px] text-muted-foreground hover:bg-muted lg:hidden"
              >
                <Menu className="size-5" />
              </button>
              <label className="relative order-last flex w-full items-center sm:order-none sm:w-auto sm:max-w-xl sm:flex-1">
                <span className="sr-only">Search restaurants</span>
                <Search className="pointer-events-none absolute left-4 size-[18px] text-muted-foreground" />
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search restaurants…"
                  className="h-11 w-full rounded-[12px] border border-slate-200/80 bg-white pr-20 pl-11 text-sm shadow-sm outline-none placeholder:text-muted-foreground focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/15 dark:border-white/10 dark:bg-white/5"
                />
                <kbd className="pointer-events-none absolute right-3 hidden rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-muted-foreground sm:block dark:border-white/10 dark:bg-white/5">
                  Ctrl K
                </kbd>
              </label>
              <div className="ml-auto flex items-center gap-1 sm:gap-2">
                <ThemeButton />
                <NotificationsButton />
                <UserMenu />
              </div>
            </header>
            <main className="flex-1 px-4 pt-2 pb-10 sm:px-6 lg:px-8">{children}</main>
          </div>
        </div>
      </MotionConfig>
    </SearchContext.Provider>
  );
}

function Sidebar({
  pathname,
  onClose,
  layoutKey,
}: {
  pathname: string;
  onClose?: () => void;
  layoutKey: string;
}) {
  const { client } = useAuth();
  const pending = useQuery({
    queryKey: ['platform', 'access-requests', 'pending-count'],
    queryFn: () => client.request<{ pending: number }>('/platform/access-requests/pending-count'),
    refetchInterval: 60_000,
  });
  const mainNav = MAIN_NAV.map((item) =>
    item.href === '/platform/requests' ? { ...item, badge: pending.data?.pending } : item,
  );
  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[#063a2e] text-emerald-50/85 dark:bg-[#04211a]">
      {/* Soft curve decoration */}
      <svg
        aria-hidden
        viewBox="0 0 270 300"
        fill="none"
        className="pointer-events-none absolute inset-x-0 bottom-24 w-full opacity-60"
      >
        <motion.path
          d="M0 300 C 60 200, 160 120, 270 90 L270 300 Z"
          fill="#0b4d3d"
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, ease }}
        />
        <motion.path
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.6, delay: 0.3, ease }}
          d="M0 300 C 90 230, 180 180, 270 170"
          stroke="#10b981"
          strokeOpacity="0.35"
          strokeWidth="2"
        />
      </svg>

      <div className="relative flex h-[4.5rem] items-center justify-between px-6">
        <Link href="/platform/dashboard" className="flex items-center gap-3">
          <BrandMark className="size-10" />
          <BrandName className="text-2xl text-white" />
        </Link>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="flex size-9 items-center justify-center rounded-[10px] hover:bg-white/10"
          >
            <X className="size-5" />
          </button>
        ) : null}
      </div>

      <nav className="relative flex-1 space-y-1 overflow-y-auto px-4 pt-4">
        {mainNav.map((item, i) => (
          <NavItem
            key={item.label}
            item={item}
            index={i}
            layoutKey={layoutKey}
            active={item.href === pathname}
          />
        ))}
        <div className="mx-2 my-4 h-px bg-white/10" />
        <p className="px-3 pb-2 text-xs font-medium tracking-wider text-emerald-100/50 uppercase">
          Platform
        </p>
        {PLATFORM_NAV.map((item, i) => (
          <NavItem
            key={item.label}
            item={item}
            index={i + MAIN_NAV.length}
            layoutKey={layoutKey}
            active={false}
          />
        ))}
      </nav>

      <div className="relative px-4 pb-4">
        <p className="border-t border-white/10 px-2 pt-4 text-xs text-emerald-100/50">
          © {new Date().getFullYear()} FoodStack v1.0.0
        </p>
      </div>
    </div>
  );
}

function NavItem({
  item,
  active,
  index,
  layoutKey,
}: {
  item: NavLink;
  active: boolean;
  index: number;
  layoutKey: string;
}) {
  const Icon = item.icon;
  const body = (
    <>
      {active ? (
        <motion.span
          layoutId={`nav-active-${layoutKey}`}
          className="absolute inset-0 -z-10 rounded-[12px] bg-gradient-to-r from-emerald-500 to-emerald-600 shadow-lg shadow-emerald-950/30"
          transition={{ type: 'spring', stiffness: 420, damping: 34 }}
        />
      ) : null}
      <Icon className="size-5 shrink-0 transition-transform duration-200 group-hover:scale-110" />
      <span className="flex-1">{item.label}</span>
      {item.badge ? (
        <motion.span
          key={item.badge}
          initial={{ scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 500, damping: 20 }}
          className="min-w-5 rounded-full bg-amber-400 px-1.5 py-0.5 text-center text-[11px] leading-none font-bold text-amber-950"
          aria-label={`${item.badge} waiting`}
        >
          {item.badge > 99 ? '99+' : item.badge}
        </motion.span>
      ) : null}
      {!item.href ? (
        <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium text-emerald-100/60">
          Soon
        </span>
      ) : null}
    </>
  );
  const base =
    'group relative isolate flex items-center gap-3 rounded-[12px] px-3.5 py-2.5 text-[15px] transition-colors';
  return (
    <motion.div
      initial={{ opacity: 0, x: -16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.45, delay: 0.08 + index * 0.05, ease }}
    >
      {item.href ? (
        <Link
          href={item.href}
          aria-current={active ? 'page' : undefined}
          className={cn(
            base,
            active ? 'font-medium text-white' : 'hover:bg-white/10 hover:text-white',
          )}
        >
          {body}
        </Link>
      ) : (
        <span aria-disabled className={cn(base, 'cursor-not-allowed opacity-60')}>
          {body}
        </span>
      )}
    </motion.div>
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
      className="group flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <Moon className="size-5 transition-transform duration-500 group-hover:-rotate-12 dark:hidden" />
      <Sun className="hidden size-5 transition-transform duration-500 group-hover:rotate-90 dark:block" />
    </button>
  );
}
