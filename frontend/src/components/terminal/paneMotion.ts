export const PANE_ENTER_MS = 220;
export const PANE_EXIT_MS = 160;
export const PANE_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

/**
 * How a new pane's content settles inside its entry surface while the pane
 * track slides it in. Reveal populated content, never a white wrapper behind
 * transparent text: every preset moves, none fades.
 *
 * The default (`soft-fade`) drifts the content in from the side the pane
 * arrives on (`from`: right of the pane the user was on, or left of it). A
 * new branch is pulled out of its parent, so under the default it travels the
 * thread-pull distance instead. Chosen presets keep their own direction.
 */
export function paneEntrance(
  mode: string | undefined,
  { branch = false, from = 'right' }: { branch?: boolean; from?: 'left' | 'right' } = {},
): { frames: Keyframe[]; duration: number } {
  const softBranch = mode === 'soft-fade' && branch;
  const side = from === 'left' ? -1 : 1;
  const offset = mode === 'fission' ? 'translateX(-12px)'
    : mode === 'thread-pull' ? 'translateX(16px)'
    : softBranch ? `translateX(${16 * side}px)`
    : mode === 'gentle-glide' ? 'translateY(8px)'
    : mode === 'frozen-retract' ? 'translateY(-6px)'
    : mode === 'soft-fade' ? `translateX(${8 * side}px)` : 'translateY(4px)';
  return {
    frames: [{ opacity: 1, transform: offset }, { opacity: 1, transform: 'translate(0px, 0px)' }],
    duration: softBranch ? PANE_ENTER_MS : paneMotionTiming(mode).enter,
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
    case 'soft-fade': return { enter: 180, exit: 110, exitLayout: 180, exitDelay: 110, retention: 290 };
    case 'gentle-glide': return { enter: 180, exit: 130, exitLayout: 180, exitDelay: 0, retention: 180 };
    case 'frozen-retract': return { enter: 220, exit: 180, exitLayout: 180, exitDelay: 0, retention: 180 };
    default: return { enter: PANE_ENTER_MS, exit: PANE_EXIT_MS, exitLayout: PANE_EXIT_MS, exitDelay: 0, retention: PANE_EXIT_MS };
  }
}
