'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import {
  animate,
  motion,
  useInView,
  useMotionTemplate,
  useMotionValue,
  useTransform,
} from 'motion/react';
import { type MouseEvent, type ReactNode, useEffect, useRef } from 'react';
import { ease } from './restaurants-panel';

const TONES = {
  emerald: {
    tile: 'from-emerald-400 to-emerald-600 shadow-emerald-500/20',
    glow: '16 185 129',
    text: 'text-emerald-600 dark:text-emerald-400',
    bar: 'from-emerald-400 to-emerald-600',
    mark: 'text-emerald-500',
  },
  violet: {
    tile: 'from-violet-400 to-violet-600 shadow-violet-500/20',
    glow: '139 92 246',
    text: 'text-violet-600 dark:text-violet-400',
    bar: 'from-violet-400 to-violet-600',
    mark: 'text-violet-500',
  },
  orange: {
    tile: 'from-orange-300 to-orange-500 shadow-orange-500/20',
    glow: '249 115 22',
    text: 'text-orange-600 dark:text-orange-400',
    bar: 'from-orange-300 to-orange-500',
    mark: 'text-orange-500',
  },
  blue: {
    tile: 'from-sky-400 to-blue-600 shadow-blue-500/20',
    glow: '59 130 246',
    text: 'text-blue-600 dark:text-blue-400',
    bar: 'from-sky-400 to-blue-600',
    mark: 'text-blue-500',
  },
} as const;

export type StatTone = keyof typeof TONES;

/** Footer: a progress meter for a real ratio, or a status badge. */
export type StatFooter =
  | { kind: 'meter'; value: number; max: number; label: string }
  | { kind: 'badge'; text: string; status: 'good' | 'warn' | 'neutral' };

const BADGE = {
  good: 'bg-emerald-50 text-emerald-700 ring-emerald-600/15 dark:bg-emerald-500/10 dark:text-emerald-300',
  warn: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300',
  neutral: 'bg-slate-100 text-slate-600 ring-slate-500/10 dark:bg-white/5 dark:text-slate-300',
};

export function StatCard({
  index,
  tone,
  icon,
  label,
  value,
  delta,
  hint,
  footer,
}: {
  index: number;
  tone: StatTone;
  icon: ReactNode;
  label: string;
  value: number;
  /** Change shown next to the value; omitted when the API has no comparison figure. */
  delta?: number;
  hint: string;
  footer?: StatFooter;
}) {
  const t = TONES[tone];
  // Spotlight that follows the pointer.
  const mx = useMotionValue(-200);
  const my = useMotionValue(-200);
  const spotlight = useMotionTemplate`radial-gradient(240px circle at ${mx}px ${my}px, rgb(${t.glow} / 0.14), transparent 70%)`;
  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    mx.set(e.clientX - rect.left);
    my.set(e.clientY - rect.top);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.15 + index * 0.08, ease }}
      whileHover={{ y: -5 }}
      onMouseMove={onMove}
      onMouseLeave={() => {
        mx.set(-200);
        my.set(-200);
      }}
      className="group relative isolate overflow-hidden rounded-[18px] border border-slate-200/70 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.06)] transition-shadow duration-300 hover:shadow-[0_6px_16px_-6px_rgba(15,23,42,0.12)] dark:border-white/10 dark:bg-[#101c18]"
    >
      {/* Pointer spotlight + gradient border on hover */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{ background: spotlight }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 rounded-[18px] opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background: `linear-gradient(135deg, rgb(${t.glow} / 0.08), transparent 45%)`,
        }}
      />
      {/* Oversized faint icon in the corner */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute -right-6 -bottom-8 -z-10 opacity-[0.05] transition-transform duration-500 group-hover:scale-110 group-hover:-rotate-6 dark:opacity-[0.07] [&_svg]:size-32',
          t.mark,
        )}
      >
        {icon}
      </span>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-500 dark:text-slate-400">{label}</p>
          <div className="mt-2 flex items-center gap-2.5">
            <span className="text-[2rem] leading-none font-bold tracking-tight tabular-nums">
              <CountUp value={value} />
            </span>
            {delta ? (
              <motion.span
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{
                  type: 'spring',
                  stiffness: 300,
                  damping: 18,
                  delay: 0.7 + index * 0.08,
                }}
                className={cn(
                  'inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset',
                  delta > 0
                    ? BADGE.good
                    : 'bg-red-50 text-red-600 ring-red-600/15 dark:bg-red-500/10 dark:text-red-300',
                )}
              >
                {delta > 0 ? (
                  <ArrowUpRight className="size-3.5" />
                ) : (
                  <ArrowDownRight className="size-3.5" />
                )}
                {delta > 0 ? `+${delta}` : delta}
              </motion.span>
            ) : null}
          </div>
        </div>
        <motion.span
          initial={{ scale: 0, rotate: -30 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 260, damping: 15, delay: 0.3 + index * 0.08 }}
          className={cn(
            'flex size-12 shrink-0 items-center justify-center rounded-[14px] bg-gradient-to-br text-white shadow-sm ring-4 ring-white transition-transform duration-300 group-hover:scale-110 group-hover:rotate-6 dark:ring-[#101c18] [&_svg]:size-6',
            t.tile,
          )}
        >
          {icon}
        </motion.span>
      </div>

      <p className="mt-3 truncate text-xs text-muted-foreground">{hint}</p>

      {footer?.kind === 'meter' ? (
        <Meter {...footer} bar={t.bar} text={t.text} delay={0.5 + index * 0.08} />
      ) : footer?.kind === 'badge' ? (
        <div className="mt-4 border-t border-dashed border-slate-200 pt-3 dark:border-white/10">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset',
              BADGE[footer.status],
            )}
          >
            <span className="relative flex size-1.5">
              {footer.status === 'warn' ? (
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />
              ) : null}
              <span className="relative inline-flex size-1.5 rounded-full bg-current" />
            </span>
            {footer.text}
          </span>
        </div>
      ) : null}
    </motion.div>
  );
}

function Meter({
  value,
  max,
  label,
  bar,
  text,
  delay,
}: {
  value: number;
  max: number;
  label: string;
  bar: string;
  text: string;
  delay: number;
}) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="mt-4 border-t border-dashed border-slate-200 pt-3 dark:border-white/10">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn('font-semibold tabular-nums', text)}>{pct}%</span>
      </div>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-white/10"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 1, delay, ease }}
          className={cn('h-full rounded-full bg-gradient-to-r', bar)}
        />
      </div>
    </div>
  );
}

/** Counts up from 0 when it scrolls into view (instantly with reduced motion). */
function CountUp({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const count = useMotionValue(0);
  const text = useTransform(count, (v) => Math.round(v).toLocaleString());
  useEffect(() => {
    if (!inView) return;
    const controls = animate(count, value, { duration: 1.2, ease });
    return () => controls.stop();
  }, [inView, value, count]);
  return <motion.span ref={ref}>{text}</motion.span>;
}

export function StatCardSkeleton() {
  return (
    <div
      aria-hidden
      className="h-[11rem] animate-pulse rounded-[18px] border border-slate-200/70 bg-white dark:border-white/10 dark:bg-[#101c18]"
    />
  );
}
