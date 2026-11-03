import { CHANNEL_LABEL } from '@/lib/promotions';

const dt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** One-line summary of when and where a promotion applies. */
export function scheduleText(p: {
  startsAt: string | null;
  endsAt: string | null;
  daysOfWeek: number[] | null;
  timeFrom: string | null;
  timeTo: string | null;
  channels: string[];
}) {
  const parts: string[] = [];
  if (p.startsAt || p.endsAt) {
    parts.push(
      `${p.startsAt ? dt.format(new Date(p.startsAt)) : 'Now'} → ${p.endsAt ? dt.format(new Date(p.endsAt)) : 'no end'}`,
    );
  } else parts.push('Always on');
  if (p.daysOfWeek?.length) parts.push(p.daysOfWeek.map((d) => DAYS[d]).join(', '));
  if (p.timeFrom && p.timeTo) parts.push(`${p.timeFrom}–${p.timeTo}`);
  if (p.channels.length) {
    parts.push(p.channels.map((c) => CHANNEL_LABEL[c as keyof typeof CHANNEL_LABEL]).join(', '));
  }
  return parts.join(' · ');
}
