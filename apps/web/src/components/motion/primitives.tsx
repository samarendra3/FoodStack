'use client';

import { cn } from '@foodstack/ui/lib/utils';
import {
  animate,
  motion,
  type HTMLMotionProps,
  useInView,
  useMotionTemplate,
  useReducedMotion,
  useSpring,
} from 'motion/react';
import { type ReactNode, useEffect, useRef } from 'react';

/** House easing: fast out, soft landing. */
export const ease = [0.22, 1, 0.36, 1] as const;

/** Parent that staggers its <RevealItem> children as they scroll into view. */
export function Reveal({
  children,
  className,
  stagger = 0.06,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  stagger?: number;
  delay?: number;
}) {
  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: '0px 0px -60px 0px' }}
      variants={{
        hidden: {},
        show: { transition: { staggerChildren: stagger, delayChildren: delay } },
      }}
    >
      {children}
    </motion.div>
  );
}

export function RevealItem({ className, ...props }: HTMLMotionProps<'div'>) {
  return (
    <motion.div
      className={className}
      variants={{
        hidden: { opacity: 0, y: 14, filter: 'blur(4px)' },
        show: {
          opacity: 1,
          y: 0,
          filter: 'blur(0px)',
          transition: { duration: 0.5, ease },
          transitionEnd: { filter: 'none' },
        },
      }}
      {...props}
    />
  );
}

/** Card with a small lift and deeper shadow on hover. Static when the user prefers reduced motion. */
export function SpotlightCard({
  children,
  className,
  ...rest
}: Omit<HTMLMotionProps<'div'>, 'children'> & { children?: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      {...rest}
      whileHover={reduce ? undefined : { y: -2 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      className={cn(
        'relative rounded-xl border border-slate-200 bg-white shadow-xs transition-shadow duration-300 hover:shadow-[0_8px_30px_-12px_rgb(15_23_42/0.18)] dark:border-white/10 dark:bg-slate-900 dark:hover:shadow-[0_8px_30px_-12px_rgb(0_0_0/0.6)]',
        className,
      )}
    >
      {children}
    </motion.div>
  );
}

const format = (n: number) => Math.round(n).toLocaleString();

/** Counts up to `value` when it first scrolls into view, then springs to later changes. */
export function AnimatedNumber({ value, className }: { value: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const reduce = useReducedMotion();
  const from = useRef(0);

  // Writes straight to the node each frame instead of re-rendering React.
  useEffect(() => {
    const node = ref.current;
    if (!node || !inView || reduce) return;
    const controls = animate(from.current, value, {
      duration: 1.1,
      ease,
      onUpdate: (n) => {
        node.textContent = format(n);
      },
    });
    from.current = value;
    return () => controls.stop();
  }, [inView, value, reduce]);

  return (
    <span ref={ref} className={cn('tabular-nums', className)}>
      {/* Static start text; React leaves the animated node alone while it stays the same. */}
      {format(reduce ? value : 0)}
    </span>
  );
}

/** Progress bar that fills from zero when it appears. */
export function AnimatedBar({ value, className }: { value: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true });
  const width = useSpring(0, { stiffness: 80, damping: 20 });
  useEffect(() => {
    if (inView) width.set(Math.max(0, Math.min(100, value)));
  }, [inView, value, width]);
  const w = useMotionTemplate`${width}%`;
  return (
    <div ref={ref} className="h-full w-full">
      <motion.div className={cn('h-full rounded-full', className)} style={{ width: w }} />
    </div>
  );
}
