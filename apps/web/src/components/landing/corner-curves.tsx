import { cn } from '@foodstack/ui/lib/utils';
import { DrawPath } from './motion';

/**
 * Layered green curves for a hero corner. Uses the same ribbon paths and colours as the
 * bottom-right hero ribbons, turned 180° so they sweep down from the top-left corner.
 * `id` keeps gradient ids unique when the component appears more than once on a page.
 */
export function CornerCurves({ id = 'corner', className }: { id?: string; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 600 700"
      preserveAspectRatio="none"
      fill="none"
      className={cn('pointer-events-none rotate-180', className)}
    >
      <defs>
        <linearGradient id={`${id}-a`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#10b981" stopOpacity="0" />
          <stop offset="35%" stopColor="#10b981" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#34d399" stopOpacity="0.95" />
        </linearGradient>
        <linearGradient id={`${id}-b`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#6ee7b7" stopOpacity="0" />
          <stop offset="50%" stopColor="#6ee7b7" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#a7f3d0" stopOpacity="0.8" />
        </linearGradient>
      </defs>
      {/* Soft filled layers behind the ribbons: light green outside, green inside. */}
      <path
        className="fill-emerald-100 dark:fill-emerald-950"
        fillOpacity="0.7"
        d="M600 700 L600 300 C 470 360, 330 470, 160 700 Z"
      />
      <path
        className="fill-emerald-200 dark:fill-emerald-900"
        fillOpacity="0.55"
        d="M600 700 L600 470 C 500 510, 400 580, 330 700 Z"
      />
      <DrawPath
        d="M120 740 C 280 560, 430 440, 720 400"
        stroke={`url(#${id}-a)`}
        strokeWidth="18"
        strokeLinecap="round"
        delay={0.7}
        duration={1.4}
      />
      <DrawPath
        d="M300 740 C 410 620, 520 560, 720 540"
        stroke={`url(#${id}-b)`}
        strokeWidth="12"
        strokeLinecap="round"
        delay={1}
        duration={1.4}
      />
    </svg>
  );
}
