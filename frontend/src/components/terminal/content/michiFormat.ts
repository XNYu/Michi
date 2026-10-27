import type { MichiThreadState } from 'michi-shared';

export function michiStateLabel(state: MichiThreadState, doneBy?: 'user' | 'agent'): string {
  switch (state) {
    case 'waiting': return 'Waiting on you';
    case 'doing': return 'In progress';
    case 'stalled': return 'Stalled';
    case 'done': return doneBy === 'agent' ? 'Agent says done' : 'Done';
    case 'idea': return 'Chatted only';
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Compact age for row trailers: `now`, `40m`, `3h`, `2d`, `2w`. */
export function formatMichiAge(ts: number | null, now: number = Date.now()): string {
  if (ts == null) return '';
  const elapsed = Math.max(0, now - ts);
  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < WEEK) return `${Math.floor(elapsed / DAY)}d`;
  return `${Math.floor(elapsed / WEEK)}w`;
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number) => String(n).padStart(2, '0');

/** `Oct 16, 21:40` in local time, 24-hour clock. */
export function formatMichiClock(ts: number): string {
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
