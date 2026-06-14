import React from 'react';

export type MobileTab = 'threads' | 'spaces' | 'contexts' | 'settings';

interface Props {
  active: MobileTab;
  onChange: (tab: MobileTab) => void;
}

const TABS: Array<{ id: MobileTab; label: string; glyph: string }> = [
  { id: 'threads', label: 'Threads', glyph: '◉' },
  { id: 'spaces', label: 'Spaces', glyph: '⬚' },
  { id: 'contexts', label: 'Contexts', glyph: '@' },
  { id: 'settings', label: 'Settings', glyph: '⚙' },
];

export default function BottomTabBar({ active, onChange }: Props) {
  return (
    <nav className="m-tabbar" role="tablist">
      {TABS.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onChange(t.id)}
        >
          <span aria-hidden="true" style={{ fontSize: 16 }}>
            {t.glyph}
          </span>
          <span className="m-tab-label">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
