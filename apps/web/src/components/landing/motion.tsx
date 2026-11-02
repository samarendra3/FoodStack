'use client';

import {
  animate,
  MotionConfig,
  motion,
  useInView,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type HTMLMotionProps,
  type Variants,
} from 'motion/react';
import { useEffect, useRef, type ReactNode } from 'react';

/* Landing-page motion primitives. All motion is skipped when the visitor prefers reduced motion. */

const ease = [0.22, 1, 0.36, 1] as const;

export function LandingMotion({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease } },
};

type DivProps = HTMLMotionProps<'div'>;

/** Fades and lifts its content in when it scrolls into view (or on load with `immediate`). */
export function Reveal({
  delay = 0,
  immediate = false,
  ...props
}: DivProps & { delay?: number; immediate?: boolean }) {
  return (
    <motion.div
      initial="hidden"
      {...(immediate ? { animate: 'show' } : { whileInView: 'show' })}
      viewport={{ once: true, margin: '-80px' }}
      variants={fadeUp}
      transition={{ delay }}
      {...props}
    />
  );
}

/** Parent that reveals its `StaggerItem` children one after another. */
export function Stagger({
  as = 'div',
  gap = 0.1,
  delay = 0,
  immediate = false,
  ...props
}: Omit<DivProps, 'ref'> & {
  as?: 'div' | 'ul' | 'dl';
  gap?: number;
  delay?: number;
  immediate?: boolean;
}) {
  const Component = motion[as] as typeof motion.div;
  return (
    <Component
      initial="hidden"
      {...(immediate ? { animate: 'show' } : { whileInView: 'show' })}
      viewport={{ once: true, margin: '-80px' }}
      variants={{
        hidden: {},
        show: { transition: { staggerChildren: gap, delayChildren: delay } },
      }}
      {...props}
    />
  );
}

export function StaggerItem({
  as = 'div',
  ...props
}: Omit<DivProps, 'ref'> & { as?: 'div' | 'li' | 'span' }) {
  const Component = motion[as] as typeof motion.div;
  return <Component variants={fadeUp} {...props} />;
}

/** Gentle endless bob, used on the product mockups. */
export function Float({
  distance = 10,
  duration = 5,
  delay = 0,
  ...props
}: DivProps & { distance?: number; duration?: number; delay?: number }) {
  return (
    <motion.div
      animate={{ y: [0, -distance, 0] }}
      transition={{ duration, delay, repeat: Infinity, ease: 'easeInOut' }}
      {...props}
    />
  );
}

/** Pops in from slightly smaller, for floating cards and badges. */
export function PopIn({ delay = 0, ...props }: DivProps & { delay?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.85, y: 12 }}
      whileInView={{ opacity: 1, scale: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ delay, type: 'spring', stiffness: 260, damping: 20 }}
      {...props}
    />
  );
}

/** SVG path that draws itself in when visible. */
export function DrawPath({
  delay = 0,
  duration = 1.2,
  ...props
}: Omit<React.ComponentProps<typeof motion.path>, 'ref'> & { delay?: number; duration?: number }) {
  return (
    <motion.path
      initial={{ pathLength: 0, opacity: 0 }}
      whileInView={{ pathLength: 1, opacity: 1 }}
      viewport={{ once: true }}
      transition={{ delay, duration, ease }}
      {...props}
    />
  );
}

/** Counts from 0 to `value` when scrolled into view. */
export function CountUp({
  value,
  prefix = '',
  suffix = '',
  duration = 1.4,
}: {
  value: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const reduce = useReducedMotion();
  const count = useMotionValue(0);
  const text = useTransform(
    count,
    (v) => `${prefix}${Math.round(v).toLocaleString('en-IN')}${suffix}`,
  );

  useEffect(() => {
    if (!inView) return;
    if (reduce) {
      count.set(value);
      return;
    }
    const controls = animate(count, value, { duration, ease });
    return () => controls.stop();
  }, [inView, reduce, count, value, duration]);

  return (
    <motion.span ref={ref} className="tabular">
      {text}
    </motion.span>
  );
}
