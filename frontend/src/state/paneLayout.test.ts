import { describe, expect, it } from 'vitest';
import { resolvePaneLayout } from './paneLayout';

describe('pane width modes', () => {
  it('ignores invalid custom widths and handles an empty or unmeasured strip', () => {
    expect(resolvePaneLayout({ mode: 'fixed', paneCount: 3, viewportWidth: 1200, defaultPaneWidth: 800, customWidths: [NaN, -2, Infinity] }).widths).toEqual([800, 800, 800]);
    expect(resolvePaneLayout({ paneCount: 0, viewportWidth: 0, defaultPaneWidth: 800 })).toMatchObject({ widths: [], gridTemplateColumns: 'none', overflow: false, paddingRight: 0 });
  });
});
