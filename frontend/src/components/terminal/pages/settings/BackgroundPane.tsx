import React from 'react';
import type { ScheduledJobSessionMode } from 'michi-shared';
import { getScheduledJobSettings, updateScheduledJobSettings } from '../../../../services/api/scheduledJobs';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import { useBackgroundService } from '../../scheduled/useBackgroundService';
import { Switch } from '../../../ui/controls';
import { Radio } from './controls';
import { SettingsRow, SettingsSection } from './SettingsSection';

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

  const description = !service.available ? 'Available in the Michi desktop app.'
    : !status ? <span role="status">Checking…</span>
      : !status.supported ? status.reason ?? 'Not available on this install.'
        : <span role="status">
          {status.running
            ? 'Michi’s backend runs on its own, so scheduled jobs keep running after you quit. It starts when you log in.'
            : 'Michi’s backend stops when you quit. Scheduled jobs run only while Michi is open.'}
        </span>;
  const control = service.available && status?.supported && <>
    <span className="settings-row__state">{service.busy ? (enabled ? 'Stopping…' : 'Starting…') : enabled ? 'On' : 'Off'}</span>
    <Switch on={enabled} disabled={service.busy} aria-label="Keep Michi running in the background"
      onChange={(next) => { if (!service.busy) void toggle(next); }} />
  </>;

  return (
    <SettingsSection title="Background">
      <ScheduledJobDefaults />
      <SettingsRow label="Keep Michi running in the background" description={description} control={control}>
        {service.error && <p role="alert" className="settings-row__note">{service.error}</p>}
        <p className="settings-row__note">
          Your Mac still pauses Michi while it sleeps. A job that was due during sleep runs once when the Mac wakes.
          {onOpenScheduled && (
            <>
              {' '}
              <button type="button" className="settings-row__link" onClick={onOpenScheduled}>Manage scheduled jobs</button>
            </>
          )}
        </p>
      </SettingsRow>
    </SettingsSection>
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
  return <SettingsRow label="Default scheduled job thread"
    description="Applies to new scheduled jobs. You can change the thread mode for each job.">
    {mode ? <fieldset disabled={saving}>
      <Radio label="Default scheduled job thread" value={mode} onChange={(next) => void save(next)} opts={[
        { value: 'persistent', label: 'One ongoing thread', description: 'Each job continues its own conversation across runs.' },
        { value: 'fresh', label: 'New thread each run', description: 'Each run starts a separate conversation.' },
      ]} />
    </fieldset> : !error && <p className="settings-row__note" role="status">Loading…</p>}
    {error && <p className="settings-row__note" role="alert">{error}</p>}
  </SettingsRow>;
}
