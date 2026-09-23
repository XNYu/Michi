import {
  CORNER_RADIUS_MAX,
  DEFAULT_PREFS,
  cornerRadiusVars,
  normalizeCornerRadius,
  normalizeKiroSidecarTitlesPreference,
} from './prefs';

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

describe('Corner radius preference', () => {
  it('defaults to the tuned 4px menu radius', () => {
    expect(DEFAULT_PREFS.cornerRadius).toBe(4);
    expect(cornerRadiusVars(DEFAULT_PREFS.cornerRadius)).toEqual({ '--ui-radius': '4px', '--ui-radius-sm': '2px' });
  });

  it('clamps and rounds persisted values, falling back on malformed ones', () => {
    expect(normalizeCornerRadius(-3)).toBe(0);
    expect(normalizeCornerRadius(99)).toBe(CORNER_RADIUS_MAX);
    expect(normalizeCornerRadius(6.6)).toBe(7);
    expect(normalizeCornerRadius('8')).toBe(DEFAULT_PREFS.cornerRadius);
    expect(normalizeCornerRadius(Number.NaN)).toBe(DEFAULT_PREFS.cornerRadius);
  });

  it('derives the nested radius as half the surface radius', () => {
    expect(cornerRadiusVars(0)).toEqual({ '--ui-radius': '0px', '--ui-radius-sm': '0px' });
    expect(cornerRadiusVars(9)).toEqual({ '--ui-radius': '9px', '--ui-radius-sm': '5px' });
    expect(cornerRadiusVars(12)).toEqual({ '--ui-radius': '12px', '--ui-radius-sm': '6px' });
  });
});
