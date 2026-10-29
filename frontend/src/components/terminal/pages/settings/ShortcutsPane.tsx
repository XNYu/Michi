import { kbd } from '../../../../lib/platform';
import { SettingsSection } from './SettingsSection';

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
      { keys: kbd('mod', ','), label: 'Settings drawer' },
    ],
  },
  {
    title: 'Panes',
    bindings: [
      { keys: kbd('mod', 'W'), label: 'Close focused pane' },
      { keys: kbd('mod', 'T'), label: 'New thread (tree root in current workspace)' },
      { keys: kbd('mod', 'alt', 'T'), label: 'New blank branch from focused pane' },
      { keys: kbd('mod', '\\'), label: 'Open next chat not yet in a pane' },
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
    <SettingsSection title="Shortcuts">
      {SHORTCUT_GROUPS.map((g) => (
        <div key={g.title} className="settings-shortcuts__group">
          <h3 className="settings-shortcuts__group-title">{g.title}</h3>
          <div className="settings-shortcuts__table">
            {g.bindings.map((b, i) => (
              <div key={i} className="settings-shortcut-row">
                <span className="settings-shortcut-row__keys">{b.keys}</span>
                <span className="settings-shortcut-row__label">{b.label}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </SettingsSection>
  );
}
