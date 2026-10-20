import type { DeskThreadState } from 'michi-shared';

export function shortAge(at: number | null, now: number): string {
  if (at == null) return '';
  const minutes = Math.floor(Math.max(0, now - at) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function deskDateLine(now: number, since: number): string {
  const date = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(now).toUpperCase();
  if (since <= 0) return date;
  const age = shortAge(since, now);
  const looked = age === 'now' ? 'JUST NOW' : `${age.toUpperCase()} AGO`;
  return `${date} · LAST LOOKED ${looked}`;
}

export function stateLabel(state: DeskThreadState): string {
  switch (state) {
    case 'waiting': return 'Waiting on you';
    case 'doing': return 'In progress';
    case 'stalled': return 'Stalled';
    case 'done': return 'Done';
    case 'idea': return 'Chatted';
  }
}

export function dayKey(at: number | null): string {
  if (at == null) return 'Undated';
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export function dayLabel(key: string): string {
  if (key === 'Undated') return 'Undated';
  const [year, month, day] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(year, month - 1, day));
}
