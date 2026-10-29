import { useId } from 'react';
import { usePrefs } from '../../../../state/prefs';
import { SettingsRow, SettingsSection } from './SettingsSection';

export function BrowserSettingsPane() {
  const { prefs, setPref } = usePrefs();
  const selectId = useId();
  return (
    <SettingsSection title="Browser">
      <SettingsRow
        label="Open links in"
        labelFor={selectId}
        description="Used for links in Michi and links opened by agents with open_url. If Michi Browser is unavailable, links open in your system browser."
        control={
          <select id={selectId} className="ui-select settings-row__select" value={prefs.linkOpenTarget}
            onChange={event => setPref('linkOpenTarget', event.target.value === 'external' ? 'external' : 'internal')}>
            <option value="internal">Michi Browser (default)</option>
            <option value="external">System browser</option>
          </select>
        }
      />
    </SettingsSection>
  );
}
