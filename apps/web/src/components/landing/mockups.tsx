import { cn } from '@foodstack/ui/lib/utils';
import {
  ArrowRight,
  ArrowUp,
  BarChart3,
  Boxes,
  CakeSlice,
  ChartNoAxesColumnIncreasing,
  Utensils,
  Coffee,
  CupSoda,
  Drumstick,
  Fish,
  Hamburger,
  IceCreamCone,
  LayoutDashboard,
  Pizza,
  Salad,
  Sandwich,
  Settings,
  ShoppingBag,
  Users,
  Soup,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react';
import { CountUp, DrawPath, PopIn, Stagger, StaggerItem } from './motion';

/* Code-drawn product illustrations for the landing page. Figures are sample data. */

interface FoodTile {
  label: string;
  icon: LucideIcon;
  tone: string;
}

const posItems: FoodTile[] = [
  { label: 'Pizza', icon: Pizza, tone: 'bg-orange-50 text-orange-500 ring-orange-100' },
  { label: 'Burger', icon: Hamburger, tone: 'bg-amber-50 text-amber-600 ring-amber-100' },
  { label: 'Soup', icon: Soup, tone: 'bg-rose-50 text-rose-500 ring-rose-100' },
  { label: 'Salad', icon: Salad, tone: 'bg-emerald-50 text-emerald-600 ring-emerald-100' },
  { label: 'Chicken', icon: Drumstick, tone: 'bg-orange-50 text-orange-600 ring-orange-100' },
  { label: 'Sandwich', icon: Sandwich, tone: 'bg-yellow-50 text-yellow-600 ring-yellow-100' },
  { label: 'Fish', icon: Fish, tone: 'bg-sky-50 text-sky-500 ring-sky-100' },
  { label: 'Coffee', icon: Coffee, tone: 'bg-stone-100 text-stone-600 ring-stone-200' },
  { label: 'Dessert', icon: CakeSlice, tone: 'bg-pink-50 text-pink-500 ring-pink-100' },
];

const phoneItems: FoodTile[] = [
  { label: 'Pizza', icon: Pizza, tone: 'bg-orange-50 text-orange-500' },
  { label: 'Drinks', icon: CupSoda, tone: 'bg-sky-50 text-sky-500' },
  { label: 'Dessert', icon: IceCreamCone, tone: 'bg-pink-50 text-pink-500' },
];

/** POS terminal on a stand, showing a menu grid and an order ticket. */
export function PosTerminal({ className }: { className?: string }) {
  return (
    <div className={cn('relative', className)} aria-hidden>
      <div className="rounded-[1.75rem] bg-slate-900 p-3 shadow-2xl shadow-emerald-950/30 ring-1 ring-slate-700">
        <div className="flex aspect-[16/10] overflow-hidden rounded-2xl bg-white">
          <div className="flex w-[14%] flex-col items-center gap-2 bg-slate-900 py-3">
            <span className="size-5 rounded-md bg-emerald-500" />
            {[0, 1, 2, 3, 4].map((i) => (
              <span
                key={i}
                className={cn(
                  'h-1.5 w-1/2 rounded-full',
                  i === 0 ? 'bg-emerald-400' : 'bg-slate-600',
                )}
              />
            ))}
          </div>
          <div className="flex-1 p-3">
            <div className="mb-2 flex gap-1.5">
              {['All', 'Mains', 'Drinks', 'Sides'].map((tab, i) => (
                <span
                  key={tab}
                  className={cn(
                    'rounded-lg px-2 py-0.5 text-[8px] font-semibold',
                    i === 0 ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-500',
                  )}
                >
                  {tab}
                </span>
              ))}
            </div>
            <Stagger immediate delay={0.5} gap={0.06} className="grid grid-cols-3 gap-1.5">
              {posItems.map(({ label, icon: Icon, tone }) => (
                <StaggerItem
                  key={label}
                  className={cn(
                    'flex aspect-[5/4] flex-col items-center justify-center gap-0.5 rounded-lg ring-1',
                    tone,
                  )}
                >
                  <Icon className="size-5 sm:size-6" strokeWidth={1.75} />
                  <span className="text-[7px] font-semibold text-slate-600">{label}</span>
                </StaggerItem>
              ))}
            </Stagger>
          </div>
          <div className="flex w-[30%] flex-col gap-1.5 border-l border-slate-100 bg-slate-50 p-2.5">
            <span className="text-[8px] font-bold text-slate-700">Table 12</span>
            <Stagger immediate delay={1.1} gap={0.15} className="flex flex-col gap-1.5">
              {[70, 55, 80, 60].map((w, i) => (
                <StaggerItem key={i} className="flex items-center justify-between gap-1">
                  <span className="h-1.5 rounded-full bg-slate-200" style={{ width: `${w}%` }} />
                  <span className="h-1.5 w-3 rounded-full bg-slate-300" />
                </StaggerItem>
              ))}
            </Stagger>
            <div className="mt-auto space-y-1.5">
              <div className="flex justify-between text-[8px] font-bold text-slate-800">
                <span>Total</span>
                <span>₹1,240</span>
              </div>
              <span className="block rounded-md bg-emerald-600 py-1 text-center text-[8px] font-semibold text-white">
                Charge
              </span>
            </div>
          </div>
        </div>
      </div>
      {/* Stand */}
      <div className="mx-auto h-10 w-16 bg-gradient-to-b from-slate-800 to-slate-900" />
      <div className="mx-auto h-3 w-44 rounded-t-xl bg-slate-900 shadow-xl" />
    </div>
  );
}

/** Frosted "business growth" stat bubble. */
export function GrowthCard({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-2xl bg-white/80 px-5 py-4 shadow-xl shadow-emerald-950/10 ring-1 ring-white backdrop-blur dark:bg-slate-900/80 dark:ring-slate-700',
        className,
      )}
      aria-hidden
    >
      <ChartNoAxesColumnIncreasing className="size-9 text-emerald-600" strokeWidth={2.5} />
      <div>
        {/* TODO: replace with a real, sourced figure before launch. */}
        <p className="font-display text-2xl font-bold leading-none text-foreground">+85%</p>
        <p className="mt-1 text-xs text-muted-foreground">Business Growth</p>
      </div>
    </div>
  );
}

