import {
  CORNER_RADIUS_MAX,
  DEFAULT_PREFS,
  cornerRadiusVars,
  normalizeCornerRadius,
  normalizeKiroSidecarTitlesPreference,
} from './prefs';

describe('DEFAULT_PREFS', () => {
  it('defaults singlePaneContentWidth to 800', () => {
    expect(DEFAULT_PREFS.singlePaneContentWidth).toBe(800);
  });

  it('has empty per-palette accent overrides by default', () => {
    expect(DEFAULT_PREFS.terminalAccentOverrides).toEqual({});
  });
});

describe('Kiro sidecar title preference', () => {
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
});
