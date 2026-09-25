import { describe, expect, it } from 'vitest';
import { normalizePaneWidthMode, resolvePaneLayout, type PaneWidthMode } from './paneLayout';

const layout = (mode: PaneWidthMode, paneCount: number) => resolvePaneLayout({
  mode, paneCount, viewportWidth: 1200, defaultPaneWidth: 800,
});

describe('pane width modes', () => {
  it.each(['fixed', 'half', 'adaptive'] as const)('%s fills the viewport with one pane', mode => {
    expect(layout(mode, 1).widths).toEqual([1200]);
    expect(layout(mode, 1).overflow).toBe(false);
  });

  it.each([
    ['fixed', 2, [800, 800], true],
    ['fixed', 3, [800, 800, 800], true],
    ['fixed', 4, [800, 800, 800, 800], true],
    ['half', 2, [600, 600], false],
    ['half', 3, [600, 600, 600], true],
    ['half', 4, [600, 600, 600, 600], true],
    ['adaptive', 2, [600, 600], false],
    ['adaptive', 3, [800, 800, 800], true],
    ['adaptive', 4, [800, 800, 800, 800], true],
  ] as const)('%s at %i panes', (mode, count, widths, overflow) => {
    expect(layout(mode, count).widths).toEqual(widths);
    expect(layout(mode, count).overflow).toBe(overflow);
  });

  it.each(['fixed', 'half', 'adaptive'] as const)('preserves individual overrides in %s', mode => {
    expect(resolvePaneLayout({ mode, paneCount: 3, viewportWidth: 1200, defaultPaneWidth: 800, customWidths: [720, undefined, 450] }).widths)
      .toEqual([720, mode === 'half' ? 600 : 800, 450]);
  });

  it('adds only enough trailing space to center the last overflowing pane', () => {
    expect(layout('fixed', 2).paddingRight).toBe(200);
    expect(layout('half', 3).paddingRight).toBe(300);
    expect(layout('half', 2).paddingRight).toBe(0);
  });

  it('ignores invalid custom widths and handles an empty or unmeasured strip', () => {
    expect(resolvePaneLayout({ mode: 'fixed', paneCount: 3, viewportWidth: 1200, defaultPaneWidth: 800, customWidths: [NaN, -2, Infinity] }).widths).toEqual([800, 800, 800]);
    expect(resolvePaneLayout({ paneCount: 0, viewportWidth: 0, defaultPaneWidth: 800 })).toMatchObject({ widths: [], gridTemplateColumns: 'none', overflow: false, paddingRight: 0 });
  });

  it.each([undefined, null, '', 'unknown', 1, {}])('normalizes legacy or invalid value %s to half', value => {
    expect(normalizePaneWidthMode(value)).toBe('half');
  });
});
