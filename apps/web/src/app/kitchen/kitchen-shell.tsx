'use client';

import { cn } from '@foodstack/ui/lib/utils';
import {
  BarChart3,
  ChefHat,
  ChevronDown,
  ClipboardList,
  LayoutGrid,
  MapPin,
  Menu,
  PanelLeftClose,
  Settings,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useState } from 'react';
import { AccountMenu } from '@/components/account-menu';
import { ThemeToggle } from '@/components/theme-toggle';
import { useProfile } from '@/components/auth/auth-provider';
import type { Connection } from './kitchen-feed';
import { ConnectionPill } from './status';

/** Only Kitchen Display has a route today; the rest render as "Soon", like the restaurant nav. */
const NAV = [
  { label: 'Kitchen Display', icon: ChefHat, href: '/kitchen' },
  { label: 'Orders', icon: ClipboardList },
  { label: 'Menu', icon: LayoutGrid },
  { label: 'Reports', icon: BarChart3 },
  { label: 'Settings', icon: Settings },
];

interface KitchenShellProps {
  branchId: string;
  onBranch: (id: string) => void;
  connection: Connection;
  muted: boolean;
  onMuted: (m: boolean) => void;
  children: ReactNode;
}

export function KitchenShell(p: KitchenShellProps) {
  const profile = useProfile();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const sidebar = (compact: boolean) => (
    <div className="flex h-full flex-col border-r border-slate-200 bg-white text-slate-700 dark:border-white/10 dark:bg-slate-900 dark:text-slate-300">
      <div
        className={cn(
          'flex h-14 items-center gap-2.5 border-b border-slate-200 px-5 dark:border-white/10',
          compact && 'justify-center px-0',
        )}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white">
          <ChefHat className="size-4" />
        </span>
        {!compact ? (
          <span className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-white">
            FoodStack
          </span>
        ) : null}
      </div>
      <nav aria-label="Kitchen" className="flex-1 space-y-0.5 px-3 pt-4">
        {!compact ? (
          <p className="px-2.5 pb-2 text-[11px] font-medium tracking-wider text-slate-400 uppercase dark:text-slate-500">
            Workspace
          </p>
        ) : null}
        {NAV.map(({ label, icon: Icon, href }) => {
          const active = href === '/kitchen';
          const body = (
            <>
              <Icon className="size-4 shrink-0" />
              {!compact ? <span className="flex-1 truncate">{label}</span> : null}
              {!compact && !href ? (
                <span className="rounded px-1.5 py-0.5 text-[10px] font-medium text-slate-400 ring-1 ring-slate-200 ring-inset dark:text-slate-500 dark:ring-white/10">
                  Soon
                </span>
              ) : null}
            </>
          );
          const cls = cn(
            'flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium transition-colors',
            compact && 'justify-center px-0',
            active
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
              : href
                ? 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/5 dark:hover:text-white'
                : 'cursor-default text-slate-400 dark:text-slate-500',
          );
          return href ? (
            <Link
              key={label}
              href={href}
              className={cls}
              aria-current={active ? 'page' : undefined}
              title={compact ? label : undefined}
            >
              {body}
            </Link>
          ) : (
            <span key={label} className={cls} aria-disabled title={`${label} — coming soon`}>
              {body}
            </span>
          );
        })}
      </nav>
      {!compact && profile.activeTenant ? (
        <div className="border-t border-slate-200 px-5 py-4 dark:border-white/10">
          <p className="truncate text-sm font-medium text-slate-900 dark:text-white">
            {profile.activeTenant.name}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">Kitchen Display</p>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="flex h-dvh bg-slate-50 dark:bg-slate-950">
      <aside
        className={cn(
          'hidden shrink-0 transition-[width] duration-300 lg:block',
          collapsed ? 'w-[4.5rem]' : 'w-60',
        )}
      >
        {sidebar(collapsed)}
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-slate-950/50"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative h-full w-64 shadow-2xl">
            {sidebar(false)}
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              aria-label="Close menu"
              className="absolute top-4 right-3 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10"
            >
              <X className="size-5" />
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 sm:px-6 dark:border-white/10 dark:bg-slate-900">
          <button
            type="button"
            onClick={() =>
              window.matchMedia('(min-width: 1024px)').matches
                ? setCollapsed((c) => !c)
                : setMobileOpen(true)
            }
            aria-label="Toggle sidebar"
            className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/10"
          >
            <Menu className="size-5 lg:hidden" />
            <PanelLeftClose
              className={cn(
                'hidden size-5 transition-transform lg:block',
                collapsed && 'rotate-180',
              )}
            />
          </button>

          {profile.branches.length > 0 ? (
            <label className="relative hidden items-center sm:flex">
              <MapPin
                className="pointer-events-none absolute left-3 size-4 text-slate-500"
                aria-hidden
              />
              <span className="sr-only">Branch</span>
              <select
                value={p.branchId}
                onChange={(e) => p.onBranch(e.target.value)}
                disabled={profile.branches.length < 2}
                className="h-9 appearance-none rounded-md border border-slate-200 bg-white pr-9 pl-9 text-sm font-medium text-slate-700 shadow-xs disabled:opacity-100 dark:border-white/10 dark:bg-white/5 dark:text-white"
              >
                {profile.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
              {profile.branches.length > 1 ? (
                <ChevronDown
                  className="pointer-events-none absolute right-3 size-4 text-slate-500"
                  aria-hidden
                />
              ) : null}
            </label>
          ) : null}

          <span className="hidden h-6 w-px bg-slate-200 md:block dark:bg-white/10" aria-hidden />
          <h1 className="hidden text-sm font-semibold text-slate-900 md:block dark:text-white">
            Kitchen Display
          </h1>
          <ConnectionPill connection={p.connection} />

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => p.onMuted(!p.muted)}
              aria-pressed={p.muted}
              aria-label={p.muted ? 'Unmute new-order sound' : 'Mute new-order sound'}
              title={p.muted ? 'New-order sound off' : 'New-order sound on'}
              className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/10"
            >
              {p.muted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
            </button>
            <ThemeToggle className="rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/10" />
            <span
              className="mx-1 hidden h-6 w-px bg-slate-200 sm:block dark:bg-white/10"
              aria-hidden
            />
            <AccountMenu />
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">{p.children}</main>
      </div>
    </div>
  );
}
