import React from 'react';
import { MAINTENANCE_WATCH_LIMITS, type MaintenanceWatch } from 'michi-shared';
import type { PageMaintenanceState } from '../../../state/pages/usePageMaintenance';
import type { MaintenanceWatchInput } from '../../../services/api/pageMaintenance';

const INTERVALS: ReadonlyArray<{ minutes: number; label: string }> = [
  { minutes: 15, label: 'Every 15 minutes' },
  { minutes: 30, label: 'Every 30 minutes' },
  { minutes: 60, label: 'Every hour' },
  { minutes: 120, label: 'Every 2 hours' },
  { minutes: 240, label: 'Every 4 hours' },
  { minutes: 480, label: 'Every 8 hours' },
  { minutes: 720, label: 'Every 12 hours' },
  { minutes: 1440, label: 'Every day' },
  { minutes: 10080, label: 'Every week' },
];

const muted: React.CSSProperties = { color: 'var(--term-muted)', fontSize: 'var(--fs-xs)' };
const field: React.CSSProperties = { width: '100%', boxSizing: 'border-box', marginTop: 4, font: 'inherit', fontSize: 'var(--fs-sm)' };
const heading: React.CSSProperties = { margin: 0, fontSize: 'var(--fs-sm)' };

function intervalLabel(minutes: number): string {
  const preset = INTERVALS.find((interval) => interval.minutes === minutes);
  if (preset) return preset.label;
  if (minutes % 1440 === 0) return `Every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

function lastCheckLine(watch: MaintenanceWatch): string {
  const run = watch.lastRun;
  if (!run) return watch.enabled ? 'Not checked yet' : 'Never checked';
  if (run.state === 'running') return `Checking now · started ${new Date(run.startedAt).toLocaleString()}`;
  const when = new Date(run.finishedAt ?? run.startedAt).toLocaleString();
  if (run.state === 'succeeded') return `Last check ${when}${run.summary ? ` · ${run.summary.replace(/^Watch “[^”]*”: /, '')}` : ''}`;
  if (run.state === 'interrupted') return `Last check ${when} stopped before it finished`;
  return `Last check failed ${when}${run.error ? ` · ${run.error}` : ''}`;
}

function nextCheckLine(watch: MaintenanceWatch): string | null {
  if (!watch.enabled || watch.nextCheckAt === null || watch.lastRun?.state === 'running') return null;
  if (watch.runRequested || watch.nextCheckAt <= Date.now()) return 'Next check as soon as maintenance is free';
  return `Next check ${new Date(watch.nextCheckAt).toLocaleString()}`;
}

function WatchForm({ initial, busy, submitLabel, onSubmit, onCancel }: {
  initial?: MaintenanceWatch;
  busy: boolean;
  submitLabel: string;
  onSubmit: (input: MaintenanceWatchInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = React.useState(initial?.title ?? '');
  const [instructions, setInstructions] = React.useState(initial?.instructions ?? '');
  const [interval, setIntervalMinutes] = React.useState(initial?.intervalMinutes ?? 60);
  const options = INTERVALS.some((option) => option.minutes === interval) ? INTERVALS : [...INTERVALS, { minutes: interval, label: intervalLabel(interval) }];
  const ready = title.trim() !== '' && instructions.trim() !== '';
  return (
    <form aria-label={initial ? `Edit watch ${initial.title}` : 'New watch'} style={{ marginTop: 8, padding: 9, border: '1px solid var(--term-line)', borderRadius: 5 }}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) void onSubmit({ title: title.trim(), instructions: instructions.trim(), intervalMinutes: interval }).catch(() => undefined);
      }}>
      <label style={{ display: 'block', fontSize: 'var(--fs-sm)' }}>Name
        <input style={field} value={title} maxLength={MAINTENANCE_WATCH_LIMITS.titleMaxLength} placeholder="For example: Sev-2 tickets"
          onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label style={{ display: 'block', marginTop: 8, fontSize: 'var(--fs-sm)' }}>What to check and where to record it
        <textarea style={field} rows={4} value={instructions} maxLength={MAINTENANCE_WATCH_LIMITS.instructionsMaxLength}
          placeholder="For example: Check open Sev-2 tickets for resolver group X. Add a task for each new ticket and mark it done once the ticket is resolved."
          onChange={(event) => setInstructions(event.target.value)} />
      </label>
      <label style={{ display: 'block', marginTop: 8, fontSize: 'var(--fs-sm)' }}>How often
        <select style={field} value={interval} onChange={(event) => setIntervalMinutes(Number(event.target.value))}>
          {options.map((option) => <option key={option.minutes} value={option.minutes}>{option.label}</option>)}
        </select>
      </label>
      <div style={{ display: 'flex', gap: 8, marginTop: 9 }}>
        <button type="submit" disabled={busy || !ready}>{busy ? 'Saving…' : submitLabel}</button>
        <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function InstructionsEditor({ maintenance }: { maintenance: PageMaintenanceState }) {
  const savedText = maintenance.value?.instructions?.text ?? '';
  const [text, setText] = React.useState(savedText);
  const [saved, setSaved] = React.useState(false);
  // Follow a save made elsewhere unless this editor holds unsaved changes.
  const lastSaved = React.useRef(savedText);
  React.useEffect(() => {
    setText((current) => (current === lastSaved.current ? savedText : current));
    lastSaved.current = savedText;
  }, [savedText]);
  const dirty = text.trim() !== savedText;
  return (
    <form aria-label="Workspace instructions" style={{ marginTop: 12 }} onSubmit={(event) => {
      event.preventDefault();
      void maintenance.saveInstructions(text).then(() => setSaved(true), () => undefined);
    }}>
      <h4 style={heading}>Instructions for this workspace</h4>
      <p style={{ ...muted, margin: '3px 0 0' }}>The Meta agent follows these in every update of this workspace: conversation maintenance, its first page and each watch.</p>
      <textarea aria-label="Instructions for this workspace" style={field} rows={3} value={text}
        maxLength={MAINTENANCE_WATCH_LIMITS.workspaceInstructionsMaxLength}
        placeholder="For example: Keep the summary in English. Every task names its owner."
        onChange={(event) => { setText(event.target.value); setSaved(false); }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
        <button type="submit" disabled={maintenance.busy || !dirty}>{maintenance.busy ? 'Saving…' : 'Save instructions'}</button>
        {saved && !dirty && <span role="status" style={muted}>Saved</span>}
      </div>
    </form>
  );
}

/** Per-workspace Meta agent instructions and watches, inside the Conversation maintenance panel. */
export function MaintenanceWatches({ maintenance }: { maintenance: PageMaintenanceState }) {
  const { value, busy } = maintenance;
  const [editing, setEditing] = React.useState<string | 'new' | null>(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState<string | null>(null);
  const watches = value?.watches;
  // An older backend sends no watches: it cannot run them.
  if (!value?.config || !watches) return null;
  const act = (action: () => Promise<void>) => () => { void action().catch(() => undefined); };
  return (
    <div style={{ borderTop: '1px solid var(--term-line)', marginTop: 12 }}>
      <InstructionsEditor maintenance={maintenance} />
      <section aria-label="Watches" style={{ marginTop: 14 }}>
        <h4 style={heading}>Watches</h4>
        <p style={{ ...muted, margin: '3px 0 0' }}>
          Timed checks of outside sources, such as tickets or tasks. Each check uses the Meta agent’s read-only tools and updates this workspace’s pages and task board.
          Tools that are not read-only need your approval in Settings › Meta agent first.
        </p>
        {watches.map((watch) => editing === watch.id
          ? <WatchForm key={watch.id} initial={watch} busy={busy} submitLabel="Save watch" onCancel={() => setEditing(null)}
            onSubmit={(input) => maintenance.changeWatch(watch.id, input).then(() => setEditing(null))} />
          : <div key={watch.id} style={{ marginTop: 9, paddingTop: 9, borderTop: '1px solid var(--term-line)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <strong style={{ fontSize: 'var(--fs-sm)' }}>{watch.title}</strong>
                <span style={{ ...muted, marginLeft: 8 }}>{watch.enabled ? intervalLabel(watch.intervalMinutes) : 'Off'}</span>
                <p style={{ ...muted, margin: '3px 0 0', whiteSpace: 'pre-wrap' }}>{watch.instructions}</p>
                <p style={{ ...muted, margin: '3px 0 0' }}>{lastCheckLine(watch)}</p>
                {nextCheckLine(watch) && <p style={{ ...muted, margin: '2px 0 0' }}>{nextCheckLine(watch)}</p>}
                {watch.pausedReason && <p role="alert" style={{ margin: '3px 0 0', color: 'var(--term-danger)', fontSize: 'var(--fs-xs)' }}>{watch.pausedReason}</p>}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button type="button" disabled={busy || !watch.enabled || watch.lastRun?.state === 'running'} onClick={act(() => maintenance.runWatch(watch.id))}>Check now</button>
                <button type="button" disabled={busy} onClick={act(() => maintenance.changeWatch(watch.id, { enabled: !watch.enabled }))}>{watch.enabled ? 'Turn off' : 'Turn on'}</button>
                <button type="button" disabled={busy} onClick={() => setEditing(watch.id)}>Edit</button>
                {confirmingDelete === watch.id
                  ? <button type="button" disabled={busy} onClick={act(() => maintenance.removeWatch(watch.id).then(() => setConfirmingDelete(null)))}>Delete watch</button>
                  : <button type="button" disabled={busy} onClick={() => setConfirmingDelete(watch.id)}>Delete…</button>}
              </div>
            </div>
          </div>)}
        {editing === 'new'
          ? <WatchForm busy={busy} submitLabel="Add watch" onCancel={() => setEditing(null)}
            onSubmit={(input) => maintenance.addWatch(input).then(() => setEditing(null))} />
          : watches.length < MAINTENANCE_WATCH_LIMITS.maxWatches && <button type="button" style={{ marginTop: 9 }} disabled={busy} onClick={() => setEditing('new')}>Add a watch</button>}
      </section>
    </div>
  );
}
