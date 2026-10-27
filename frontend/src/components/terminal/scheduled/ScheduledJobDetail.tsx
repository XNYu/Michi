import React from 'react';
import { ChevronRight, Clock3, MessageSquare, Pencil, Play, Square, Trash2 } from 'lucide-react';
import type { ScheduledJobDto, ScheduledJobRunDto } from 'michi-shared';
import { ModalShell } from '../../ui/ModalShell';
import { Button } from '../../ui/controls';
import { listScheduledJobRuns } from '../../../services/api/scheduledJobs';
import { PERMISSION_CHOICES } from '../ComposerPermissionControl';
import { TrashIconButton } from '../pages/TrashControls';
import { SCHEDULED_JOB_RUN_WINDOW_EVENT } from './scheduledNav';
import {
  RUN_STATUS_LABELS,
  describeSchedule,
  formatDateTime,
  formatDuration,
  relativeTime,
  runStatusTone,
} from './scheduleModel';

export function StatusDot({ status }: { status: ScheduledJobRunDto['status'] | null }) {
  return <span className="sched-status-dot" data-tone={runStatusTone(status)} aria-hidden="true" />;
}

/** Run history; `refreshKey` changes when the job starts or finishes a run. */
function useRuns(jobId: string, refreshKey: string) {
  const [runs, setRuns] = React.useState<ScheduledJobRunDto[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const load = React.useCallback((signal?: AbortSignal) => {
    listScheduledJobRuns(jobId, signal)
      .then((next) => { setRuns(next); setError(null); })
      .catch((reason: unknown) => {
        if (signal?.aborted) return;
        setError(reason instanceof Error ? reason.message : 'Could not load runs');
      });
  }, [jobId]);
  React.useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    const onRun = (event: Event) => {
      const detail = (event as CustomEvent<{ jobId?: string }>).detail;
      if (detail?.jobId === jobId) load();
    };
    const poll = window.setInterval(() => load(), 10_000);
    window.addEventListener(SCHEDULED_JOB_RUN_WINDOW_EVENT, onRun);
    return () => {
      controller.abort();
      window.clearInterval(poll);
      window.removeEventListener(SCHEDULED_JOB_RUN_WINDOW_EVENT, onRun);
    };
  }, [jobId, load, refreshKey]);
  return { runs, error };
}

export function ScheduledJobDetail({ job, workspaceName, now, busy, runBlocked = false, onClose, onEdit, onRunNow, onCancelRun, onDelete, onOpenRun }: {
  job: ScheduledJobDto;
  workspaceName: string;
  now: number;
  busy: boolean;
  runBlocked?: boolean;
  onClose: () => void;
  onEdit: () => void;
  onRunNow: () => void;
  onCancelRun: () => void;
  onDelete: () => void;
  onOpenRun: (run: ScheduledJobRunDto) => void;
}) {
  const { runs, error } = useRuns(job.id, `${job.activeRunId ?? ''}:${job.lastRunAt ?? ''}`);
  const permission = PERMISSION_CHOICES.find((choice) => choice.mode === job.permissionMode)?.label ?? job.permissionMode;
  const next = job.nextRunAt
    ? `${formatDateTime(job.nextRunAt, now)} (${relativeTime(job.nextRunAt, now)})`
    : job.autoPaused ? 'Paused after repeated failures' : job.enabled ? 'No upcoming run' : 'Paused';
  return (
    <ModalShell open onClose={onClose} title="Scheduled job" width={600} maxHeight="min(86vh, 820px)">
      <div className="sched-detail">
        <div className="sched-detail-scroll term-scrollbar">
          <div className="sched-detail-eyebrow"><Clock3 size={15} aria-hidden="true" />{describeSchedule(job.schedule)}</div>
          <h2>{job.name}</h2>
          <dl>
            <dt>Next run</dt><dd>{next}</dd>
            <dt>Workspace</dt><dd>{workspaceName}</dd>
            <dt>Agent</dt><dd>{job.runtimeId ? [job.runtimeId, job.modelId].filter(Boolean).join(' · ') : 'Default from Settings'}</dd>
            <dt>Permissions</dt><dd>{permission}</dd>
            <dt>Thread</dt><dd>{job.sessionMode === 'persistent' ? 'One ongoing thread' : 'New thread each run'}</dd>
            <dt>Notify</dt><dd>{job.notify ? 'When a run finishes' : 'Off'}</dd>
          </dl>
          {job.lastError && <p className="sched-detail-error" role="status">{job.lastError}</p>}
          <h3>Prompt</h3>
          <p className="sched-detail-prompt">{job.prompt}</p>
          <h3>Runs <span>{runs ? runs.length : ''}</span></h3>
          {error && <p className="sched-detail-error" role="alert">{error}</p>}
          {!runs && !error && <div className="sched-loading" role="status" aria-label="Loading runs"><span /><span /></div>}
          {runs && runs.length === 0 && <p className="sched-detail-empty">No runs yet. Use Run now to try it.</p>}
          {runs && runs.length > 0 && (
            <ul className="sched-runs">
              {runs.map((run) => (
                <li key={run.id}>
                  <button type="button" className="sched-run" disabled={!run.nodeId} onClick={() => onOpenRun(run)}
                    aria-label={`${RUN_STATUS_LABELS[run.status]} run from ${formatDateTime(run.startedAt, now)}${run.nodeId ? ', open thread' : ''}`}>
                    <StatusDot status={run.status} />
                    <span className="sched-run-main">
                      <span className="sched-run-title">
                        {RUN_STATUS_LABELS[run.status]}
                        <span className="sched-run-meta">
                          {formatDateTime(run.startedAt, now)} · {formatDuration(run.startedAt, run.finishedAt, now)}{run.trigger === 'manual' ? ' · manual' : ''}
                        </span>
                      </span>
                      {(run.summary || run.error) && <span className="sched-run-summary">{run.status === 'succeeded' ? run.summary : run.error ?? run.summary}</span>}
                    </span>
                    {run.nodeId && <span className="sched-run-open"><MessageSquare size={14} aria-hidden="true" /><ChevronRight size={14} aria-hidden="true" /></span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer>
          <div className="sched-detail-actions">
            {job.activeRunId
              ? <Button onClick={onCancelRun} disabled={busy}><Square size={14} aria-hidden="true" />Stop run</Button>
              : <Button variant="primary" onClick={onRunNow} disabled={busy || runBlocked} title={runBlocked ? 'Confirm the previous execution has stopped first' : undefined}><Play size={14} aria-hidden="true" />Run now</Button>}
            <Button onClick={onEdit} disabled={busy}><Pencil size={14} aria-hidden="true" />Edit</Button>
          </div>
          <TrashIconButton icon={Trash2} tooltip="Delete job" aria-label={`Delete ${job.name}`} className="trash-danger" disabled={busy} onClick={onDelete} />
        </footer>
      </div>
    </ModalShell>
  );
}
