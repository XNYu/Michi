import React from 'react';
import { changeRuntimeProfile, resolveProfileReasoning, supportedProfileReasoning } from '../../../lib/runtimeProfile';
import { filterAvailableRuntimes } from '../../../lib/runtimeVisibility';
import type {
  ChatPermissionMode,
  ScheduledJobDto,
  ScheduledJobInput,
  ScheduledJobSessionMode,
} from 'michi-shared';
import { SCHEDULED_JOB_LIMITS } from 'michi-shared';
import { ModalShell } from '../../ui/ModalShell';
import { Button, Switch } from '../../ui/controls';
import { createScheduledJob, previewScheduledJobSchedule, updateScheduledJob } from '../../../services/api/scheduledJobs';
import { applyWorkspaceCommands } from '../../../services/api/persistence';
import { serializeWorkspaceRow } from '../../../state/workspacePersistence';
import type { Project } from '../../../state/chatTypes';
import { PERMISSION_CHOICES } from '../ComposerPermissionControl';
import { catalogKey } from '../agents/AgentRuntimeProfileFields';
import { useRuntimeFieldCatalog } from '../agents/useRuntimeFieldCatalog';
import {
  SCHEDULE_MODE_LABELS,
  WEEKDAY_LABELS,
  defaultScheduleDraft,
  draftToSchedule,
  formatDateTime,
  scheduleToDraft,
  timeZoneOptions,
  type ScheduleDraft,
  type ScheduleMode,
} from './scheduleModel';

export interface JobFormValue {
  name: string;
  workspaceId: string;
  prompt: string;
  schedule: ScheduleDraft;
  runtimeId: string;
  providerId: string;
  modelId: string;
  reasoning: string;
  permissionMode: ChatPermissionMode;
  sessionMode: ScheduledJobSessionMode;
  notify: boolean;
  timeoutMinutes: number;
}

export function formValueFromJob(job: ScheduledJobDto | null, defaults: { workspaceId: string; sessionMode?: ScheduledJobSessionMode }): JobFormValue {
  if (!job) {
    return {
      name: '',
      workspaceId: defaults.workspaceId,
      prompt: '',
      schedule: defaultScheduleDraft(),
      runtimeId: '',
      providerId: '',
      modelId: '',
      reasoning: '',
      permissionMode: 'trust',
      sessionMode: defaults.sessionMode ?? 'persistent',
      notify: true,
      timeoutMinutes: SCHEDULED_JOB_LIMITS.defaultTimeoutSeconds / 60,
    };
  }
  return {
    name: job.name,
    workspaceId: job.workspaceId,
    prompt: job.prompt,
    schedule: scheduleToDraft(job.schedule),
    runtimeId: job.runtimeId ?? '',
    providerId: job.providerId ?? '',
    modelId: job.modelId ?? '',
    reasoning: job.reasoning ?? '',
    permissionMode: job.permissionMode,
    sessionMode: job.sessionMode,
    notify: job.notify,
    timeoutMinutes: Math.round(job.timeoutSeconds / 60),
  };
}

export function validateJobForm(value: JobFormValue): { input?: ScheduledJobInput; errors: Partial<Record<'name' | 'workspaceId' | 'prompt' | 'schedule' | 'timeout', string>> } {
  const errors: Partial<Record<'name' | 'workspaceId' | 'prompt' | 'schedule' | 'timeout', string>> = {};
  if (!value.name.trim()) errors.name = 'Give the job a name';
  if (!value.workspaceId) errors.workspaceId = 'Pick a workspace';
  if (!value.prompt.trim()) errors.prompt = 'Write the prompt to run';
  const compiled = draftToSchedule(value.schedule);
  if (compiled.error) errors.schedule = compiled.error;
  const timeout = Math.round(Number(value.timeoutMinutes));
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 24 * 60) errors.timeout = 'Between 1 and 1440 minutes';
  if (Object.keys(errors).length > 0 || !compiled.schedule) return { errors };
  return {
    errors,
    input: {
      name: value.name.trim(),
      workspaceId: value.workspaceId,
      prompt: value.prompt.trim(),
      schedule: compiled.schedule,
      runtimeId: value.runtimeId || null,
      providerId: value.runtimeId ? value.providerId || null : null,
      modelId: value.runtimeId ? value.modelId || null : null,
      reasoning: value.runtimeId ? value.reasoning || null : null,
      permissionMode: value.permissionMode,
      sessionMode: value.sessionMode,
      notify: value.notify,
      timeoutSeconds: timeout * 60,
    },
  };
}

const MODES: ScheduleMode[] = ['interval', 'daily', 'weekdays', 'weekly', 'once', 'cron'];

