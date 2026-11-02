import { buttonVariants } from '@foodstack/ui/components/button';
import { cn } from '@foodstack/ui/lib/utils';
import {
  ArrowRight,
  Coffee,
  CookingPot,
  ChartLine,
  ChartNoAxesColumn,
  ChefHat,
  Headphones,
  Hamburger,
  LayoutGrid,
  Play,
  QrCode,
  ReceiptText,
  Salad,
  ShieldCheck,
  Smartphone,
  Store,
  UtensilsCrossed,
  Zap,
} from 'lucide-react';
import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  DashboardPreview,
  GrowthCard,
  PhonePreview,
  Sparkle,
  SupportCard,
} from '@/components/landing/mockups';
import {
  DrawPath,
  Float,
  LandingMotion,
  PopIn,
  Reveal,
  Stagger,
  StaggerItem,
} from '@/components/landing/motion';
import { FloatingIcons, type FloatingIcon } from '@/components/landing/floating-icons';
import { PricingSection } from '@/components/landing/pricing';
import { SiteFooter } from '@/components/landing/site-footer';
import { SiteHeader } from '@/components/landing/site-header';
import ctaImage from '../../../public/images/cta-bg-image.png';
import heroImage from '../../../public/images/herobg-image.png';

export const metadata: Metadata = {
  title: { absolute: 'FoodStack · Restaurant management and billing' },
  description:
    'Run billing, orders, kitchen, menu and inventory for every branch from one platform.',
};

// TODO: point Watch demo at a real video.

const productIcons: FloatingIcon[] = [
  { icon: Hamburger, className: 'top-28 left-[3%] size-12 rotate-6' },
  { icon: Salad, className: 'bottom-16 left-[30%] size-10 -rotate-12' },
  { icon: UtensilsCrossed, className: 'top-24 right-[3%] size-9 rotate-12' },
];

const whyIcons: FloatingIcon[] = [
  { icon: CookingPot, className: 'top-10 left-[42%] size-10 -rotate-6' },
  { icon: Coffee, className: 'bottom-6 left-[2%] size-9 rotate-12' },
];

const highlights = [
  { icon: Store, label: 'Multi-Branch Support' },
  { icon: ChartLine, label: 'Real-Time Analytics' },
  { icon: ShieldCheck, label: 'Secure & Reliable' },
  { icon: Headphones, label: '24/7 Support' },
];

const apps = [
  {
    icon: LayoutGrid,
    title: 'Admin Dashboard',
    description: 'Menu, staff, branches, inventory and reports in one place.',
  },
  {
    icon: ReceiptText,
    title: 'POS Billing',
    description: 'Fast touch billing at the counter, built to keep going when internet drops.',
  },
  {
    icon: ChefHat,
    title: 'Kitchen Display',
    description: 'Orders reach each station the moment they are placed.',
  },
  {
    icon: QrCode,
    title: 'QR Ordering',
    description: 'Guests scan the table code, browse the menu and order from their phone.',
  },
  {
    icon: Smartphone,
    title: 'Waiter App',
    description: 'Take orders tableside and keep track of every open table.',
  },
];

const reasons = [
  {
    icon: Zap,
    title: 'Every branch, one account',
    description:
      'Manage several restaurants and branches with shared menus and per-branch pricing.',
  },
  {
    icon: ChartNoAxesColumn,
    title: 'Reports that add up',
    description: 'Sales, bills and table turnover across branches, ready when you need them.',
  },
];

const pill = 'rounded-lg font-semibold';

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm font-semibold text-primary">
      <span className="h-0.5 w-4 rounded-full bg-primary" />
      {children}
    </p>
  );
}

