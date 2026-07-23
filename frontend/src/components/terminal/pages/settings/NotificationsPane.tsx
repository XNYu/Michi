import { usePrefs } from '../../../../state/prefs';
import { Row as ClickableRow } from '../../primitives';
import { Row } from './controls';

export function NotificationsPane() {
  const { prefs, setPref } = usePrefs();

  const NOTIFICATION_OPTIONS: Array<{ value: 'all' | 'approval-only' | 'off'; label: string; desc: string }> = [
    { value: 'all', label: 'All', desc: 'Notify when streaming finishes and on approval requests.' },
    { value: 'approval-only', label: 'Approval only', desc: 'Only notify on permission / approval requests.' },
    { value: 'off', label: 'Off', desc: 'No notifications.' },
  ];

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
        Notifications
      </h1>
      <div style={{ marginBottom: 20 }} />

      <Row k="notifications" label="Notification level">
        <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--term-line)' }}>
          {NOTIFICATION_OPTIONS.map((o, i) => {
            const sel = prefs.notifications === o.value;
            return (
              <ClickableRow
                key={o.value}
                active={sel}
                onClick={() => setPref('notifications', o.value)}
                style={{
                  padding: '8px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  background: sel ? 'var(--term-alt)' : 'var(--term-surface)',
                  borderBottom: i < NOTIFICATION_OPTIONS.length - 1 ? '1px solid var(--term-line)' : 'none',
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
                  <div style={{ fontSize: 10.5, color: 'var(--term-muted)', marginTop: 2 }}>{o.desc}</div>
                </div>
              </ClickableRow>
            );
          })}
        </div>
      </Row>
    </div>
  );
}