function Field({ label, htmlFor, error, hint, children }: {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="sched-field">
      <label className="sched-field-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <p className="sched-field-error" role="alert">{error}</p> : hint ? <p className="sched-field-hint">{hint}</p> : null}
    </div>
  );
}

function SchedulePreview({ draft }: { draft: ScheduleDraft }) {
  const compiled = draftToSchedule(draft);
  const key = compiled.schedule ? JSON.stringify(compiled.schedule) : '';
  const [preview, setPreview] = React.useState<{ key: string; runs: number[]; error?: string } | null>(null);
  React.useEffect(() => {
    if (!compiled.schedule) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      previewScheduledJobSchedule(compiled.schedule!, controller.signal)
        .then((result) => setPreview({ key, runs: result.nextRuns, error: result.valid ? undefined : result.error }))
        .catch(() => { /* preview is advisory */ });
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
    // `key` captures the compiled schedule.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (compiled.error) return <p className="sched-field-hint">{compiled.error}</p>;
  if (!preview || preview.key !== key) return <p className="sched-field-hint">&nbsp;</p>;
  if (preview.error) return <p className="sched-field-error" role="alert">{preview.error}</p>;
  return (
    <p className="sched-field-hint" aria-live="polite">
      {preview.runs.length === 0 ? 'No upcoming runs' : `Next: ${preview.runs.map((run) => formatDateTime(run)).join(' · ')}`}
    </p>
  );
}

function ScheduleFields({ draft, onChange, error }: { draft: ScheduleDraft; onChange: (next: ScheduleDraft) => void; error?: string }) {
  const set = <K extends keyof ScheduleDraft>(key: K, next: ScheduleDraft[K]) => onChange({ ...draft, [key]: next });
  const zones = React.useMemo(() => timeZoneOptions(draft.timezone), [draft.timezone]);
  const usesZone = draft.mode !== 'interval' && draft.mode !== 'once';
  return (
    <div className="sched-field">
      <span className="sched-field-label" id="sched-schedule-label">Schedule</span>
      <div className="sched-segmented" role="radiogroup" aria-labelledby="sched-schedule-label">
        {MODES.map((mode) => (
          <button key={mode} type="button" role="radio" aria-checked={draft.mode === mode}
            className="sched-segment" onClick={() => set('mode', mode)}>
            {SCHEDULE_MODE_LABELS[mode]}
          </button>
        ))}
      </div>
      <div className="sched-schedule-body">
        {draft.mode === 'interval' && (
          <div className="sched-inline">
            <span>Every</span>
            <input className="ui-input sched-number" type="number" min={1} aria-label="Interval"
              value={draft.intervalValue} onChange={(event) => set('intervalValue', Number(event.target.value))} />
            <select className="ui-select sched-auto" aria-label="Interval unit" value={draft.intervalUnit}
              onChange={(event) => set('intervalUnit', event.target.value as ScheduleDraft['intervalUnit'])}>
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
          </div>
        )}
        {draft.mode === 'weekly' && (
          <div className="sched-days" role="group" aria-label="Days of the week">
            {WEEKDAY_LABELS.map((label, day) => {
              const on = draft.weekdays.includes(day);
              return (
                <button key={label} type="button" className="sched-day" aria-pressed={on}
                  onClick={() => set('weekdays', on ? draft.weekdays.filter((value) => value !== day) : [...draft.weekdays, day])}>
                  {label}
                </button>
              );
            })}
          </div>
        )}
        {(draft.mode === 'daily' || draft.mode === 'weekdays' || draft.mode === 'weekly') && (
          <div className="sched-inline">
            <span>at</span>
            <input className="ui-input sched-auto" type="time" aria-label="Time of day" value={draft.time}
              onChange={(event) => set('time', event.target.value)} />
          </div>
        )}
        {draft.mode === 'once' && (
          <input className="ui-input" type="datetime-local" aria-label="Run at" value={draft.onceAt}
            onChange={(event) => set('onceAt', event.target.value)} />
        )}
        {draft.mode === 'cron' && (
          <input className="ui-input sched-mono" aria-label="Cron expression" placeholder="0 9 * * 1-5" spellCheck={false}
            value={draft.cron} onChange={(event) => set('cron', event.target.value)} />
        )}
        {usesZone && (
          <select className="ui-select" aria-label="Timezone" value={draft.timezone}
            onChange={(event) => set('timezone', event.target.value)}>
            {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
          </select>
        )}
      </div>
      {error ? <p className="sched-field-error" role="alert">{error}</p> : <SchedulePreview draft={draft} />}
      {draft.mode === 'cron' && (
        <p className="sched-field-hint">minute hour day-of-month month day-of-week</p>
      )}
    </div>
  );
}

function AgentFields({ value, onChange }: { value: JobFormValue; onChange: (next: JobFormValue) => void }) {
  const catalog = useRuntimeFieldCatalog('local');
  const runtimes = filterAvailableRuntimes(catalog?.runtimes ?? []);
  const providers = value.runtimeId ? catalog?.providersFor[value.runtimeId] : undefined;
  const models = value.runtimeId ? catalog?.modelsFor[catalogKey(value.runtimeId, value.providerId)] : undefined;
  React.useEffect(() => {
    if (catalog && value.runtimeId) catalog.request(value.runtimeId, value.providerId);
  }, [catalog, value.runtimeId, value.providerId]);
  const { levels: reasoningLevels } = resolveProfileReasoning(catalog?.capabilitiesFor?.[value.runtimeId], models, value.modelId, providers?.find((provider) => provider.id === value.providerId));
  const disabled = !value.runtimeId;
  return (
    <div className="sched-grid">
      {catalog?.errorsFor?.[catalogKey(value.runtimeId, value.providerId)] && <p role="alert">Unable to load runtime options. <button type="button" onClick={() => catalog.retry?.(value.runtimeId, value.providerId)}>Retry</button></p>}
      <Field label="Agent" htmlFor="sched-runtime">
        <select id="sched-runtime" className="ui-select" value={value.runtimeId}
          onChange={(event) => onChange(changeRuntimeProfile(value, 'runtimeId', event.target.value))}>
          <option value="">Default from Settings</option>
          {runtimes.map((runtime) => (
            <option key={runtime.id} value={runtime.id}>
              {runtime.label}
            </option>
          ))}
          {value.runtimeId && catalog && !runtimes.some((runtime) => runtime.id === value.runtimeId) && (
            <option value={value.runtimeId} disabled hidden>{value.runtimeId}</option>
          )}
        </select>
      </Field>
      {providers && providers.length > 0 && (
        <Field label="Provider" htmlFor="sched-provider">
          <select id="sched-provider" className="ui-select" value={value.providerId}
            onChange={(event) => onChange(changeRuntimeProfile(value, 'providerId', event.target.value))}>
            <option value="">Runtime default</option>
            {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
          </select>
        </Field>
      )}
      <Field label="Model" htmlFor="sched-model">
        <select id="sched-model" className="ui-select" value={value.modelId} disabled={disabled}
          onChange={(event) => onChange(changeRuntimeProfile(value, 'modelId', event.target.value))}>
          <option value="">{disabled ? 'Default from Settings' : 'Runtime default'}</option>
          {(models ?? []).map((model) => <option key={model.id} value={model.id}>{model.label ?? model.id}</option>)}
          {value.modelId && !(models ?? []).some((model) => model.id === value.modelId) && (
            <option value={value.modelId}>{value.modelId}</option>
          )}
        </select>
      </Field>
      <Field label="Reasoning" htmlFor="sched-reasoning">
        <select id="sched-reasoning" className="ui-select" value={value.reasoning} disabled={disabled}
          onChange={(event) => onChange({ ...value, reasoning: event.target.value })}>
          <option value="">Default</option>
          {value.reasoning && !supportedProfileReasoning(value.reasoning, reasoningLevels) && <option value={value.reasoning} disabled>{value.reasoning} (unavailable)</option>}
          {reasoningLevels.map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
      </Field>
    </div>
  );
}

function ChoiceList<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; description: string }>;
  onChange: (next: T) => void;
}) {
  const id = React.useId();
  return (
    <div className="sched-field">
      <span className="sched-field-label" id={id}>{label}</span>
      <div className="sched-choices" role="radiogroup" aria-labelledby={id}>
        {options.map((option) => (
          <button key={option.value} type="button" role="radio" aria-checked={value === option.value}
            className="sched-choice" onClick={() => onChange(option.value)}>
            <span className="sched-choice-dot" aria-hidden="true" />
            <span>
              <span className="sched-choice-label">{option.label}</span>
              <span className="sched-choice-desc">{option.description}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

const SESSION_OPTIONS: ReadonlyArray<{ value: ScheduledJobSessionMode; label: string; description: string }> = [
  { value: 'fresh', label: 'New thread each run', description: 'Every run starts clean in its own thread.' },
  { value: 'persistent', label: 'One ongoing thread', description: 'Runs add to the same conversation, so the agent remembers earlier results.' },
];

export function ScheduledJobEditor({ job, initial, projects, defaultWorkspaceId, onClose, onSaved }: {
  /** Job being edited; null creates a new job. */
  job: ScheduledJobDto | null;
  /** Prefill for a new job (duplicate). */
  initial?: JobFormValue;
  projects: Project[];
  defaultWorkspaceId: string;
  onClose: () => void;
  onSaved: (job: ScheduledJobDto) => void;
}) {
  const [value, setValue] = React.useState<JobFormValue>(() => initial ?? formValueFromJob(job, { workspaceId: defaultWorkspaceId }));
  const [errors, setErrors] = React.useState<ReturnType<typeof validateJobForm>['errors']>({});
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const permissionOptions = React.useMemo(
    () => PERMISSION_CHOICES.map((choice) => ({ value: choice.mode, label: choice.label, description: choice.description })),
    [],
  );

  const save = async () => {
    const result = validateJobForm(value);
    setErrors(result.errors);
    if (!result.input) return;
    const input = result.input;
    setSaving(true);
    setSaveError(null);
    const submit = () => (job ? updateScheduledJob(job.id, input) : createScheduledJob(input));
    try {
      let saved: ScheduledJobDto;
      try {
        saved = await submit();
      } catch (reason) {
        // A workspace with no threads yet may exist only in this window.
        // Store its row (the same command the window itself would send),
        // then retry once.
        const project = projects.find((candidate) => candidate.id === input.workspaceId);
        if (!project || !(reason instanceof Error) || !/Workspace not found/.test(reason.message)) throw reason;
        await applyWorkspaceCommands(project.id, `sched-ws-${project.id}-${Date.now()}`, [
          { type: 'workspace.upsert', payload: serializeWorkspaceRow(project) },
        ]);
        saved = await submit();
      }
      onSaved(saved);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell open onClose={onClose} title={job ? 'Edit scheduled job' : 'New scheduled job'} width={640} maxHeight="min(88vh, 860px)">
      <form className="sched-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="sched-editor-scroll term-scrollbar">
          <Field label="Name" htmlFor="sched-name" error={errors.name}>
            <input id="sched-name" className="ui-input" autoFocus maxLength={SCHEDULED_JOB_LIMITS.name}
              placeholder="Morning briefing" value={value.name} onChange={(event) => setValue({ ...value, name: event.target.value })} />
          </Field>
          <Field label="Workspace" htmlFor="sched-workspace" error={errors.workspaceId}
            hint="The agent works in this workspace's folder. Results appear as threads here.">
            <select id="sched-workspace" className="ui-select" value={value.workspaceId}
              onChange={(event) => setValue({ ...value, workspaceId: event.target.value })}>
              {!value.workspaceId && <option value="">Choose a workspace…</option>}
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </Field>
          <Field label="Prompt" htmlFor="sched-prompt" error={errors.prompt}>
            <textarea id="sched-prompt" className="ui-input sched-textarea" rows={6} maxLength={SCHEDULED_JOB_LIMITS.prompt}
              placeholder="Summarize what changed in this repository since yesterday and flag anything risky."
              value={value.prompt} onChange={(event) => setValue({ ...value, prompt: event.target.value })} />
          </Field>
          <ScheduleFields draft={value.schedule} error={errors.schedule}
            onChange={(schedule) => { setValue({ ...value, schedule }); setErrors((current) => ({ ...current, schedule: undefined })); }} />
          <p className="sched-field-hint sched-catchup">If Michi is off or asleep at run time, the job runs once when it is back.</p>
          <AgentFields value={value} onChange={setValue} />
          <ChoiceList label="Permissions" value={value.permissionMode} options={permissionOptions}
            onChange={(permissionMode) => setValue({ ...value, permissionMode })} />
          <ChoiceList label="Thread" value={value.sessionMode} options={SESSION_OPTIONS}
            onChange={(sessionMode) => setValue({ ...value, sessionMode })} />
          <div className="sched-grid">
            <Field label="Time limit (minutes)" htmlFor="sched-timeout" error={errors.timeout}>
              <input id="sched-timeout" className="ui-input" type="number" min={1} max={1440} value={value.timeoutMinutes}
                onChange={(event) => setValue({ ...value, timeoutMinutes: Number(event.target.value) })} />
            </Field>
            <div className="sched-field">
              <span className="sched-field-label">Notifications</span>
              <label className="sched-toggle">
                <Switch on={value.notify} onChange={(notify) => setValue({ ...value, notify })} aria-label="Notify when a run finishes" />
                <span>Notify me when a run finishes</span>
              </label>
            </div>
          </div>
        </div>
        <footer className="sched-editor-footer">
          {saveError ? <p className="sched-field-error" role="alert">{saveError}</p> : <span />}
          <div className="sched-editor-actions">
            <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={saving}>{saving ? 'Saving…' : job ? 'Save changes' : 'Create job'}</Button>
          </div>
        </footer>
      </form>
    </ModalShell>
  );
}
