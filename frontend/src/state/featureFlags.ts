/**
 * Build-time feature flags. Read from Vite's import.meta.env so flipping
 * a flag requires a fresh `npm run frontend:build` — there's no runtime
 * toggle. The Dockerfile passes these via ENV at builder stage; local
 * dev defaults to the values below.
 *
 * Truthy values: '1', 'true', 'yes', 'on' (case-insensitive).
 */

function readFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === '') return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Profile page (design-system port). Default off; on for Docker / Railway. */
export const PROFILE_PAGE_ENABLED = readFlag(
  import.meta.env.VITE_MICHI_PROFILE_PAGE,
  false,
);
