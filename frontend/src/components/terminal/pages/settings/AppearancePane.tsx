import { usePrefs, TerminalPalette, CodeBlockStyle, AgentBlockStyle } from '../../../../state/prefs';
import { Row as ClickableRow } from '../../primitives';
import { resolveAccent } from '../../tokens';
import { Row, Radio, Toggle } from './controls';

const CODE_BLOCK_OPTIONS: Array<{ value: CodeBlockStyle; label: string; desc: string }> = [
  {
    value: 'hairline',
    label: 'Hairline',
    desc: 'No header bar - language sits as a faint mono overline, copy reveals on hover. Quietest.',
  },
  {
    value: 'header',
    label: 'Header rule',
    desc: 'A divider bar carrying a lowercase language label. Classic terminal.',
  },
];

const AGENT_BLOCK_OPTIONS: Array<{ value: AgentBlockStyle; label: string; desc: string }> = [
  {
    value: 'plain',
    label: 'Plain',
    desc: 'Bare text rows with ▸/▾ glyphs and status dots. The original treatment.',
  },
  {
    value: 'card',
    label: 'Card',
    desc: 'Hairline cards with tool-type icons and a right-hand status column (✓ / spinner / failed).',
  },
  {
    value: 'terminal',
    label: 'Terminal',
    desc: 'Bare text with ❯ / ✓ / × glyph columns, caps section headers, and dotted leaders.',
  },
];

export function AppearancePane() {
  const { prefs, setPref } = usePrefs();
  const currentAccent = resolveAccent(prefs.terminalAccentOverrides, prefs.terminalPalette);

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

      {/* Glass material controls (Sidebar glass / blur / saturation / tint /
          depth + native Sidebar material) are intentionally hidden — the defaults
          in prefs.tsx are the tuned look. The prefs + effects still drive the
          glass; re-add these Rows to expose them again. */}

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

      <Row k="theme.codeBlock" label="Code block">
        <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--term-line)' }}>
          {CODE_BLOCK_OPTIONS.map((o, i) => {
            const sel = prefs.codeBlockStyle === o.value;
            return (
              <ClickableRow
                key={o.value}
                active={sel}
                onClick={() => setPref('codeBlockStyle', o.value)}
                style={{
                  padding: '8px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  background: sel ? 'var(--term-alt)' : 'var(--term-surface)',
                  borderBottom: i < CODE_BLOCK_OPTIONS.length - 1 ? '1px solid var(--term-line)' : 'none',
                }}
              >
                <span
                  style={{
                    width: 12,
                    height: 12,
                    border: `1px solid ${sel ? 'var(--term-accent)' : 'var(--term-line-s)'}`,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'var(--term-surface-glass)',
                    flexShrink: 0,
                  }}
                >
                  {sel && <span style={{ width: 6, height: 6, background: 'var(--term-accent)' }} />}
                </span>
                <div>
                  <span
                    style={{
                      fontSize: 11.5,
                      fontFamily: 'var(--ui-font)',
                      color: sel ? 'var(--term-fg)' : 'var(--term-mid)',
                      fontWeight: sel ? 600 : 400,
                    }}
                  >
                    {o.label}
                  </span>
                  <div style={{ fontSize: 10.5, color: 'var(--term-muted)', marginTop: 2, lineHeight: 1.45 }}>
                    {o.desc}
                  </div>
                </div>
              </ClickableRow>
            );
          })}
        </div>
      </Row>

      <Row k="theme.agentBlocks" label="Agent blocks">
        <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--term-line)' }}>
          {AGENT_BLOCK_OPTIONS.map((o, i) => {
            const sel = prefs.agentBlockStyle === o.value;
            return (
              <ClickableRow
                key={o.value}
                active={sel}
                onClick={() => setPref('agentBlockStyle', o.value)}
                style={{
                  padding: '8px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  background: sel ? 'var(--term-alt)' : 'var(--term-surface)',
                  borderBottom: i < AGENT_BLOCK_OPTIONS.length - 1 ? '1px solid var(--term-line)' : 'none',
                }}
              >
                <span
                  style={{
                    width: 12,
                    height: 12,
                    border: `1px solid ${sel ? 'var(--term-accent)' : 'var(--term-line-s)'}`,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'var(--term-surface-glass)',
                    flexShrink: 0,
                  }}
                >
                  {sel && <span style={{ width: 6, height: 6, background: 'var(--term-accent)' }} />}
                </span>
                <div>
                  <span
                    style={{
                      fontSize: 11.5,
                      fontFamily: 'var(--ui-font)',
                      color: sel ? 'var(--term-fg)' : 'var(--term-mid)',
                      fontWeight: sel ? 600 : 400,
                    }}
                  >
                    {o.label}
                  </span>
                  <div style={{ fontSize: 10.5, color: 'var(--term-muted)', marginTop: 2, lineHeight: 1.45 }}>
                    {o.desc}
                  </div>
                </div>
              </ClickableRow>
            );
          })}
        </div>
      </Row>

      <Row k="theme.codeWrap" label="Code wrap">
        <Toggle
          on={prefs.codeWrap}
          label="wrap long lines instead of horizontal scroll"
          onChange={(v) => setPref('codeWrap', v)}
        />
      </Row>

      <Row k="theme.density" label="Density">
        <Radio
          opts={['comfortable', 'compact', 'dense']}
          value={prefs.terminalDensity}
          onChange={(v) => setPref('terminalDensity', v as any)}
        />
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

      {import.meta.env.DEV && (
        <Row k="theme.paneTopFade" label="Pane top fade">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="range"
              min={0}
              max={60}
              step={2}
              value={prefs.paneTopFadeHeight}
              onChange={(e) => setPref('paneTopFadeHeight', Number(e.target.value))}
              style={{ flex: 1, accentColor: 'var(--term-accent)' }}
            />
            <span style={{ fontSize: 11, color: 'var(--term-fg)', fontFamily: 'var(--ui-font)', minWidth: 38, textAlign: 'right' }}>
              {prefs.paneTopFadeHeight}px
            </span>
          </div>
        </Row>
      )}

      <Row k="layout.paneWidth" label="Default pane width">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
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

      <Row k="theme.rules" label="Chrome rules">
        <Toggle
          on={prefs.paneRules}
          label="hairline rules between panes"
          onChange={(v) => setPref('paneRules', v)}
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
    </div>
  );
}
