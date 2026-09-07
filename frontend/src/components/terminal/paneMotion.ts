export const PANE_ENTER_MS = 220;
export const PANE_EXIT_MS = 160;
export const PANE_STAGGER_MS = 30;
export const PANE_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

/** Reveal populated content, never a white wrapper behind transparent text. */
export function paneEntrance(mode: string | undefined): { frames: Keyframe[]; duration: number } {
  const offset = mode === 'fission' ? 'translateX(-12px)'
    : mode === 'thread-pull' ? 'translateX(16px)'
    : mode === 'gentle-glide' ? 'translateY(8px)'
    : mode === 'frozen-retract' ? 'translateY(-6px)'
    : mode === 'soft-fade' ? 'translateX(0px)' : 'translateY(4px)';
  return {
    frames: [{ opacity: 1, transform: offset }, { opacity: 1, transform: 'translate(0px, 0px)' }],
    duration: mode === 'soft-fade' ? 150 : mode === 'gentle-glide' ? 180 : PANE_ENTER_MS,
  };
}

export const PANE_MOTION_OPTIONS = [
  ['soft-fade', 'Soft Fade'],
  ['gentle-glide', 'Gentle Glide'],
  ['frozen-retract', 'Frozen Retract'],
  ['phosphor', 'Phosphor Bloom'],
  ['fission', 'Fission'],
  ['thread-pull', 'Thread Pull'],
] as const;
export type PaneMotion = typeof PANE_MOTION_OPTIONS[number][0];

export function normalizePaneMotion(value: unknown): PaneMotion {
  return PANE_MOTION_OPTIONS.some(([mode]) => mode === value) ? value as PaneMotion : 'phosphor';
}

export function paneMotionTiming(mode: string | undefined) {
  switch (mode) {
    case 'soft-fade': return { enter: 150, exit: 110, exitLayout: 180, exitDelay: 110, retention: 290 };
    case 'gentle-glide': return { enter: 180, exit: 130, exitLayout: 180, exitDelay: 0, retention: 180 };
    case 'frozen-retract': return { enter: 220, exit: 180, exitLayout: 180, exitDelay: 0, retention: 180 };
    default: return { enter: PANE_ENTER_MS, exit: PANE_EXIT_MS, exitLayout: PANE_EXIT_MS, exitDelay: 0, retention: PANE_EXIT_MS };
  }
}

export function isQuietPaneMotion(mode: string | undefined) {
  return mode === 'soft-fade' || mode === 'gentle-glide' || mode === 'frozen-retract';
}

export function paneMotionName(mode: string | undefined, exiting = false) {
  const prefix = exiting ? 'tDecay' : 'tSpawn';
  if (mode === 'soft-fade') return `${prefix}SoftFade`;
  if (mode === 'gentle-glide') return `${prefix}GentleGlide`;
  if (mode === 'frozen-retract') return `${prefix}FrozenRetract`;
  return `${prefix}${mode === 'fission' ? 'Fission' : mode === 'thread-pull' ? 'ThreadPull' : ''}`;
}
