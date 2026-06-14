import React from 'react';
import { usePrefs } from '../../../state/prefs';
import { useChatStore } from '../../../state/chatStore';
import { saveAgentOptions } from '../../../services/api';
import { PALETTES } from '../../terminal/tokens';
import type { TerminalPalette } from '../../../state/prefs';

export default function SettingsScreen() {
  const { prefs, setPref } = usePrefs();
  const { activeProject, agentStatus, refreshAgentStatus } = useChatStore();

  const palettes = Object.keys(PALETTES) as TerminalPalette[];

  return (
    <div className="m-screen">
      <div className="m-screen-header">
        <span className="m-screen-title">Settings</span>
      </div>

      <div className="m-settings-section">
        <div className="m-settings-label">Palette</div>
        <div className="m-palette-grid">
          {palettes.map((p) => (
            <div
              key={p}
              className="m-palette-card"
              data-active={prefs.terminalPalette === p}
              onClick={() => setPref('terminalPalette', p)}
            >
              <div
                className="m-palette-swatch"
                style={{ background: PALETTES[p].accent }}
              />
              <span>{p}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="m-settings-section">
        <div className="m-settings-label">Model</div>
        <input
          className="m-search-input"
          value={agentStatus?.model ?? ''}
          placeholder="agent default"
          onChange={(e) => {
            const v = e.target.value;
            void saveAgentOptions({ model: v }).then(() => refreshAgentStatus());
          }}
        />
        <div style={{ fontSize: 11, color: 'var(--term-muted)', marginTop: 4 }}>
          {activeProject ? `Active workspace (${activeProject.name})` : 'Agent runtime model'}
        </div>
      </div>

      <div className="m-settings-section">
        <div className="m-settings-label">UI font</div>
        {(['Geist', 'IBM Plex Sans', 'Inter'] as const).map((font) => (
          <div
            key={font}
            className="m-thread-row"
            onClick={() => setPref('uiFont', font)}
            style={{ borderBottom: 'none', paddingLeft: 0 }}
          >
            <span style={{ color: prefs.uiFont === font ? 'var(--term-accent)' : 'var(--term-faint)', width: 14 }}>
              {prefs.uiFont === font ? '◉' : '○'}
            </span>
            <span style={{ flex: 1 }}>{font}</span>
          </div>
        ))}
      </div>

      <div className="m-settings-section">
        <div className="m-settings-label">About</div>
        <div style={{ fontSize: 12, color: 'var(--term-muted)' }}>
          michi mobile · 0.1
        </div>
      </div>
    </div>
  );
}
