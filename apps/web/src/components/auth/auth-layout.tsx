import { cn } from '@foodstack/ui/lib/utils';
import { ShieldCheck, Star, Store, TrendingUp, Utensils, UtensilsCrossed } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import loginBg from '../../../public/images/login-bg.png';

const HIGHLIGHTS = [
  { icon: Store, title: 'Multi-Restaurant Support', text: 'Manage multiple restaurants easily' },
  { icon: TrendingUp, title: 'Real-Time Operations', text: 'Track orders, sales and performance' },
  { icon: ShieldCheck, title: 'Secure & Reliable', text: 'Enterprise-grade security' },
];

const AVATARS = [
  { initials: 'RK', className: 'bg-amber-200 text-amber-900' },
  { initials: 'AS', className: 'bg-emerald-200 text-emerald-900' },
  { initials: 'MP', className: 'bg-sky-200 text-sky-900' },
  { initials: 'VN', className: 'bg-rose-200 text-rose-900' },
];

/** Brand mark from the sign-in design: rounded green tile with a fork and knife. */
export function BrandMark({ size = 'md', className }: { size?: 'md' | 'lg'; className?: string }) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center bg-gradient-to-br from-emerald-500 to-emerald-700 text-white shadow-lg shadow-emerald-900/20',
        size === 'lg'
          ? 'size-16 rounded-2xl'
          : 'size-10 rounded-xl [@media(min-height:860px)]:size-12',
        className,
      )}
    >
      <Utensils aria-hidden className="size-[55%]" strokeWidth={2.4} />
    </span>
  );
}

export function BrandName({ className }: { className?: string }) {
  return (
    <span className={cn('font-bold tracking-tight', className)}>
      Food<span className="text-emerald-500">Stack</span>
    </span>
  );
}

