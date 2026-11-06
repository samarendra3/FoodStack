'use client';

import { cn } from '@foodstack/ui/lib/utils';
import { type CSSProperties, useState } from 'react';

/**
 * Plain-SVG charts for the analytics dashboard, matching reports/bar-chart.tsx (no chart
 * library). Colors: validated categorical slots in fixed order (light / dark steps); light
 * slots 3–4 sit under 3:1 on the surface, so every chart also prints its values as text.
 */
export const SERIES = [
  { light: '#2a78d6', dark: '#3987e5' },
  { light: '#eb6834', dark: '#d95926' },
  { light: '#1baf7a', dark: '#199e70' },
  { light: '#eda100', dark: '#c98500' },
] as const;

const vars = (i: number) =>
  ({ '--l': SERIES[i % 4]!.light, '--d': SERIES[i % 4]!.dark }) as CSSProperties;

export function Swatch({ i, className }: { i: number; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block size-2.5 shrink-0 rounded-sm bg-[var(--l)] dark:bg-[var(--d)]',
        className,
      )}
      style={vars(i)}
      aria-hidden
    />
  );
}

const H = 240;
const PAD = { top: 10, right: 12, bottom: 26, left: 60 };

function niceTicks(max: number): number[] {
  const step0 = Math.max(max, 1) / 4;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? 10 * mag;
  return Array.from({ length: Math.ceil(Math.max(max, 1) / step) + 1 }, (_, i) => i * step);
}

/**
 * Line chart over time: one y-axis from zero, 2px lines, recessive dashed grid, crosshair
 * tooltip on hover/focus, legend above for 2+ series, and a table view below.
 */
