'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { Bell, ChevronDown, Loader2, LogOut, UserRound } from 'lucide-react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useAuth, useProfile } from '@/components/auth/auth-provider';
import { initials, roleLabel } from '@/lib/auth/roles';

/* Header widgets shared by the Super Admin and restaurant shells. */

/** Open/close state for a click-away dropdown (closes on outside click and Escape). */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return { open, setOpen, ref };
}

const popoverClass =
  'absolute right-0 top-full z-50 mt-2 rounded-[14px] border border-slate-200 bg-white p-2 shadow-xl dark:border-white/10 dark:bg-[#11201b]';

/** Bell with a dropdown. There is no notification feed yet, so it says so honestly. */
export function NotificationsButton() {
  const { open, setOpen, ref } = usePopover();
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Notifications"
        aria-expanded={open}
        className="flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <motion.span
          className="flex"
          whileHover={{ rotate: [0, -14, 12, -8, 0] }}
          transition={{ duration: 0.5 }}
        >
          <Bell className="size-5" />
        </motion.span>
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.18 }}
            className={cn(popoverClass, 'w-72 origin-top-right p-4')}
          >
            <p className="text-sm font-semibold">Notifications</p>
            <p className="mt-2 text-sm text-muted-foreground">You&apos;re all caught up.</p>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** Signs out and returns to the login page. */
export function useSignOut() {
  const { signOut } = useAuth();
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const leave = async () => {
    setLeaving(true);
    await signOut();
    router.replace('/login');
  };
  return { leaving, leave };
}

/** Avatar, name and role; opens a menu with the email and Sign out. */
export function UserMenu() {
  const profile = useProfile();
  const { open, setOpen, ref } = usePopover();
  const { leaving, leave } = useSignOut();
  const role = profile.roles[0] ? roleLabel(profile.roles[0]) : profile.user.email;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-3 rounded-full py-1 pr-2 pl-1 transition-colors hover:bg-muted"
      >
        <span className="flex size-10 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500 to-emerald-700 text-sm font-semibold text-white">
          {initials(profile.user.fullName)}
        </span>
        <span className="hidden text-left md:block">
          <span className="block text-sm leading-tight font-semibold">{profile.user.fullName}</span>
          <span className="block text-xs text-muted-foreground">{role}</span>
        </span>
        <ChevronDown
          className={cn(
            'hidden size-4 text-muted-foreground transition-transform duration-200 md:block',
            open && 'rotate-180',
          )}
        />
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.18 }}
            className={cn(popoverClass, 'w-60 origin-top-right')}
          >
            <div className="border-b border-slate-100 px-3 pt-1 pb-3 dark:border-white/10">
              <p className="truncate text-sm font-semibold">{profile.user.fullName}</p>
              <p className="truncate text-xs text-muted-foreground">{profile.user.email}</p>
            </div>
            {profile.audience === 'tenant' ? (
              <Link
                href="/restaurant/profile"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="mt-1 flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-sm hover:bg-muted"
              >
                <UserRound className="size-4" /> My profile &amp; subscription
              </Link>
            ) : null}
            <button
              type="button"
              role="menuitem"
              disabled={leaving}
              onClick={leave}
              className="mt-1 flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
            >
              {leaving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <LogOut className="size-4" />
              )}
              Sign out
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
