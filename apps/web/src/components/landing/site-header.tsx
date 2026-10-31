'use client';

import { buttonVariants } from '@foodstack/ui/components/button';
import { Logo } from '@foodstack/ui/components/logo';
import { cn } from '@foodstack/ui/lib/utils';
import {
  ArrowRight,
  BarChart3,
  BookOpen,
  Boxes,
  Building2,
  ChefHat,
  ChevronDown,
  Code,
  House,
  LayoutDashboard,
  LifeBuoy,
  Newspaper,
  QrCode,
  ReceiptText,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Tag,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { MobileMenu } from './mobile-menu';
import { ThemeToggle } from './theme-toggle';

interface MenuItem {
  label: string;
  description: string;
  href: string;
  icon: LucideIcon;
}

// TODO: point the Resources entries at real pages once they exist.
const menus: Record<'product' | 'features' | 'resources', MenuItem[]> = {
  product: [
    {
      label: 'Admin Dashboard',
      description: 'Menu, staff, branches and reports',
      href: '#product',
      icon: LayoutDashboard,
    },
    {
      label: 'POS Billing',
      description: 'Fast touch billing, even offline',
      href: '#product',
      icon: ReceiptText,
    },
    {
      label: 'Kitchen Display',
      description: 'Orders straight to each station',
      href: '#product',
      icon: ChefHat,
    },
    {
      label: 'QR Ordering',
      description: 'Guests order from their phone',
      href: '#product',
      icon: QrCode,
    },
    {
      label: 'Waiter App',
      description: 'Tableside orders and open tables',
      href: '#product',
      icon: Smartphone,
    },
  ],
  features: [
    {
      label: 'Multi-branch',
      description: 'Shared menus, per-branch pricing',
      href: '#features',
      icon: Building2,
    },
    {
      label: 'Offline POS',
      description: 'Keeps billing when the internet drops',
      href: '#features',
      icon: WifiOff,
    },
    {
      label: 'Inventory & recipes',
      description: 'Stock, transfers and dish costs',
      href: '#features',
      icon: Boxes,
    },
    {
      label: 'Reports',
      description: 'Sales and turnover across branches',
      href: '#features',
      icon: BarChart3,
    },
    {
      label: 'Roles & audit log',
      description: 'Right access, every action logged',
      href: '#features',
      icon: ShieldCheck,
    },
  ],
  resources: [
    { label: 'Documentation', description: 'Set up and run FoodStack', href: '#', icon: BookOpen },
    { label: 'Help center', description: 'Answers to common questions', href: '#', icon: LifeBuoy },
    { label: 'API reference', description: 'Build on the FoodStack API', href: '#', icon: Code },
    { label: 'Release notes', description: 'What changed and when', href: '#', icon: Newspaper },
  ],
};

type Section = 'home' | 'product' | 'features' | 'pricing';

// Page sections in scroll order, mapped to the nav item they light up.
const spy: { id: string; section: Section }[] = [
  { id: 'product', section: 'product' },
  { id: 'features', section: 'features' },
  { id: 'get-started', section: 'pricing' },
];

/** Tracks which page section is under the header, for the active nav highlight. */
function useActiveSection(): Section {
  const [active, setActive] = useState<Section>('home');
  useEffect(() => {
    const update = () => {
      let current: Section = 'home';
      for (const { id, section } of spy) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= 140) current = section;
      }
      setActive(current);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  return active;
}

const itemBase =
  'flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-sm font-medium transition-colors';
const itemIdle = 'text-foreground/80 hover:bg-muted hover:text-foreground';
const itemActive = 'bg-primary text-primary-foreground shadow-md shadow-primary/25';

function NavDropdown({
  label,
  items,
  active,
}: {
  label: string;
  items: MenuItem[];
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  // Hover opens on mouse; click/tap and keyboard toggle.
  const onEnter = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const onLeave = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  };

  return (
    <div ref={rootRef} className="relative" onPointerEnter={onEnter} onPointerLeave={onLeave}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={cn(itemBase, active ? itemActive : itemIdle)}
      >
        {label}
        <ChevronDown
          className={cn('size-3.5 transition-transform duration-200', open && 'rotate-180')}
        />
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            id={panelId}
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.16 }}
            // pt-3 bridges the gap so the pointer can travel from button to panel
            className="absolute top-full left-1/2 z-50 w-80 -translate-x-1/2 pt-3"
          >
            <ul className="rounded-xl bg-popover p-2 shadow-2xl shadow-slate-900/15 ring-1 ring-border">
              {items.map(({ label: itemLabel, description, href, icon: Icon }) => (
                <li key={itemLabel}>
                  <a
                    href={href}
                    onClick={() => setOpen(false)}
                    className="group flex items-start gap-3 rounded-lg p-2.5 transition-colors hover:bg-muted"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                      <Icon className="size-4" />
                    </span>
                    <span>
                      <span className="block text-sm font-semibold text-foreground">
                        {itemLabel}
                      </span>
                      <span className="block text-xs text-muted-foreground">{description}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** Floating glass header with dropdown menus and a scroll-aware active item. */
export function SiteHeader() {
  const active = useActiveSection();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className="fixed inset-x-0 top-0 z-40 px-3 pt-3 sm:px-6 sm:pt-4">
      <motion.div
        initial={{ opacity: 0, y: -16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className={cn(
          'relative mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 rounded-xl px-3 ring-1 backdrop-blur-xl transition-[background-color,box-shadow] duration-300 sm:px-4',
          scrolled
            ? 'bg-white/90 shadow-xl shadow-slate-900/10 ring-slate-900/5 dark:bg-slate-900/90 dark:ring-white/10'
            : 'bg-white/75 shadow-lg shadow-slate-900/5 ring-white/60 dark:bg-slate-900/70 dark:ring-white/10',
        )}
      >
        <Link href="/" aria-label="FoodStack home" className="shrink-0">
          <Logo className="font-display text-xl [&>span:first-child]:size-10" />
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-1 lg:flex">
          <a href="#" className={cn(itemBase, active === 'home' ? itemActive : itemIdle)}>
            <House className="size-4" />
            Home
          </a>
          <NavDropdown label="Product" items={menus.product} active={active === 'product'} />
          <NavDropdown label="Features" items={menus.features} active={active === 'features'} />
          <a
            href="#get-started"
            className={cn(itemBase, active === 'pricing' ? itemActive : itemIdle)}
          >
            Pricing
          </a>
          <NavDropdown label="Resources" items={menus.resources} active={false} />
        </nav>

        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link
            href="/login"
            className="hidden h-10 items-center rounded-lg bg-slate-900/5 px-4 text-sm font-semibold text-foreground transition-colors hover:bg-slate-900/10 sm:flex dark:bg-white/10 dark:hover:bg-white/15"
          >
            Sign in
          </Link>
          <Link
            href="/login"
            className={cn(
              buttonVariants(),
              'hidden h-10 rounded-lg px-4 font-semibold shadow-md shadow-primary/25 sm:inline-flex',
            )}
          >
            Get started <ArrowRight />
          </Link>
          <MobileMenu
            links={[
              { label: 'Home', href: '#', icon: <House className="size-4" /> },
              { label: 'Product', href: '#product', icon: <LayoutDashboard className="size-4" /> },
              { label: 'Features', href: '#features', icon: <Sparkles className="size-4" /> },
              { label: 'Pricing', href: '#get-started', icon: <Tag className="size-4" /> },
              { label: 'Resources', href: '#', icon: <BookOpen className="size-4" /> },
            ]}
          />
        </div>
      </motion.div>
    </header>
  );
}
