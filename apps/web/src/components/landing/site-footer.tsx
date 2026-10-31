import { buttonVariants } from '@foodstack/ui/components/button';
import { Logo } from '@foodstack/ui/components/logo';
import { cn } from '@foodstack/ui/lib/utils';
import {
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Building2,
  ShieldCheck,
  WifiOff,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { Reveal, Stagger, StaggerItem } from './motion';
import { LinkedInIcon, XIcon, YouTubeIcon } from './social-icons';

// TODO: point the '#' links (resources, company, legal, socials) at real pages once they exist.
const columns = [
  {
    title: 'Product',
    links: [
      { label: 'Admin Dashboard', href: '#product' },
      { label: 'POS Billing', href: '#product' },
      { label: 'Kitchen Display', href: '#product' },
      { label: 'QR Ordering', href: '#product' },
      { label: 'Waiter App', href: '#product' },
    ],
  },
  {
    title: 'Features',
    links: [
      { label: 'Multi-branch', href: '#features' },
      { label: 'Offline POS', href: '#features' },
      { label: 'Inventory & recipes', href: '#features' },
      { label: 'Reports', href: '#features' },
      { label: 'Roles & audit log', href: '#features' },
    ],
  },
  {
    title: 'Resources',
    links: [
      { label: 'Documentation', href: '#' },
      { label: 'Help center', href: '#' },
      { label: 'API reference', href: '#' },
      { label: 'Release notes', href: '#' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'About', href: '#' },
      { label: 'Pricing', href: '#get-started' },
      { label: 'Careers', href: '#' },
      { label: 'Contact', href: '#' },
    ],
  },
];

const trust = [
  { icon: ShieldCheck, label: 'Role-based access' },
  { icon: WifiOff, label: 'Works offline' },
  { icon: Building2, label: 'Multi-branch ready' },
  { icon: Zap, label: 'Real-time kitchen sync' },
];

const socials = [
  { label: 'YouTube', icon: YouTubeIcon },
  { label: 'LinkedIn', icon: LinkedInIcon },
  { label: 'X', icon: XIcon },
];

const legal = ['Privacy', 'Terms', 'Cookies'];

export function SiteFooter() {
  return (
    <footer className="relative isolate overflow-hidden bg-slate-950 text-slate-400">
      {/* Glow + grid backdrop */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-[linear-gradient(to_right,rgb(255_255_255/0.03)_1px,transparent_1px),linear-gradient(to_bottom,rgb(255_255_255/0.03)_1px,transparent_1px)] [mask-image:linear-gradient(to_bottom,black,transparent_70%)] bg-[size:48px_48px]"
      />
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400/50 to-transparent"
      />

      <div className="mx-auto max-w-7xl px-4 pt-20 sm:px-6">
        <div className="grid gap-14 lg:grid-cols-[1.3fr_2fr]">
          {/* Brand */}
          <Reveal>
            <Logo inverted className="font-display text-xl [&>span:first-child]:size-10" />
            <p className="mt-5 max-w-sm leading-relaxed">
              One platform for billing, orders, kitchen and back office, so every branch runs on the
              same menu and the same numbers.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/login"
                className={cn(
                  buttonVariants(),
                  'h-10 rounded-lg bg-emerald-500 px-5 font-semibold text-white hover:bg-emerald-400',
                )}
              >
                Get started <ArrowRight />
              </Link>
              <Link
                href="/login"
                className={cn(
                  buttonVariants({ variant: 'ghost' }),
                  'h-10 rounded-lg px-5 font-semibold text-white ring-1 ring-white/15 hover:bg-white/10',
                )}
              >
                Sign in
              </Link>
            </div>
            <div className="mt-10 flex gap-2">
              {socials.map(({ label, icon: Icon }) => (
                <a
                  key={label}
                  href="#"
                  aria-label={label}
                  className="flex size-10 items-center justify-center rounded-xl bg-white/5 text-slate-300 ring-1 ring-white/10 transition-all hover:-translate-y-0.5 hover:bg-emerald-500 hover:text-white hover:ring-emerald-400"
                >
                  <Icon className="size-4" />
                </a>
              ))}
            </div>
          </Reveal>

          {/* Link columns */}
          <Stagger gap={0.08} className="grid grid-cols-2 gap-10 sm:grid-cols-4">
            {columns.map((column) => (
              <StaggerItem key={column.title}>
                <h3 className="text-sm font-semibold text-white">{column.title}</h3>
                <ul className="mt-5 space-y-3.5 text-sm">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <a
                        href={link.href}
                        className="group inline-flex items-center gap-1 transition-colors hover:text-white"
                      >
                        {link.label}
                        <ArrowUpRight className="size-3.5 -translate-x-1 opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
                      </a>
                    </li>
                  ))}
                </ul>
              </StaggerItem>
            ))}
          </Stagger>
        </div>

        {/* Trust strip */}
        <Stagger
          as="ul"
          gap={0.08}
          className="mt-16 grid grid-cols-2 gap-3 border-y border-white/10 py-6 md:grid-cols-4"
        >
          {trust.map(({ icon: Icon, label }) => (
            <StaggerItem
              as="li"
              key={label}
              className="flex items-center gap-3 text-sm font-medium text-slate-300"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-400/20">
                <Icon className="size-4" />
              </span>
              {label}
            </StaggerItem>
          ))}
        </Stagger>

        {/* Bottom bar */}
        <div className="flex flex-col items-center justify-between gap-4 py-8 text-sm sm:flex-row">
          <p>© {new Date().getFullYear()} FoodStack. All rights reserved.</p>
          <div className="flex items-center gap-6">
            {legal.map((item) => (
              <a key={item} href="#" className="transition-colors hover:text-white">
                {item}
              </a>
            ))}
            <a
              href="#"
              aria-label="Back to top"
              className="flex size-9 items-center justify-center rounded-full bg-white/5 text-slate-300 ring-1 ring-white/10 transition-colors hover:bg-emerald-500 hover:text-white"
            >
              <ArrowUp className="size-4" />
            </a>
          </div>
        </div>
      </div>

      {/* Oversized wordmark */}
      <p
        aria-hidden
        className="font-display pointer-events-none -mb-[0.22em] bg-gradient-to-b from-white/[0.09] to-transparent bg-clip-text text-center text-[clamp(4rem,17vw,15rem)] leading-none font-extrabold tracking-tighter text-transparent select-none"
      >
        FoodStack
      </p>
    </footer>
  );
}
