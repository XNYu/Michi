import { DEFAULT_PREFS, normalizeKiroSidecarTitlesPreference } from './prefs';

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

  it('has compact density by default', () => {
    expect(DEFAULT_PREFS.terminalDensity).toBe('compact');
  });

  it('has pane hairline rules enabled by default', () => {
    expect(DEFAULT_PREFS.paneRules).toBe(true);
  });

  it('starts with the sidebar expanded (sidebarCollapsed = false)', () => {
    expect(DEFAULT_PREFS.sidebarCollapsed).toBe(false);
  });
});

describe('Kiro sidecar title preference', () => {
  it('is disabled by default', () => {
    expect(DEFAULT_PREFS.enableKiroSidecarTitles).toBe(false);
  });

  it('preserves booleans and rejects malformed persisted values', () => {
    expect(normalizeKiroSidecarTitlesPreference(true)).toBe(true);
    expect(normalizeKiroSidecarTitlesPreference(false)).toBe(false);
    expect(normalizeKiroSidecarTitlesPreference('false')).toBe(false);
    expect(normalizeKiroSidecarTitlesPreference(null)).toBe(false);
  });
});
