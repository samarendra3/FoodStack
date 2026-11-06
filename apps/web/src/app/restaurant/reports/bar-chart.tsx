'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { type CSSProperties, useState } from 'react';

export interface Series {
  key: string;
  label: string;
  /** Validated categorical steps for the light and dark surfaces. */
  light: string;
  dark: string;
}

interface Bucket {
  key: string;
  label: string;
  values: Partial<Record<string, number>>;
}

const H = 220;
const PAD = { top: 8, right: 8, bottom: 26, left: 56 };

/**
 * Grouped bar chart in plain SVG: one y-axis from zero, recessive grid, rounded data-ends on the
 * baseline, a 2px gap between bars, legend above, and a per-period hover tooltip.
 */
export function BarChart({
  series,
  buckets,
  format,
  className,
  ariaLabel = 'Stock movement value per period',
}: {
  series: Series[];
  buckets: Bucket[];
  format: (v: number) => string;
  className?: string;
  /** Names the chart for screen readers. */
  ariaLabel?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...buckets.flatMap((b) => series.map((s) => b.values[s.key] ?? 0)));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1]!;
  const W = Math.max(560, buckets.length * (series.length * 10 + 14));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / buckets.length;
  const barW = Math.max(3, Math.min(18, (slot - 8) / series.length - 2));
  const groupW = series.length * barW + (series.length - 1) * 2;
  const y = (v: number) => PAD.top + innerH - (v / top) * innerH;
  const labelEvery = Math.ceil(buckets.length / 10);

  return (
    <div className={cn('relative', className)}>
      <ul className="mb-3 flex flex-wrap gap-4 text-xs text-muted-foreground" aria-label="Legend">
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span
              className="size-2.5 rounded-sm bg-[var(--l)] dark:bg-[var(--d)]"
              style={vars(s)}
              aria-hidden
            />
            {s.label}
          </li>
        ))}
      </ul>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          role="img"
          aria-label={ariaLabel}
          className="max-w-none"
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y(t)}
                y2={y(t)}
                className="stroke-border"
                strokeWidth={1}
                strokeDasharray={t === 0 ? undefined : '2 4'}
              />
              <text
                x={PAD.left - 8}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                className="fill-muted-foreground text-[10px] tabular-nums"
              >
                {compact(t, format)}
              </text>
            </g>
          ))}
          {buckets.map((b, i) => {
            const x0 = PAD.left + i * slot + (slot - groupW) / 2;
            return (
              <g key={b.key}>
                {hover === i ? (
                  <rect
                    x={PAD.left + i * slot}
                    y={PAD.top}
                    width={slot}
                    height={innerH}
                    className="fill-muted/60"
                  />
                ) : null}
                {series.map((s, j) => {
                  const v = b.values[s.key] ?? 0;
                  if (v <= 0) return null;
                  const h = Math.max(2, y(0) - y(v));
                  return (
                    <path
                      key={s.key}
                      d={roundedTop(x0 + j * (barW + 2), y(0) - h, barW, h, Math.min(4, barW / 2))}
                      className="fill-[var(--l)] dark:fill-[var(--d)]"
                      style={vars(s)}
                    />
                  );
                })}
                {i % labelEvery === 0 ? (
                  <text
                    x={PAD.left + i * slot + slot / 2}
                    y={H - 8}
                    textAnchor="middle"
                    className="fill-muted-foreground text-[10px]"
                  >
                    {b.label}
                  </text>
                ) : null}
                <rect
                  x={PAD.left + i * slot}
                  y={PAD.top}
                  width={slot}
                  height={innerH}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  tabIndex={0}
                  aria-label={`${b.label}: ${series.map((s) => `${s.label} ${format(b.values[s.key] ?? 0)}`).join(', ')}`}
                />
              </g>
            );
          })}
        </svg>
      </div>
      {hover !== null && buckets[hover] ? (
        <div
          role="tooltip"
          className="pointer-events-none absolute top-8 z-10 min-w-40 rounded-lg border bg-popover p-2.5 text-xs shadow-md"
          style={{
            left: `clamp(0px, calc(${((PAD.left + (hover + 0.5) * slot) / W) * 100}% - 80px), calc(100% - 10rem))`,
          }}
        >
          <p className="mb-1.5 font-semibold">{buckets[hover].label}</p>
          {series.map((s) => (
            <p key={s.key} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span
                  className="size-2 rounded-sm bg-[var(--l)] dark:bg-[var(--d)]"
                  style={vars(s)}
                />
                {s.label}
              </span>
              <span className="tabular-nums">{format(buckets[hover]!.values[s.key] ?? 0)}</span>
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const vars = (s: Series) => ({ '--l': s.light, '--d': s.dark }) as CSSProperties;

function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

function niceTicks(max: number): number[] {
  const step0 = max / 4;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? 10 * mag;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step);
}

/** Axis labels: ₹1.2K style, from minor units. */
function compact(minor: number, format: (v: number) => string) {
  const major = minor / 100;
  if (major < 1000) return format(minor).replace(/\.00$/, '');
  const symbol = format(0).replace(/[\d.,\s]/g, '');
  return `${symbol}${new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(major)}`;
}