export function LineChart({
  series,
  points,
  format,
  axisFormat,
  ariaLabel,
}: {
  series: { key: string; label: string }[];
  points: { key: string; label: string; long: string; values: Record<string, number> }[];
  format: (v: number) => string;
  axisFormat: (v: number) => string;
  ariaLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0, ...points.flatMap((p) => series.map((s) => p.values[s.key] ?? 0)));
  const ticks = niceTicks(max);
  const top = ticks.at(-1)!;
  const W = 720;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) =>
    PAD.left + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - (v / top) * innerH;
  const labelEvery = Math.ceil(points.length / 8);
  const slot = innerW / Math.max(1, points.length);

  return (
    <div className="relative">
      {series.length > 1 ? (
        <ul className="mb-3 flex flex-wrap gap-4 text-xs text-muted-foreground" aria-label="Legend">
          {series.map((s, i) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <Swatch i={i} /> {s.label}
            </li>
          ))}
        </ul>
      ) : null}
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={ariaLabel}>
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              className="stroke-border"
              strokeDasharray={t === 0 ? undefined : '2 4'}
            />
            <text
              x={PAD.left - 8}
              y={y(t)}
              dy="0.32em"
              textAnchor="end"
              className="fill-muted-foreground text-[10px] tabular-nums"
            >
              {axisFormat(t)}
            </text>
          </g>
        ))}
        {points.map((p, i) =>
          i % labelEvery === 0 ? (
            <text
              key={p.key}
              x={x(i)}
              y={H - 8}
              textAnchor="middle"
              className="fill-muted-foreground text-[10px]"
            >
              {p.label}
            </text>
          ) : null,
        )}
        {hover !== null ? (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={PAD.top}
            y2={PAD.top + innerH}
            className="stroke-muted-foreground/50"
          />
        ) : null}
        {series.map((s, si) => (
          <g key={s.key} style={vars(si)}>
            <path
              d={points
                .map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.values[s.key] ?? 0)}`)
                .join(' ')}
              fill="none"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              className="stroke-[var(--l)] dark:stroke-[var(--d)]"
            />
            {hover !== null ? (
              <circle
                cx={x(hover)}
                cy={y(points[hover]!.values[s.key] ?? 0)}
                r={4}
                strokeWidth={2}
                className="fill-[var(--l)] stroke-card dark:fill-[var(--d)]"
              />
            ) : null}
          </g>
        ))}
        {points.map((p, i) => (
          <rect
            key={p.key}
            x={x(i) - slot / 2}
            y={PAD.top}
            width={slot}
            height={innerH}
            fill="transparent"
            tabIndex={0}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            aria-label={`${p.long}: ${series.map((s) => `${s.label} ${format(p.values[s.key] ?? 0)}`).join(', ')}`}
          />
        ))}
      </svg>
      {hover !== null && points[hover] ? (
        <div
          role="tooltip"
          className="pointer-events-none absolute top-6 z-10 min-w-44 rounded-lg border bg-popover p-2.5 text-xs shadow-md"
          style={{ left: `clamp(0px, calc(${(x(hover) / W) * 100}% - 88px), calc(100% - 11rem))` }}
        >
          <p className="mb-1.5 font-semibold">{points[hover].long}</p>
          {series.map((s, i) => (
            <p key={s.key} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Swatch i={i} className="size-2" /> {s.label}
              </span>
              <span className="tabular-nums">{format(points[hover]!.values[s.key] ?? 0)}</span>
            </p>
          ))}
        </div>
      ) : null}
      <details className="mt-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">View as table</summary>
        <div className="mt-2 max-h-56 overflow-auto rounded-md border">
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-muted">
              <tr>
                <th className="px-2 py-1 font-medium">Period</th>
                {series.map((s) => (
                  <th key={s.key} className="px-2 py-1 text-right font-medium">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.key} className="border-t">
                  <td className="px-2 py-1">{p.long}</td>
                  {series.map((s) => (
                    <td key={s.key} className="px-2 py-1 text-right tabular-nums">
                      {format(p.values[s.key] ?? 0)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/**
 * Donut for part-to-whole with few parts, 2px surface gaps between segments, the total in
 * the middle and a legend that carries every value as text.
 */
export function Donut({
  parts,
  center,
  caption,
  ariaLabel,
}: {
  parts: { label: string; value: number }[];
  center: string;
  caption: string;
  ariaLabel: string;
}) {
  const total = parts.reduce((t, p) => t + p.value, 0);
  const r = 52;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="flex w-full flex-col items-center gap-5 sm:flex-row lg:flex-col xl:flex-row">
      <div className="relative size-40 shrink-0">
        <svg
          viewBox="0 0 140 140"
          className="size-full -rotate-90"
          role="img"
          aria-label={ariaLabel}
        >
          <circle cx="70" cy="70" r={r} fill="none" strokeWidth="18" className="stroke-muted" />
          {total > 0
            ? parts.map((p, i) => {
                const len = (p.value / total) * c;
                const gap = parts.filter((x) => x.value > 0).length > 1 ? Math.min(2, len / 2) : 0;
                const el = p.value ? (
                  <circle
                    key={p.label}
                    cx="70"
                    cy="70"
                    r={r}
                    fill="none"
                    strokeWidth="18"
                    strokeDasharray={`${Math.max(0, len - gap)} ${c}`}
                    strokeDashoffset={-offset}
                    className="stroke-[var(--l)] dark:stroke-[var(--d)]"
                    style={vars(i)}
                  />
                ) : null;
                offset += len;
                return el;
              })
            : null}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold tabular-nums">{center}</span>
          <span className="text-xs text-muted-foreground">{caption}</span>
        </div>
      </div>
      <ul className="w-full space-y-2.5 text-sm">
        {parts.map((p, i) => (
          <li key={p.label} className="flex items-center gap-2.5">
            <Swatch i={i} className="rounded-full" />
            <span className="flex-1 text-muted-foreground">{p.label}</span>
            <span className="font-semibold tabular-nums">{p.value.toLocaleString('en-IN')}</span>
            <span className="w-12 text-right text-xs text-muted-foreground tabular-nums">
              {total ? `${Math.round((p.value / total) * 100)}%` : '—'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Ranked horizontal bars (one series, single hue): label, bar, value printed as text. */
export function RankedBars({
  rows,
  format,
  ariaLabel,
  colorIndex = 0,
}: {
  rows: { key: string; label: string; value: number; note?: string }[];
  format: (v: number) => string;
  ariaLabel: string;
  colorIndex?: number;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-3" aria-label={ariaLabel}>
      {rows.map((r) => (
        <li key={r.key}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">
              {r.label}
              {r.note ? (
                <span className="ml-1.5 text-xs text-muted-foreground">{r.note}</span>
              ) : null}
            </span>
            <span className="shrink-0 font-semibold tabular-nums">{format(r.value)}</span>
          </div>
          <div className="h-2 rounded-full bg-muted" aria-hidden>
            <div
              className="h-2 rounded-full bg-[var(--l)] transition-[width] duration-500 dark:bg-[var(--d)]"
              style={{ ...vars(colorIndex), width: `${(r.value / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
