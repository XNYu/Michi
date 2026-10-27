import { MONTHS, formatMichiAge } from '../michiFormat';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Home's eyebrow: `Tue, Oct 20 · last looked 3h ago` (the caption style
 * uppercases it). The last-looked part is left off until Home has been left
 * once.
 */
export function michiHomeEyebrow(now: number, homeSince: number | null): string {
  const d = new Date(now);
  const date = `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  if (homeSince == null) return date;
  const age = formatMichiAge(homeSince, now);
  return `${date} · last looked ${age === 'now' ? 'just now' : `${age} ago`}`;
}
