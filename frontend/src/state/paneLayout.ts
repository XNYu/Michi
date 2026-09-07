export type PaneWidthMode = 'fixed' | 'half' | 'adaptive';

export function normalizePaneWidthMode(value: unknown): PaneWidthMode {
  return value === 'fixed' || value === 'adaptive' ? value : 'half';
}

export interface PaneLayoutInput {
  viewportWidth: number;
  paneCount: number;
  defaultPaneWidth: number;
  mode?: PaneWidthMode;
  customWidths?: readonly (number | undefined)[];
  gap?: number;
  padding?: number;
}

/** Shared by the body and caption strips; viewportWidth never includes the sidebar. */
export function resolvePaneLayout({
  viewportWidth, paneCount, defaultPaneWidth, mode = 'adaptive',
  customWidths = [], gap = 0, padding = 0,
}: PaneLayoutInput) {
  const available = Math.max(0, viewportWidth - padding * 2);
  const half = Math.max(0, (available - gap) / 2);
  const fixed = Math.min(available, defaultPaneWidth);
  const defaultWidth = paneCount === 1
    ? available
    : mode === 'half' || (mode === 'adaptive' && paneCount === 2) ? half : fixed;
  const widths = Array.from({ length: paneCount }, (_, i) => {
    const custom = customWidths[i];
    return typeof custom === 'number' && Number.isFinite(custom) && custom > 0
      ? Math.min(custom, available)
      : defaultWidth;
  });
  const contentWidth = widths.reduce((sum, width) => sum + width, 0)
    + Math.max(0, paneCount - 1) * gap;
  const overflow = contentWidth > available + 0.5;
  // The same trailing room lets both strips center their last pane without drifting.
  const paddingRight = padding + (overflow ? Math.max(0, (available - (widths.at(-1) ?? 0)) / 2) : 0);
  return {
    widths,
    overflow,
    paddingRight,
    gridTemplateColumns: widths.length ? widths.map(width => `${width}px`).join(' ') : 'none',
  };
}