export default function LandingPage() {
  return (
    <LandingMotion>
      <div className="flex min-h-dvh flex-col overflow-x-clip">
        <SiteHeader />

        <main className="flex-1">
          {/* Hero */}
          <section className="relative z-10 flex flex-col bg-background pb-20 lg:block lg:pb-0">
            {/* Photo: a card under the copy on small screens, a right-hand backdrop on desktop
                that runs up behind the floating header. */}
            <Reveal
              immediate
              delay={0.3}
              className="relative order-last mx-4 aspect-[16/10] overflow-hidden rounded-xl sm:mx-6 lg:absolute lg:inset-y-0 lg:right-0 lg:-z-10 lg:m-0 lg:aspect-auto lg:w-[62%] lg:rounded-none"
            >
              <Image
                src={heroImage}
                alt="FoodStack POS terminal on a table in a busy restaurant"
                fill
                priority
                placeholder="blur"
                sizes="(min-width: 1024px) 62vw, 100vw"
                className="object-cover object-[75%_center] lg:brightness-[1.15] lg:saturate-[1.1]"
              />
              {/* Fade the photo into the page on the left (desktop only) */}
              <div
                aria-hidden
                className="absolute inset-0 hidden bg-gradient-to-r from-background from-5% via-background/80 via-22% to-transparent to-50% lg:block"
              />
              {/* Green ribbons sweeping up behind the terminal */}
              <svg
                aria-hidden
                viewBox="0 0 600 700"
                preserveAspectRatio="none"
                fill="none"
                className="absolute inset-y-0 right-0 hidden h-full w-[75%] lg:block"
              >
                <defs>
                  <linearGradient id="ribbon-a" x1="0" y1="1" x2="1" y2="0">
                    <stop offset="0%" stopColor="#10b981" stopOpacity="0" />
                    <stop offset="35%" stopColor="#10b981" stopOpacity="0.85" />
                    <stop offset="100%" stopColor="#34d399" stopOpacity="0.95" />
                  </linearGradient>
                  <linearGradient id="ribbon-b" x1="0" y1="1" x2="1" y2="0">
                    <stop offset="0%" stopColor="#6ee7b7" stopOpacity="0" />
                    <stop offset="50%" stopColor="#6ee7b7" stopOpacity="0.7" />
                    <stop offset="100%" stopColor="#a7f3d0" stopOpacity="0.8" />
                  </linearGradient>
                </defs>
                <DrawPath
                  d="M120 740 C 280 560, 430 440, 720 400"
                  stroke="url(#ribbon-a)"
                  strokeWidth="18"
                  strokeLinecap="round"
                  delay={0.7}
                  duration={1.4}
                />
                <DrawPath
                  d="M300 740 C 410 620, 520 560, 720 540"
                  stroke="url(#ribbon-b)"
                  strokeWidth="12"
                  strokeLinecap="round"
                  delay={1}
                  duration={1.4}
                />
              </svg>
            </Reveal>

            {/* Soft green waves along the bottom */}
            <svg
              aria-hidden
              viewBox="0 0 1440 320"
              preserveAspectRatio="none"
              className="pointer-events-none absolute inset-x-0 bottom-0 hidden h-48 w-full text-emerald-100 lg:block dark:text-emerald-950"
            >
              <path
                fill="currentColor"
                fillOpacity="0.55"
                d="M0,200 C260,130 520,280 780,250 C1040,220 1240,150 1440,190 L1440,320 L0,320 Z"
              />
              <path
                fill="currentColor"
                d="M0,270 C300,215 600,320 900,290 C1140,266 1300,240 1440,255 L1440,320 L0,320 Z"
              />
            </svg>

            <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-4 pt-28 pb-10 sm:px-6 lg:min-h-[720px] lg:grid-cols-[1.2fr_1fr] lg:pt-32 lg:pb-44">
              <Stagger immediate gap={0.12} delay={0.15}>
                <StaggerItem
                  as="span"
                  className="inline-flex items-center gap-2.5 rounded-lg bg-accent px-3.5 py-1.5 text-sm font-semibold text-accent-foreground ring-1 ring-primary/10"
                >
                  <span className="relative flex size-2.5">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60 motion-reduce:animate-none" />
                    <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
                  </span>
                  Restaurant management and billing
                </StaggerItem>
                <StaggerItem>
                  <h1 className="font-display mt-6 text-[2.6rem] leading-[1.04] font-extrabold tracking-tight sm:text-6xl xl:text-[4.4rem]">
                    From the first order to the final bill,{' '}
                    <span className="relative block w-fit text-primary">
                      all in one stack
                      <svg
                        aria-hidden
                        viewBox="0 0 300 20"
                        preserveAspectRatio="none"
                        className="absolute -bottom-3 left-[2%] h-3.5 w-[82%] text-amber-400"
                      >
                        <DrawPath
                          delay={0.9}
                          duration={0.9}
                          d="M4 14 C 70 6, 170 3, 296 10"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="6"
                          strokeLinecap="round"
                        />
                      </svg>
                    </span>
                  </h1>
                </StaggerItem>
                <StaggerItem>
                  <p className="mt-8 max-w-xl text-base text-pretty text-muted-foreground sm:text-lg">
                    FoodStack connects your counter, kitchen, tables and back office, so every
                    branch runs on the same menu, the same numbers and the same system.
                  </p>
                </StaggerItem>
                <StaggerItem className="mt-10 flex flex-wrap items-center gap-6">
                  <Link
                    href="/login"
                    className={cn(
                      buttonVariants({ size: 'lg' }),
                      pill,
                      'h-14 px-8 text-base shadow-xl shadow-primary/30',
                    )}
                  >
                    Get started <ArrowRight />
                  </Link>
                  <a href="#" className="group flex items-center gap-3 text-base font-semibold">
                    <span className="flex size-12 items-center justify-center rounded-full border-2 border-primary text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                      <Play className="size-5 fill-current" />
                    </span>
                    Watch demo
                  </a>
                </StaggerItem>
              </Stagger>

              {/* Desktop: the photo sits behind this column; the stat cards float over it. */}
              <div className="relative hidden h-full lg:block">
                <PopIn delay={0.8} className="absolute top-0 left-[6%]">
                  <Float distance={8} duration={4} delay={1.2}>
                    <GrowthCard className="-rotate-3" />
                  </Float>
                </PopIn>
                <PopIn delay={1} className="absolute top-12 -right-2 xl:-right-8">
                  <Float distance={10} duration={5} delay={1.6}>
                    <SupportCard className="rotate-3" />
                  </Float>
                </PopIn>
              </div>
            </div>

            {/* Highlight strip */}
            <div className="absolute inset-x-0 bottom-0 z-20 translate-y-1/2 px-4 sm:px-6">
              <Stagger
                as="ul"
                immediate
                delay={0.7}
                className="mx-auto grid max-w-6xl grid-cols-2 gap-y-4 rounded-3xl bg-card px-5 py-5 shadow-2xl shadow-slate-900/10 ring-1 ring-border md:grid-cols-4 md:divide-x md:divide-border lg:py-6"
              >
                {highlights.map(({ icon: Icon, label }) => (
                  <StaggerItem
                    as="li"
                    key={label}
                    className="flex items-center justify-center gap-3 px-2 text-sm font-semibold lg:text-base"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-primary lg:size-11">
                      <Icon className="size-5 lg:size-6" />
                    </span>
                    {label}
                  </StaggerItem>
                ))}
              </Stagger>
            </div>
          </section>

          {/* Product */}
          <section
            id="product"
            className="relative isolate scroll-mt-28 bg-gradient-to-b from-emerald-50/70 to-background pt-36 pb-24 dark:from-emerald-950/20"
          >
            <FloatingIcons icons={productIcons} />
            <div className="relative mx-auto grid max-w-7xl gap-12 px-4 sm:px-6 lg:grid-cols-[2fr_3fr]">
              <Reveal className="lg:pt-4">
                <Eyebrow>The Product</Eyebrow>
                <h2 className="font-display mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
                  One app for every part of the restaurant
                </h2>
                <p className="mt-5 max-w-sm text-lg text-muted-foreground">
                  Each team gets a screen built for its job, all working from the same live data.
                </p>
                <a
                  href="#features"
                  className={cn(
                    buttonVariants({ variant: 'outline', size: 'lg' }),
                    pill,
                    'mt-10 border-primary text-primary hover:bg-accent',
                  )}
                >
                  Explore all features <ArrowRight />
                </a>
              </Reveal>
              <Stagger as="ul" gap={0.08} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {apps.map(({ icon: Icon, title, description }) => (
                  <StaggerItem
                    as="li"
                    key={title}
                    whileHover={{ y: -6 }}
                    className="group flex gap-4 rounded-2xl bg-card p-5 shadow-lg sm:block sm:p-6 shadow-slate-900/5 ring-1 ring-border transition-shadow hover:shadow-xl hover:shadow-emerald-900/10"
                  >
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-primary transition-colors duration-300 group-hover:bg-primary group-hover:text-primary-foreground">
                      <Icon className="size-5" />
                    </span>
                    <div>
                      <h3 className="font-semibold sm:mt-5">{title}</h3>
                      <p className="mt-1 text-sm text-muted-foreground sm:mt-2">{description}</p>
                    </div>
                  </StaggerItem>
                ))}
              </Stagger>
            </div>
          </section>

          {/* Why FoodStack */}
          <section id="features" className="relative isolate scroll-mt-28 py-24">
            <FloatingIcons icons={whyIcons} />
            <div className="mx-auto grid max-w-7xl items-center gap-16 px-4 sm:px-6 lg:grid-cols-[2fr_3fr]">
              <Reveal>
                <Eyebrow>Why FoodStack</Eyebrow>
                <h2 className="font-display mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
                  Built for busy service, not just the back office
                </h2>
                <p className="mt-5 max-w-sm text-lg text-muted-foreground">
                  Powerful tools to manage your restaurant more efficiently and grow faster.
                </p>
                <Stagger as="dl" gap={0.15} className="mt-10 space-y-8">
                  {reasons.map(({ icon: Icon, title, description }) => (
                    <StaggerItem key={title} className="flex gap-5">
                      <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-accent text-primary">
                        <Icon className="size-6 fill-current" />
                      </span>
                      <div>
                        <dt className="font-semibold">{title}</dt>
                        <dd className="mt-1.5 text-sm text-muted-foreground">{description}</dd>
                      </div>
                    </StaggerItem>
                  ))}
                </Stagger>
              </Reveal>
              <Reveal delay={0.1} className="relative pr-0 sm:pr-24">
                <DashboardPreview />
                <PopIn delay={0.5} className="absolute -right-2 -bottom-10 hidden sm:block">
                  <Float distance={12} duration={5} delay={1}>
                    <PhonePreview className="rotate-6" />
                  </Float>
                </PopIn>
                <Sparkle className="absolute -top-10 right-2 hidden sm:block" />
              </Reveal>
            </div>
          </section>

          <PricingSection />

          {/* CTA */}
          <section id="get-started" className="scroll-mt-28 px-4 pt-4 pb-16 sm:px-6">
            <Reveal className="relative mx-auto max-w-7xl overflow-hidden rounded-3xl bg-[#03241c] text-white">
              <Image
                src={ctaImage}
                alt=""
                fill
                placeholder="blur"
                sizes="(min-width: 1280px) 1280px, 100vw"
                className="object-cover object-[80%_center]"
              />
              {/* The photo is already dark green on the left; deepen it under the copy. */}
              <div
                aria-hidden
                className="absolute inset-0 bg-[#03241c]/70 sm:bg-transparent sm:bg-[linear-gradient(90deg,rgb(3_36_28/0.9)_0%,rgb(3_36_28/0.55)_40%,transparent_70%)]"
              />
              <div className="relative max-w-3xl px-6 py-12 sm:px-12 sm:py-14">
                <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
                  Ready to run service on FoodStack?
                </h2>
                <p className="mt-3 text-lg text-emerald-50/85">
                  Sign in to set up your restaurant, menu and first branch.
                </p>
                <Link
                  href="/login"
                  className={cn(
                    buttonVariants({ size: 'lg' }),
                    pill,
                    'mt-7 h-12 bg-emerald-500 px-7 text-white hover:bg-emerald-400',
                  )}
                >
                  Get started <ArrowRight />
                </Link>
              </div>
            </Reveal>
          </section>
        </main>

        <SiteFooter />
      </div>
    </LandingMotion>
  );
}
