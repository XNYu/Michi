import React from 'react';
import type { ScheduledJobSessionMode } from 'michi-shared';
import { getScheduledJobSettings, updateScheduledJobSettings } from '../../../../services/api/scheduledJobs';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import { useBackgroundService } from '../../scheduled/useBackgroundService';
import { Radio, Row, Toggle } from './controls';

const muted = { fontSize: 'var(--fs-sm)', color: 'var(--term-muted)', fontFamily: 'var(--ui-font)', lineHeight: 1.55, margin: '8px 0 0' } as const;

/** Settings → Background: the always-on backend that keeps scheduled jobs running. */
export function BackgroundPane({ onOpenScheduled }: { onOpenScheduled?: () => void }) {
  const service = useBackgroundService();
  const status = service.status;
  const enabled = !!status?.enabled;

  const toggle = async (next: boolean) => {
    const confirmed = await confirmDialog(next
      ? {
          title: 'Keep Michi running in the background?',
          message: 'Michi’s backend will keep running after you quit the app and start when you log in, so scheduled jobs run on time. Open chats reconnect in a moment.',
          confirmLabel: 'Keep running',
        }
      : {
          title: 'Stop the background service?',
          message: 'Michi’s backend will stop when you quit the app. Scheduled jobs only run while Michi is open. Open chats reconnect in a moment.',
          confirmLabel: 'Stop service',
        });
    if (confirmed) await service.setEnabled(next);
  };

  return (
    <div>
      <h1 style={{ fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-2xl)', fontWeight: 700, color: 'var(--term-fg)', margin: 0 }}>
        Background
      </h1>
      <div style={{ marginBottom: 20 }} />
      <ScheduledJobDefaults />
      <Row k="backgroundService" label="Keep Michi running in the background">
        {!service.available ? (
          <p style={{ ...muted, marginTop: 0 }}>Available in the Michi desktop app.</p>
        ) : !status ? (
          <p style={{ ...muted, marginTop: 0 }} role="status">Checking…</p>
        ) : !status.supported ? (
          <p style={{ ...muted, marginTop: 0 }}>{status.reason ?? 'Not available on this install.'}</p>
        ) : (
          <>
            <Toggle on={enabled} label={service.busy ? (enabled ? 'Stopping…' : 'Starting…') : enabled ? 'On' : 'Off'}
              onChange={(next) => { if (!service.busy) void toggle(next); }} />
            <p style={muted} role="status">
              {status.running
                ? 'Michi’s backend runs on its own, so scheduled jobs keep running after you quit. It starts when you log in.'
                : 'Michi’s backend stops when you quit. Scheduled jobs run only while Michi is open.'}
            </p>
            {service.error && <p role="alert" style={{ ...muted, color: 'var(--term-danger)' }}>{service.error}</p>}
          </>
        )}
        <p style={muted}>
          Your Mac still pauses Michi while it sleeps. A job that was due during sleep runs once when the Mac wakes.
          {onOpenScheduled && (
            <>
              {' '}
              <button type="button" onClick={onOpenScheduled}
                style={{ border: 0, padding: 0, background: 'none', color: 'var(--term-accent)', font: 'inherit', cursor: 'pointer' }}>
                Manage scheduled jobs
              </button>
            </>
          )}
        </p>
      </Row>
    </div>
  );
}

function ScheduledJobDefaults() {
  const [mode, setMode] = React.useState<ScheduledJobSessionMode | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    getScheduledJobSettings().then((settings) => { if (active) setMode(settings.sessionMode); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : 'Could not load defaults'); });
    return () => { active = false; };
  }, []);
  const save = async (next: ScheduledJobSessionMode) => {
    setSaving(true);
    setError(null);
    try { setMode((await updateScheduledJobSettings(next)).sessionMode); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save default'); }
    finally { setSaving(false); }
  };
  return <Row k="scheduledJobThread" label="Default scheduled job thread">
    {mode ? <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0 }}>
      <Radio label="Default scheduled job thread" value={mode} onChange={(next) => void save(next)} opts={[
        { value: 'persistent', label: 'One ongoing thread', description: 'Each job continues its own conversation across runs.' },
        { value: 'fresh', label: 'New thread each run', description: 'Each run starts a separate conversation.' },
      ]} />
    </fieldset> : !error && <p style={muted} role="status">Loading…</p>}
    <p style={muted}>Applies to new scheduled jobs. You can change the thread mode for each job.</p>
    {error && <p style={{ ...muted, color: 'var(--term-danger)' }} role="alert">{error}</p>}
  </Row>;
}
