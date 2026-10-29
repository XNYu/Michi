import { usePrefs } from '../../../../state/prefs';
import { Radio } from './controls';
import { SettingsSection } from './SettingsSection';

const NOTIFICATION_OPTIONS: Array<{ value: 'all' | 'approval-only' | 'off'; label: string; description: string }> = [
  { value: 'all', label: 'All', description: 'Notify when streaming finishes and on approval requests.' },
  { value: 'approval-only', label: 'Approval only', description: 'Only notify on permission / approval requests.' },
  { value: 'off', label: 'Off', description: 'No notifications.' },
];

export function NotificationsPane() {
  const { prefs, setPref } = usePrefs();
  return (
    <SettingsSection title="Notifications">
      <div className="settings-section__block">
        <Radio label="Notification level" opts={NOTIFICATION_OPTIONS} value={prefs.notifications} onChange={(value) => setPref('notifications', value)} />
      </div>
    </SettingsSection>
  );
}
