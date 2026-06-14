/**
 * Compact relative-time string for UI labels: "now", "Nm", "Nh",
 * "yesterday", "Nd", "Nw". Clamps future timestamps to "now".
 */
export function relativeTime(updatedAt: number, now: number = Date.now()): string {
  const deltaMs = now - updatedAt;
  if (deltaMs < 30_000) return 'now';
  const min = Math.floor(deltaMs / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(deltaMs / (60 * 60_000));
  if (hr < 24) return `${hr}h`;
  if (hr < 48) return 'yesterday';
  const day = Math.floor(deltaMs / (24 * 60 * 60_000));
  if (day < 7) return `${day}d`;
  const wk = Math.floor(day / 7);
  return `${wk}w`;
}
