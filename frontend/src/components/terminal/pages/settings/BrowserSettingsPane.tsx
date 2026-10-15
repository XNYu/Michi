import React from 'react';
import { usePrefs } from '../../../../state/prefs';
import { Row } from './controls';

export function BrowserSettingsPane() {
  const { prefs, setPref } = usePrefs();
  return <div>
    <h1 className="terminal-settings-heading">Browser</h1>
    <Row k="linkOpenTarget" label="Open links in">
      <select aria-label="Open links in" value={prefs.linkOpenTarget}
        onChange={event => setPref('linkOpenTarget', event.target.value === 'external' ? 'external' : 'internal')}
        style={{ background: 'var(--term-surface)', color: 'var(--term-fg)', border: '1px solid var(--term-line)', padding: '6px 10px', fontFamily: 'var(--ui-font)' }}>
        <option value="internal">Michi Browser (default)</option>
        <option value="external">System browser</option>
      </select>
    </Row>
    <p style={{ color: 'var(--term-muted)', fontSize: 'var(--fs-sm)', lineHeight: 1.6 }}>
      Used for links in Michi and links opened by agents with open_url. If Michi Browser is unavailable, links open in your system browser.
    </p>
  </div>;
}
