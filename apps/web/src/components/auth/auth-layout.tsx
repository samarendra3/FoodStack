import { Logo } from '@foodstack/ui/components/logo';
import { Building2, ChefHat, ShieldCheck, Store } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

const HIGHLIGHTS = [
  {
    icon: Building2,
    title: 'Every restaurant, one account',
    text: 'Branches, floors, tables and menus kept separate and secure.',
  },
  {
    icon: Store,
    title: 'The right screen for each role',
    text: 'Owners land on the dashboard, cashiers on the POS, cooks on the kitchen display.',
  },
  {
    icon: ShieldCheck,
    title: 'Secure by default',
    text: 'Encrypted sessions, account lockout and two-step verification for administrators.',
  },
];

/** Split layout for sign-in pages: brand panel on large screens, form column everywhere. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="relative hidden overflow-hidden bg-sidebar text-sidebar-foreground lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-40 -left-40 size-[32rem] rounded-full bg-primary/25 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -right-32 -bottom-48 size-[28rem] rounded-full bg-emerald-400/10 blur-3xl"
        />
        <Link href="/" className="relative w-fit">
          <Logo inverted />
        </Link>
        <div className="relative max-w-md space-y-10">
          <div className="space-y-4">
            <p className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-emerald-300">
              <ChefHat className="size-3.5" aria-hidden />
              Restaurant management &amp; POS
            </p>
            <h2 className="text-3xl leading-tight font-semibold tracking-tight text-white xl:text-4xl">
              Run every restaurant, branch and table from one place.
            </h2>
          </div>
          <ul className="space-y-6">
            {HIGHLIGHTS.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white/5 text-emerald-300 ring-1 ring-white/10">
                  <Icon className="size-5" aria-hidden />
                </span>
                <div className="space-y-1">
                  <p className="font-medium text-white">{title}</p>
                  <p className="text-sm text-slate-400">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-slate-500">
          © {new Date().getFullYear()} FoodStack. All rights reserved.
        </p>
      </aside>

      <main className="flex flex-col bg-background">
        <div className="flex h-16 items-center px-4 sm:px-8 lg:hidden">
          <Link href="/">
            <Logo />
          </Link>
        </div>
        <div className="flex flex-1 items-center justify-center px-4 pt-4 pb-12 sm:px-8 lg:py-12">
          <div className="w-full max-w-[25rem]">{children}</div>
        </div>
      </main>
    </div>
  );
}

export function AuthHeading({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="mb-8 space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-[1.75rem]">{title}</h1>
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
    </div>
  );
}
