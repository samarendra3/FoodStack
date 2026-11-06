import { BadRequestException } from '@nestjs/common';
import type { Preset } from './analytics.schemas';

export const MAX_DAYS = 366;

export type Granularity = 'hour' | 'day' | 'month';

/** A resolved period in local calendar dates (inclusive), plus its comparison period. */
export interface LocalRange {
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  /** Days in the current period (inclusive). */
  days: number;
  /**
   * True when the period ends today: both periods are then cut at the same elapsed time
   * ("today so far" vs "yesterday until this time"), so a partial day is never compared
   * with a full one.
   */
  partial: boolean;
  granularity: Granularity;
}

const DAY = 86_400_000;
const parse = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => fmt(parse(d) + n * DAY);
const span = (from: string, to: string) => Math.round((parse(to) - parse(from)) / DAY) + 1;
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const shiftMonths = (d: string, n: number) => {
  const x = new Date(parse(d));
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + n);
  return fmt(x.getTime());
};
const lastOfMonth = (d: string) => addDays(shiftMonths(monthStart(d), 1), -1);
const min = (a: string, b: string) => (a < b ? a : b);

/** Today's calendar date in `timeZone` (IANA), e.g. Asia/Kolkata. */
export function localToday(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function granularityFor(days: number): Granularity {
  if (days <= 2) return 'hour';
  if (days <= 92) return 'day';
  return 'month';
}

/**
 * Resolves a preset (or custom dates) against `today` in the restaurant's timezone. Months and
 * years compare with the same span of the previous month/year; other periods with the same
 * number of days immediately before.
 */
export function resolveRange(
  preset: Preset,
  today: string,
  custom?: { from?: string; to?: string },
): LocalRange {
  let from: string;
  let to: string;
  let prevFrom: string;
  let prevTo: string;
  switch (preset) {
    case 'today':
      from = to = today;
      prevFrom = prevTo = addDays(today, -1);
      break;
    case 'yesterday':
      from = to = addDays(today, -1);
      prevFrom = prevTo = addDays(today, -2);
      break;
    case 'last7':
    case 'last30': {
      const n = preset === 'last7' ? 7 : 30;
      from = addDays(today, -(n - 1));
      to = today;
      prevTo = addDays(from, -1);
      prevFrom = addDays(from, -n);
      break;
    }
    case 'thisMonth': {
      from = monthStart(today);
      to = today;
      prevFrom = shiftMonths(from, -1);
      prevTo = min(addDays(prevFrom, span(from, to) - 1), lastOfMonth(prevFrom));
      break;
    }
    case 'lastMonth': {
      from = shiftMonths(monthStart(today), -1);
      to = lastOfMonth(from);
      prevFrom = shiftMonths(from, -1);
      prevTo = lastOfMonth(prevFrom);
      break;
    }
    case 'thisYear': {
      from = `${today.slice(0, 4)}-01-01`;
      to = today;
      prevFrom = `${Number(today.slice(0, 4)) - 1}-01-01`;
      prevTo = min(addDays(prevFrom, span(from, to) - 1), `${Number(today.slice(0, 4)) - 1}-12-31`);
      break;
    }
    case 'custom': {
      if (!custom?.from || !custom.to) {
        throw new BadRequestException({ code: 'BAD_RANGE', message: 'Pick a start and end date.' });
      }
      if (custom.from > custom.to) {
        throw new BadRequestException({
          code: 'BAD_RANGE',
          message: '“From” must be before “To”.',
        });
      }
      if (custom.from > today) {
        throw new BadRequestException({
          code: 'BAD_RANGE',
          message: 'The range starts in the future.',
        });
      }
      from = custom.from;
      to = min(custom.to, today);
      const n = span(from, to);
      if (n > MAX_DAYS) {
        throw new BadRequestException({
          code: 'RANGE_TOO_LONG',
          message: 'Pick at most one year.',
        });
      }
      prevTo = addDays(from, -1);
      prevFrom = addDays(from, -n);
      break;
    }
  }
  const days = span(from, to);
  return {
    from,
    to,
    prevFrom,
    prevTo,
    days,
    partial: to === today,
    granularity: granularityFor(days),
  };
}
