import { usePrefs } from '../../../../state/prefs';
import { Radio, Row } from './controls';

export function NotificationsPane() {
  const { prefs, setPref } = usePrefs();

  const NOTIFICATION_OPTIONS: Array<{ value: 'all' | 'approval-only' | 'off'; label: string; description: string }> = [
    { value: 'all', label: 'All', description: 'Notify when streaming finishes and on approval requests.' },
    { value: 'approval-only', label: 'Approval only', description: 'Only notify on permission / approval requests.' },
    { value: 'off', label: 'Off', description: 'No notifications.' },
  ];

  return (
    <div>
      <h1
        style={{
          fontFamily: 'var(--ui-font)',
          fontSize: 'var(--fs-2xl)',
          fontWeight: 700,
          color: 'var(--term-fg)',
          margin: 0,
        }}
      >
        Notifications
      </h1>
      <div style={{ marginBottom: 20 }} />

      <Row k="notifications" label="Notification level">
        <Radio label="Notification level" opts={NOTIFICATION_OPTIONS} value={prefs.notifications} onChange={(value) => setPref('notifications', value)} />
      </Row>
    </div>
  );
}