const salesWeek = [
  { day: 'Mon', value: 22 },
  { day: 'Tue', value: 30 },
  { day: 'Wed', value: 38 },
  { day: 'Thu', value: 28 },
  { day: 'Fri', value: 40 },
  { day: 'Sat', value: 52 },
  { day: 'Sun', value: 66 },
];

/** Smooth Catmull-Rom curve through the points, as an SVG path. */
function smoothPath(points: [number, number][]) {
  return points.reduce((d, [x, y], i, arr) => {
    if (i === 0) return `M${x},${y}`;
    const [x0, y0] = arr[i - 2] ?? arr[i - 1]!;
    const [x1, y1] = arr[i - 1]!;
    const [x3, y3] = arr[i + 1] ?? [x, y];
    const c1 = [x1 + (x - x0) / 6, y1 + (y - y0) / 6];
    const c2 = [x - (x3 - x1) / 6, y - (y3 - y1) / 6];
    return `${d} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${x},${y}`;
  }, '');
}

function SalesChart() {
  const w = 300;
  const h = 90;
  const points = salesWeek.map(
    (p, i) => [(i / (salesWeek.length - 1)) * w, h - (p.value / 80) * h] as [number, number],
  );
  const line = smoothPath(points);
  const highlight = points[5]!;

  return (
    <div className="relative">
      <svg
        viewBox={`0 -10 ${w} ${h + 10}`}
        className="h-28 w-full overflow-visible"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="sales-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#10b981" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
          </linearGradient>
        </defs>
        <DrawPath
          d={`${line} L${w},${h} L0,${h} Z`}
          fill="url(#sales-fill)"
          stroke="none"
          delay={1}
          duration={0.8}
        />
        <DrawPath
          d={line}
          delay={0.3}
          duration={1.4}
          fill="none"
          stroke="#10b981"
          strokeWidth="2.5"
          vectorEffect="non-scaling-stroke"
        />
        <line
          x1={highlight[0]}
          x2={highlight[0]}
          y1={highlight[1]}
          y2={h}
          stroke="#10b981"
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <PopIn
        delay={1.5}
        className="absolute -translate-x-1/2 -translate-y-full rounded-md bg-emerald-600 px-1.5 py-0.5 text-[9px] font-bold text-white shadow"
        style={{
          left: `${(highlight[0] / w) * 100}%`,
          top: `${((highlight[1] + 10) / (h + 10)) * 100 - 6}%`,
        }}
      >
        ₹48,250
      </PopIn>
      <div className="mt-1 flex justify-between text-[9px] text-slate-400">
        {salesWeek.map((p) => (
          <span key={p.day}>{p.day}</span>
        ))}
      </div>
    </div>
  );
}

const dashNav = [
  { label: 'Dashboard', icon: LayoutDashboard },
  { label: 'Orders', icon: ShoppingBag },
  { label: 'Menu', icon: UtensilsCrossed },
  { label: 'Inventory', icon: Boxes },
  { label: 'Reports', icon: BarChart3 },
  { label: 'Settings', icon: Settings },
];

