import { DEFAULT_PREFS } from './prefs';

describe('DEFAULT_PREFS', () => {
  it('has bone as default terminal palette', () => {
    expect(DEFAULT_PREFS.terminalPalette).toBe('bone');
  });

  it('defaults singlePaneContentWidth to 800', () => {
    expect(DEFAULT_PREFS.singlePaneContentWidth).toBe(800);
  });

  it('has empty per-palette accent overrides by default', () => {
    expect(DEFAULT_PREFS.terminalAccentOverrides).toEqual({});
  });

  it('has dense density by default', () => {
    expect(DEFAULT_PREFS.terminalDensity).toBe('dense');
  });

  it('has pane hairline rules enabled by default', () => {
    expect(DEFAULT_PREFS.paneRules).toBe(true);
  });

  it('starts with the sidebar expanded (sidebarCollapsed = false)', () => {
    expect(DEFAULT_PREFS.sidebarCollapsed).toBe(false);
  });
});
