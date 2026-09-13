import { useSyncExternalStore } from 'react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(notify: () => void) {
  const mq = window.matchMedia?.(REDUCED_MOTION_QUERY);
  mq?.addEventListener('change', notify);
  return () => mq?.removeEventListener('change', notify);
}

function getSnapshot() {
  return window.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false;
}

function getServerSnapshot() {
  return false;
}

/**
 * Returns `true` when motion should be suppressed — either because the OS
 * reports `prefers-reduced-motion: reduce` or the user toggled the app-level
 * "Reduce motion" preference.
 *
 * Standalone (no prefs argument): reads only the OS media query.
 * With `appReduceMotion` from the caller's prefs: combines both signals.
 */
export function useReducedMotion(appReduceMotion?: boolean): boolean {
  const os = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return os || (appReduceMotion === true);
}

/**
 * One-shot check for non-hook call sites (event handlers, layout effects
 * that run once). Combines OS + app pref when the latter is passed.
 */
export function prefersReducedMotion(appReduceMotion?: boolean): boolean {
  const os = window.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false;
  return os || (appReduceMotion === true);
}
