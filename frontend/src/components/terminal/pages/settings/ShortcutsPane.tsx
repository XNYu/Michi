import { kbd } from '../../../../lib/platform';

type Binding = { keys: string; label: string };
type Group = { title: string; bindings: Binding[] };

const SHORTCUT_GROUPS: Group[] = [
  {
    title: 'Navigation (terminal)',
    bindings: [
      { keys: kbd('mod', 'K'), label: 'Open command palette' },
      { keys: kbd('mod', '1'), label: 'Dashboard page' },
      { keys: kbd('mod', 'M'), label: 'Map page' },
      { keys: kbd('mod', 'D'), label: 'Digest page' },
      { keys: kbd('mod', 'O'), label: 'Workspaces page' },
      { keys: kbd('mod', ','), label: 'Settings page' },
    ],
  },
  {
    title: 'Panes',
    bindings: [
      { keys: kbd('mod', 'W'), label: 'Close focused pane' },
      { keys: kbd('mod', 'T'), label: 'New thread (tree root in current workspace)' },
      { keys: kbd('mod', 'alt', 'T'), label: 'New blank branch from focused pane' },
      { keys: kbd('mod', '\\'), label: 'Open next chat not yet in a pane' },
      { keys: kbd('mod', '1–9'), label: 'Focus pane by tab index' },
      { keys: kbd('ctrl', 'Tab'), label: 'Cycle to next pane (works while typing)' },
      { keys: kbd('ctrl', 'shift', 'Tab'), label: 'Cycle to previous pane' },
    ],
  },
  {
    title: 'Composer',
    bindings: [
      { keys: kbd('enter'), label: 'Send message' },
      { keys: kbd('mod', 'enter'), label: 'Branch — send as a new child chat' },
      { keys: '/fanout a; b; c', label: 'Fan out into N sibling branches' },
      { keys: '/btw <msg>', label: `Branch with this message (alias of ${kbd('mod', 'enter')})` },
    ],
  },
  {
    title: 'Command palette',
    bindings: [
      { keys: '↑ ↓', label: 'Move highlight' },
      { keys: kbd('enter'), label: 'Run selected command' },
      { keys: 'esc', label: 'Close palette' },
    ],
  },
];

export function ShortcutsPane() {
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
        Shortcuts
      </h1>
      <div style={{ marginBottom: 20 }} />

      {SHORTCUT_GROUPS.map((g) => (
        <div key={g.title} style={{ marginBottom: 22 }}>
          <div
            style={{
              fontSize: 10,
              color: 'var(--term-muted)',
              letterSpacing: '.14em',
              marginBottom: 8,
              fontFamily: 'var(--ui-font)',
            }}
          >
            ▸ {g.title.toUpperCase()}
          </div>
          <div style={{ border: '1px solid var(--term-line)', background: 'var(--term-surface-glass)' }}>
            {g.bindings.map((b, i) => (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '120px 1fr',
                  alignItems: 'center',
                  gap: 12,
                  padding: '8px 14px',
                  borderBottom: i < g.bindings.length - 1 ? '1px solid var(--term-line)' : 'none',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--ui-font)',
                    fontSize: 11,
                    color: 'var(--term-fg)',
                    padding: '2px 6px',
                    border: '1px solid var(--term-line)',
                    background: 'var(--term-alt)',
                    justifySelf: 'start',
                  }}
                >
                  {b.keys}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--ui-font)',
                    fontSize: 12.5,
                    color: 'var(--term-mid)',
                  }}
                >
                  {b.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
