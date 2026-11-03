/**
 * Chromium features Michi switches off, merged into `--disable-features`
 * before the app is ready (a repeated switch would replace the earlier one).
 *
 * VSync-aligned presentation (macOS, on by default): Chromium holds frames
 * that handle interaction until the next DisplayLink callback, and sometimes
 * presents one without its backdrop-filter layers, so ⌘K, menus and modals
 * lose their glass for a frame, over and over. Turning it off stopped the
 * same single-frame flashes in another Electron app (pingdotgg/t3code#25552).
 * Chromium 146 (Electron 41) calls it VSyncAlignedPresent; Chromium 152
 * renamed it VSyncAlignedPresentationForScrolling. Both are listed: Chromium
 * ignores names it doesn't know, so an Electron upgrade keeps it off. A
 * workaround, not a fix, and the flag may go away.
 * MICHI_KEEP_VSYNC_PRESENTATION=1 keeps Chromium's default, to compare.
 */
export const GLASS_FLICKER_FEATURES = ['VSyncAlignedPresent', 'VSyncAlignedPresentationForScrolling'] as const;

export function michiDisabledFeatures(platform: string, env: Record<string, string | undefined>): string[] {
  if (platform !== 'darwin' || env.MICHI_KEEP_VSYNC_PRESENTATION === '1') return [];
  return [...GLASS_FLICKER_FEATURES];
}

/** `existing` (a `--disable-features` value, possibly empty) plus `add`, without duplicates. */
export function mergeFeatureList(existing: string, add: readonly string[]): string {
  const features = existing.split(',').map((feature) => feature.trim()).filter(Boolean);
  for (const feature of add) if (!features.includes(feature)) features.push(feature);
  return features.join(',');
}