/** Sign-in layout: photo brand panel with a curved green edge, form card on a light canvas. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex h-dvh overflow-hidden bg-[#f3f8f6]">
      {/* Left brand panel (large screens). */}
      <aside className="relative hidden w-[56%] shrink-0 overflow-hidden text-white lg:block">
        <Image
          src={loginBg}
          alt=""
          priority
          placeholder="blur"
          sizes="56vw"
          className="object-cover object-[38%_center]"
          fill
        />
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-r from-[#032a22] via-[#063a2e]/70 via-45% to-transparent to-75%"
        />
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-t from-[#032a22]/90 via-transparent to-[#032a22]/40"
        />

        <div className="relative flex h-full flex-col justify-between px-12 py-6 [@media(min-height:860px)]:pt-14 [@media(min-height:860px)]:pb-8 xl:px-16">
          <Link href="/" className="flex w-fit items-center gap-4">
            <BrandMark size="lg" />
            <span>
              <BrandName className="block text-4xl text-white" />
              <span className="block text-sm text-white/85">Restaurant Management Platform</span>
            </span>
          </Link>

          <div className="max-w-xl space-y-5 py-4 [@media(min-height:860px)]:space-y-8">
            <div className="space-y-5">
              <h2 className="text-4xl leading-[1.12] font-bold tracking-tight xl:text-5xl [@media(max-height:720px)]:text-3xl">
                Run every restaurant, branch and table from{' '}
                <span className="relative inline-block text-emerald-400">
                  one place.
                  <svg
                    aria-hidden
                    viewBox="0 0 300 20"
                    fill="none"
                    className="absolute -bottom-3 left-0 h-3 w-[110%]"
                  >
                    <path
                      d="M4 16 C 80 4, 200 2, 296 8"
                      stroke="#f5b324"
                      strokeWidth="4"
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
              </h2>
              <p className="max-w-md text-lg leading-relaxed text-white/85">
                Manage operations, boost efficiency and deliver an exceptional dining experience.
              </p>
            </div>

            <ul className="space-y-5">
              {HIGHLIGHTS.map(({ icon: Icon, title, text }) => (
                <li key={title} className="flex items-center gap-4">
                  <span className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-emerald-600/40 text-emerald-300 ring-1 ring-emerald-400/20 backdrop-blur-sm">
                    <Icon className="size-7" aria-hidden />
                  </span>
                  <div>
                    <p className="font-semibold">{title}</p>
                    <p className="text-sm text-white/80">{text}</p>
                  </div>
                </li>
              ))}
            </ul>

            <div className="flex w-fit [@media(max-height:720px)]:hidden items-center gap-5 rounded-full border border-white/15 bg-white/5 py-3 pr-8 pl-5 backdrop-blur-sm">
              <div className="flex -space-x-2">
                {AVATARS.map(({ initials, className }) => (
                  <span
                    key={initials}
                    aria-hidden
                    className={cn(
                      'flex size-10 items-center justify-center rounded-full text-xs font-semibold ring-2 ring-[#063a2e]',
                      className,
                    )}
                  >
                    {initials}
                  </span>
                ))}
              </div>
              <div>
                <p className="text-sm">Trusted by 1000+ Restaurants</p>
                <p className="mt-1 flex gap-1 text-amber-400" aria-label="5 out of 5 stars">
                  {Array.from({ length: 5 }, (_, i) => (
                    <Star key={i} className="size-4 fill-current" aria-hidden />
                  ))}
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4 text-xs text-white/80">
            <ShieldCheck className="size-5 text-emerald-400" aria-hidden />
            <span>© {new Date().getFullYear()} FoodStack. All rights reserved.</span>
            <span className="ml-6">Privacy Policy</span>
            <span aria-hidden className="text-white/40">
              |
            </span>
            <span>Terms of Service</span>
          </div>
        </div>

        {/* Curved green edge that sweeps into the light side. */}
        <svg
          aria-hidden
          viewBox="0 0 200 1000"
          preserveAspectRatio="none"
          className="absolute inset-y-0 right-0 h-full w-40 xl:w-48"
        >
          <path d="M80 0 C 200 250, 0 650, 120 1000 L200 1000 L200 0 Z" fill="#10b981" />
          <path d="M120 0 C 220 280, 40 660, 160 1000 L200 1000 L200 0 Z" fill="#059669" />
          <path d="M150 0 C 240 300, 70 680, 190 1000 L200 1000 L200 0 Z" fill="#f3f8f6" />
        </svg>
      </aside>

      {/* Right: light canvas with soft shapes and the form card. */}
      <main className="relative flex flex-1 flex-col">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-24 -right-24 size-80 rounded-full bg-emerald-100/70"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -right-20 bottom-24 size-64 rounded-full bg-emerald-100/60"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute top-6 right-8 grid grid-cols-8 gap-3.5 opacity-70"
        >
          {Array.from({ length: 24 }, (_, i) => (
            <span key={i} className="size-1.5 rounded-full bg-emerald-300" />
          ))}
        </div>
        <UtensilsCrossed
          aria-hidden
          className="pointer-events-none absolute right-6 bottom-6 size-20 -rotate-12 text-emerald-200"
          strokeWidth={1.5}
        />

        <div className="relative flex flex-1 items-center justify-center px-4 min-h-0 py-3 sm:px-8">
          <div className="w-full max-w-[38rem] rounded-[28px] border border-white bg-white px-6 py-5 sm:py-6 [@media(min-height:860px)]:py-10 max-h-full overflow-y-auto shadow-[0_20px_60px_-20px_rgba(6,58,46,0.25)] sm:px-11">
            <Link
              href="/"
              className="mx-auto mb-3 flex [@media(min-height:860px)]:mb-6 w-fit items-center gap-4"
            >
              <BrandMark />
              <BrandName className="text-2xl text-slate-900 [@media(min-height:860px)]:text-4xl" />
            </Link>
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}

export function AuthHeading({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="mb-4 space-y-1 [@media(min-height:860px)]:mb-8 [@media(min-height:860px)]:space-y-2 text-center">
      <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-[2rem]">{title}</h1>
      {description ? <p className="text-base text-slate-600">{description}</p> : null}
    </div>
  );
}
