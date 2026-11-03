import { useState } from 'react';

/** How long after creation an item still counts as new. */
export const FRESH_MS = 1000;

/**
 * Whether an item is new enough to play its entrance. Decided once, on the
 * first render: hydrated, lazily loaded, older-history and remounted items
 * render settled (`initial={false}`) instead of replaying their entrance.
 */
export function isFresh(createdAt: number | undefined, now = Date.now(), windowMs = FRESH_MS): boolean {
  return createdAt !== undefined && now - createdAt >= 0 && now - createdAt < windowMs;
}

export function useFresh(createdAt: number | undefined, windowMs = FRESH_MS): boolean {
  const [fresh] = useState(() => isFresh(createdAt, Date.now(), windowMs));
  return fresh;
}
