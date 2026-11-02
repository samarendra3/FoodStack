'use client';

import { buttonVariants } from '@foodstack/ui/components/button';
import { cn } from '@foodstack/ui/lib/utils';
import { ArrowRight, Menu, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface MobileMenuLink {
  label: string;
  href: string;
  icon: ReactNode;
}

/** Hamburger menu for screens below `lg`, where the inline header nav is hidden. */
export function MobileMenu({ links }: { links: MobileMenuLink[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    // Close if the viewport grows past the breakpoint while the menu is open.
    const desktop = window.matchMedia('(min-width: 1024px)');
    const onResize = () => desktop.matches && setOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    desktop.addEventListener('change', onResize);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      desktop.removeEventListener('change', onResize);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="lg:hidden">
      <button
        type="button"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        aria-controls="mobile-menu"
        onClick={() => setOpen((v) => !v)}
        className="flex size-10 items-center justify-center rounded-lg text-foreground ring-1 ring-border transition-colors hover:bg-muted"
      >
        {open ? <X className="size-5" /> : <Menu className="size-5" />}
      </button>

      <AnimatePresence>
        {open ? (
          <motion.nav
            id="mobile-menu"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
            className="absolute inset-x-0 top-full mt-2 rounded-xl bg-background px-3 pt-2 pb-4 shadow-2xl shadow-slate-900/15 ring-1 ring-border"
          >
            <ul className="grid gap-1 sm:grid-cols-2">
              {links.map((link) => (
                <li key={link.label}>
                  <a
                    href={link.href}
                    onClick={() => setOpen(false)}
                    className="flex items-center gap-3 rounded-lg px-3 py-3 text-base font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    <span className="flex size-9 items-center justify-center rounded-lg bg-accent text-primary">
                      {link.icon}
                    </span>
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
            {/* Header buttons are hidden below sm, so they live here instead. */}
            <div className="mt-4 grid grid-cols-2 gap-3 sm:hidden">
              <Link
                href="/login"
                onClick={() => setOpen(false)}
                className={cn(
                  buttonVariants({ variant: 'outline', size: 'lg' }),
                  'rounded-lg font-semibold',
                )}
              >
                Sign in
              </Link>
              <Link
                href="/login"
                onClick={() => setOpen(false)}
                className={cn(buttonVariants({ size: 'lg' }), 'rounded-lg font-semibold')}
              >
                Get started <ArrowRight />
              </Link>
            </div>
          </motion.nav>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
