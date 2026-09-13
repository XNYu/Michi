import { useState } from 'react';
import { usePrefs, TerminalPalette } from '../../../../state/prefs';
import { Row as ClickableRow } from '../../primitives';
import { resolveAccent } from '../../tokens';
import { Row, Radio, Toggle } from './controls';
import { PANE_MOTION_OPTIONS, type PaneMotion } from '../../paneMotion';
import {
  SIDEBAR_ROW_STYLES,
  SIDEBAR_ROW_STYLE_LABELS,
} from '../../sidebarRowStyle';

export function AppearancePane() {
  const { prefs, setPref } = usePrefs();
  const currentAccent = resolveAccent(prefs.terminalAccentOverrides, prefs.terminalPalette);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const Swatch = ({
    c,
    label,
    value,
  }: {
    c: string;
    label: string;
    value: TerminalPalette;
  }) => {
    const sel = prefs.terminalPalette === value;
    return (
      <ClickableRow
        active={sel}
        onClick={() => {
          if (sel) {
            // Re-click on the active palette resets its accent override.
            const next = { ...prefs.terminalAccentOverrides };
            delete next[value];
            setPref('terminalAccentOverrides', next);
            return;
          }
          setPref('terminalPalette', value);
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          border: sel ? '1px solid var(--term-fg)' : '1px solid var(--term-line)',
          background: sel ? 'var(--term-alt)' : 'var(--term-surface)',
        }}
      >
        <span
          style={{
            width: 16,
            height: 16,
            background: c,
            border: '1px solid var(--term-line-s)',
          }}
        />
        <span
          style={{
            fontSize: 11,
            fontFamily: 'var(--ui-font)',
            color: sel ? 'var(--term-fg)' : 'var(--term-mid)',
          }}
        >
          {label}
        </span>
        {sel && (
          <span
            style={{
              color: 'var(--term-accent)',
              fontSize: 10,
              fontWeight: 700,
              marginLeft: 4,
            }}
          >
            ✓
          </span>
        )}
      </ClickableRow>
    );
  };

  return (
    <div>
      <h1
        style={{
          fontFamily: 'var(--ui-font)',
          fontSize: 15,
          fontWeight: 700,
          color: 'var(--term-fg)',
          margin: 0,
        }}
      >
        Appearance
      </h1>
      <div style={{ marginBottom: 20 }} />

      <Row k="theme.palette" label="Palette">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <Swatch c="#f6f5f1" label="bone" value="bone" />
          <Swatch c="#f3f4f6" label="slate" value="slate" />
          <Swatch c="#272822" label="monokai" value="monokai" />
          <Swatch c="#282828" label="gruvbox" value="gruvbox" />
        </div>
      </Row>

      {/* Glass material controls (Sidebar glass / blur / saturation / tint /
          depth + native Sidebar material) are intentionally hidden — the defaults
          in prefs.tsx are the tuned look. The prefs + effects still drive the
          glass; re-add these Rows to expose them again. */}

      {/* ── Threads per workspace (always visible) ─────────────────── */}

      <Row k="theme.sidebarThreadLimit" label="Threads per workspace">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="range"
            min={1}
            max={30}
            step={1}
            value={prefs.sidebarThreadLimit}
            onChange={(e) => setPref('sidebarThreadLimit', Number(e.target.value))}
            style={{ flex: 1, accentColor: 'var(--term-accent)' }}
          />
          <span style={{ fontSize: 11, color: 'var(--term-fg)', fontFamily: 'var(--ui-font)', minWidth: 38, textAlign: 'right' }}>
            {prefs.sidebarThreadLimit}
          </span>
        </div>
      </Row>

      <Row k="theme.focusDim" label="Focus dimming">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={prefs.focusDim}
            onChange={(e) => setPref('focusDim', Number(e.target.value))}
            style={{ flex: 1, accentColor: 'var(--term-accent)' }}
          />
          <span style={{ fontSize: 11, color: 'var(--term-fg)', fontFamily: 'var(--ui-font)', minWidth: 30, textAlign: 'right' }}>
            {prefs.focusDim}%
          </span>
        </div>
      </Row>

      <Row k="a11y.reduceMotion" label="Reduce motion">
        <Toggle
          on={prefs.reduceMotion}
          label="suppress animations (drawer slides, pane transitions)"
          onChange={(v) => setPref('reduceMotion', v)}
        />
      </Row>

      <Row k="theme.accent" label="Accent hue">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[
            ['#b8451f', 'rust'],
            ['#1a4d8f', 'ink'],
            ['#2f6b4e', 'moss'],
            ['#6d4aa8', 'violet'],
            ['#c48300', 'amber'],
            ['#a8261a', 'red'],
            ['#58c6a5', 'mint'],
            ['#10a37f', 'green'],
            ['#c15f3c', 'clay'],
            ['#00d9ff', 'cyan'],
            ['#ff2d95', 'pink'],
          ].map(([c, n]) => {
            const sel = currentAccent === c;
            return (
              <ClickableRow
                key={n}
                active={sel}
                onClick={() =>
                  setPref('terminalAccentOverrides', {
                    ...prefs.terminalAccentOverrides,
                    [prefs.terminalPalette]: c,
                  })
                }
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 8px',
                  border: sel ? '1px solid var(--term-fg)' : '1px solid var(--term-line)',
                  background: sel ? 'var(--term-alt)' : 'var(--term-surface)',
                }}
              >
                <span style={{ width: 14, height: 14, background: c }} />
                <span
                  style={{
                    fontFamily: 'var(--ui-font)',
                    fontSize: 10.5,
                    color: 'var(--term-mid)',
                  }}
                >
                  {n}
                </span>
              </ClickableRow>
            );
          })}
        </div>
      </Row>

      {/* ── Advanced (collapsed by default) ────────────────────────── */}

      <div style={{ marginTop: 20 }}>
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          aria-expanded={advancedOpen}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 0',
            border: 'none',
            background: 'transparent',
            color: 'var(--term-mid)',
            fontFamily: 'var(--ui-font)',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}
        >
          <span style={{ fontSize: 10, transition: 'transform 120ms ease', transform: advancedOpen ? 'rotate(90deg)' : 'rotate(0)' }}>▸</span>
          Advanced
        </button>

        {advancedOpen && (
          <div>
            <Row k="layout.paneWidthMode" label="Pane width mode">
              <select
                aria-label="Pane width mode"
                value={prefs.paneWidthMode}
                onChange={(e) => setPref('paneWidthMode', e.target.value as typeof prefs.paneWidthMode)}
                style={{
                  width: '100%', minWidth: 0, padding: '8px 10px', borderRadius: 4,
                  border: '1px solid var(--term-line)', background: 'var(--term-surface)',
                  color: 'var(--term-fg)', fontFamily: 'var(--ui-font)', fontSize: 12,
                }}
              >
                <option value="fixed">Fixed width (2+ panes)</option>
                <option value="half">Half viewport (2+ panes)</option>
                <option value="adaptive">Half at 2, fixed at 3+</option>
              </select>
            </Row>

            <Row k="motion.spawn" label="Pane animation">
              <select
                aria-label="Pane animation"
                value={prefs.paneSpawnAnimation}
                onChange={event => setPref('paneSpawnAnimation', event.target.value as PaneMotion)}
                style={{
                  maxWidth: '100%', padding: '5px 8px', border: '1px solid var(--term-line)',
                  background: 'var(--term-surface)', color: 'var(--term-fg)',
                  fontFamily: 'var(--ui-font)', fontSize: 11,
                }}
              >
                {PANE_MOTION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Row>

            <Row k="layout.paneWidth" label="Default pane width">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  aria-label="Default pane width"
                  type="range"
                  min={360}
                  max={1200}
                  step={20}
                  value={prefs.defaultPaneWidth}
                  onChange={(e) => setPref('defaultPaneWidth', Number(e.target.value))}
                  style={{ flex: 1, accentColor: 'var(--term-accent)' }}
                />
                <span style={{ fontSize: 11, color: 'var(--term-fg)', fontFamily: 'var(--ui-font)', minWidth: 42, textAlign: 'right' }}>
                  {prefs.defaultPaneWidth}px
                </span>
              </div>
            </Row>

            <Row k="layout.singlePaneWidth" label="Single-pane reading width">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  type="range"
                  min={480}
                  max={1280}
                  step={20}
                  value={prefs.singlePaneContentWidth ?? 800}
                  disabled={prefs.singlePaneContentWidth === null}
                  onChange={(e) => setPref('singlePaneContentWidth', Number(e.target.value))}
                  style={{
                    flex: 1,
                    accentColor: 'var(--term-accent)',
                    opacity: prefs.singlePaneContentWidth === null ? 0.4 : 1,
                  }}
                />
                <span
                  style={{
                    fontSize: 11, color: 'var(--term-fg)',
                    fontFamily: 'var(--ui-font)', minWidth: 56, textAlign: 'right',
                  }}
                >
                  {prefs.singlePaneContentWidth === null
                    ? 'full'
                    : `${prefs.singlePaneContentWidth}px`}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setPref(
                      'singlePaneContentWidth',
                      prefs.singlePaneContentWidth === null ? 800 : null,
                    )
                  }
                  style={{
                    padding: '4px 9px',
                    border: `1px solid ${prefs.singlePaneContentWidth === null ? 'var(--term-fg)' : 'var(--term-line)'}`,
                    background: prefs.singlePaneContentWidth === null ? 'var(--term-fg)' : 'transparent',
                    color: prefs.singlePaneContentWidth === null ? 'var(--term-surface)' : 'var(--term-mid)',
                    fontFamily: 'var(--ui-font)', fontSize: 11, cursor: 'pointer',
                  }}
                >
                  full width
                </button>
              </div>
            </Row>

            <Row k="theme.sidebarRowStyle" label="Sidebar row style">
              <Radio
                opts={[...SIDEBAR_ROW_STYLES]}
                value={prefs.sidebarRowStyle}
                onChange={(v) => setPref('sidebarRowStyle', v as any)}
              />
              <div
                style={{
                  marginTop: 8,
                  fontSize: 11,
                  lineHeight: 1.6,
                  color: 'var(--term-faint)',
                  fontFamily: 'var(--ui-font)',
                }}
              >
                {SIDEBAR_ROW_STYLE_LABELS[prefs.sidebarRowStyle]}
                <br />
                The three card modes share one text spine (20 / 36 / 52) and differ
                only in corner radius and fill width, so switching between them is a
                clean comparison of the corners. They pin their own edge padding —
                the slider below applies to <code>classic</code> only.
              </div>
            </Row>

            <Row k="theme.uiFont" label="Interface font">
              <Radio
                opts={['Geist', 'IBM Plex Sans', 'Inter']}
                value={prefs.uiFont}
                onChange={(v) => setPref('uiFont', v as typeof prefs.uiFont)}
              />
            </Row>

            <Row k="theme.messageFont" label="Message font">
              <Radio
                opts={['Source Serif 4', 'Geist']}
                value={prefs.messageFont}
                onChange={(v) => setPref('messageFont', v as typeof prefs.messageFont)}
              />
            </Row>

            <Row k="theme.messageFontSize" label="Message size">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  type="range"
                  min={12}
                  max={22}
                  step={0.5}
                  value={prefs.messageFontSize}
                  onChange={(e) => setPref('messageFontSize', Number(e.target.value))}
                  style={{ flex: 1, accentColor: 'var(--term-accent)' }}
                />
                <span style={{ fontSize: 11, color: 'var(--term-fg)', fontFamily: 'var(--ui-font)', minWidth: 38, textAlign: 'right' }}>
                  {prefs.messageFontSize}px
                </span>
              </div>
            </Row>

            <Row k="theme.composerFontSize" label="Composer size">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  type="range"
                  min={12}
                  max={22}
                  step={0.5}
                  value={prefs.composerFontSize}
                  onChange={(e) => setPref('composerFontSize', Number(e.target.value))}
                  style={{ flex: 1, accentColor: 'var(--term-accent)' }}
                />
                <span style={{ fontSize: 11, color: 'var(--term-fg)', fontFamily: 'var(--ui-font)', minWidth: 38, textAlign: 'right' }}>
                  {prefs.composerFontSize}px
                </span>
              </div>
            </Row>

            <Row k="theme.sidebarDensity" label="Sidebar density">
              <Radio
                opts={['compact', 'comfortable', 'airy']}
                value={prefs.sidebarDensity}
                onChange={(v) => setPref('sidebarDensity', v as any)}
              />
            </Row>

            <Row k="theme.sidebarInset" label="Sidebar edge padding">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  type="range"
                  min={0}
                  max={24}
                  step={1}
                  value={prefs.sidebarInset}
                  onChange={(e) => setPref('sidebarInset', Number(e.target.value))}
                  style={{ flex: 1, accentColor: 'var(--term-accent)' }}
                />
                <span style={{ fontSize: 11, color: 'var(--term-fg)', fontFamily: 'var(--ui-font)', minWidth: 38, textAlign: 'right' }}>
                  {prefs.sidebarInset}px
                </span>
              </div>
            </Row>

            <Row k="theme.sidebarTimestamps" label="Sidebar timestamps">
              <Toggle
                on={prefs.showSidebarTimestamps}
                label="show last-active time on thread rows"
                onChange={(v) => setPref('showSidebarTimestamps', v)}
              />
            </Row>

            <Row k="theme.codeWrap" label="Code wrap">
              <Toggle
                on={prefs.codeWrap}
                label="wrap long lines instead of horizontal scroll"
                onChange={(v) => setPref('codeWrap', v)}
              />
            </Row>

            <Row k="theme.rules" label="Chrome rules">
              <Toggle
                on={prefs.paneRules}
                label="hairline rules between panes"
                onChange={(v) => setPref('paneRules', v)}
              />
            </Row>
          </div>
        )}
      </div>
    </div>
  );
}