const dashStats = [
  { label: 'Today’s Sales', value: 48250, prefix: '₹', change: '+12%' },
  { label: 'Total Orders', value: 1248, prefix: '', change: '+8%' },
  { label: 'New Customers', value: 320, prefix: '', change: '+15%' },
];

/** Admin dashboard window: navy sidebar, stat tiles and a weekly sales curve. */
export function DashboardPreview({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex overflow-hidden rounded-2xl bg-white shadow-2xl shadow-slate-900/15 ring-1 ring-slate-200 dark:ring-slate-700',
        className,
      )}
      aria-hidden
    >
      <div className="hidden w-[30%] shrink-0 flex-col gap-1 bg-slate-900 p-3 sm:flex">
        <div className="mb-3 flex items-center gap-2 px-1">
          <span className="flex size-6 items-center justify-center rounded-md bg-emerald-500 text-white">
            <Utensils className="size-3.5" />
          </span>
          <span className="font-display text-sm font-bold text-white">FoodStack</span>
        </div>
        {dashNav.map(({ label, icon: Icon }, i) => (
          <span
            key={label}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-[10px] font-medium',
              i === 0 ? 'bg-emerald-600 text-white' : 'text-slate-300',
            )}
          >
            <Icon className="size-3" />
            {label}
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1 bg-slate-50 p-4">
        <div className="grid grid-cols-3 gap-2">
          {dashStats.map((s) => (
            <div
              key={s.label}
              className="rounded-lg bg-indigo-50/70 p-2.5 ring-1 ring-indigo-100/60"
            >
              <p className="truncate text-[9px] text-slate-500">{s.label}</p>
              <p className="font-display mt-1 text-sm font-bold text-slate-900 sm:text-base">
                <CountUp value={s.value} prefix={s.prefix} />
              </p>
              <p className="mt-0.5 flex items-center gap-0.5 text-[9px] font-semibold text-emerald-600">
                <ArrowUp className="size-2.5" />
                {s.change}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-3 rounded-lg bg-white p-3 ring-1 ring-slate-100">
          <p className="mb-5 text-[10px] font-semibold text-slate-800">Sales Overview</p>
          <SalesChart />
        </div>
      </div>
    </div>
  );
}

/** Phone showing the guest ordering screen. */
export function PhonePreview({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'w-40 rounded-[2rem] bg-slate-900 p-1.5 shadow-2xl shadow-slate-900/30 ring-1 ring-slate-700',
        className,
      )}
      aria-hidden
    >
      <div className="overflow-hidden rounded-[1.6rem] bg-white">
        <div className="relative flex h-24 items-center justify-center bg-gradient-to-br from-amber-100 via-orange-100 to-rose-100 text-orange-500">
          <span className="absolute top-1.5 left-1/2 h-3 w-12 -translate-x-1/2 rounded-full bg-slate-900" />
          <Soup className="mt-2 size-12" strokeWidth={1.5} />
        </div>
        <div className="space-y-2 p-3 text-center">
          <p className="font-display text-sm leading-tight font-extrabold text-slate-900">
            Delicious Food
            <br />
            Delivered Fresh
          </p>
          <span className="mx-auto flex w-fit items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1 text-[9px] font-semibold text-white">
            Order Now <ArrowRight className="size-2.5" />
          </span>
          <div className="grid grid-cols-3 gap-1.5 pt-1">
            {phoneItems.map(({ label, icon: Icon, tone }) => (
              <span
                key={label}
                className={cn('flex aspect-square items-center justify-center rounded-lg', tone)}
              >
                <Icon className="size-5" strokeWidth={1.75} />
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Three short green strokes used as a sparkle accent. */
export function Sparkle({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={cn('size-10 text-emerald-500', className)} aria-hidden>
      <g stroke="currentColor" strokeWidth="3.5" strokeLinecap="round">
        <DrawPath d="M8 22 L4 10" delay={0.6} duration={0.4} />
        <DrawPath d="M16 18 L20 4" delay={0.75} duration={0.4} />
        <DrawPath d="M22 26 L34 20" delay={0.9} duration={0.4} />
      </g>
    </svg>
  );
}

/** Frosted "24/7 support" bubble, paired with the growth card in the hero. */
export function SupportCard({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-2xl bg-white/85 px-5 py-3.5 shadow-xl shadow-emerald-950/10 ring-1 ring-white backdrop-blur dark:bg-slate-900/80 dark:ring-slate-700',
        className,
      )}
      aria-hidden
    >
      <Users className="size-8 text-emerald-600" strokeWidth={2.25} />
      <div>
        <p className="font-display text-2xl leading-none font-bold text-foreground">24/7</p>
        <p className="mt-1 text-xs text-muted-foreground">Support</p>
      </div>
    </div>
  );
}
