import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { ScheduledJobBlockedExecution, ScheduledJobDto } from 'michi-shared';
import { confirmScheduledExecutionStopped } from '../../../services/api/scheduledJobs';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { Button } from '../../ui/controls';
import { relativePastTime } from './scheduleModel';

/** Recovery is global: the earlier job may already have been deleted. */
export function ScheduledBlockedExecutions({ executions, jobs, workspaceName, now, onReleased }: {
  executions: readonly ScheduledJobBlockedExecution[];
  jobs: readonly ScheduledJobDto[];
  workspaceName: (workspaceId: string) => string;
  now: number;
  onReleased: () => Promise<void>;
}) {
  const titleId = React.useId();
  const [busy, setBusy] = React.useState<Set<string>>(new Set());
  const [errors, setErrors] = React.useState<Record<string, string | undefined>>({});
  const pending = React.useRef(new Set<string>());

  const confirmStopped = async (execution: ScheduledJobBlockedExecution, name: string, trigger: HTMLButtonElement) => {
    if (pending.current.has(execution.runId)) return;
    pending.current.add(execution.runId);
    try {
      const confirmed = await confirmDialog({
        title: 'Confirm the previous execution has stopped?',
        message: `First stop the previous Michi process and the agent it started for “${name}”. A stop request alone does not confirm they have ended.\n\nOnly continue after you have verified both have stopped. This allows new scheduled runs to start; it does not rerun the interrupted work.`,
        confirmLabel: 'Both have stopped',
        danger: false,
      });
      if (!confirmed) return;
      setBusy((current) => new Set(current).add(execution.runId));
      setErrors((current) => ({ ...current, [execution.runId]: undefined }));
      await confirmScheduledExecutionStopped(execution.runId);
      await onReleased();
    } catch (reason) {
      setErrors((current) => ({ ...current, [execution.runId]: reason instanceof Error ? reason.message : 'Could not confirm the previous execution has stopped. Try again.' }));
      // Another window may have released it already. Keep the error if the
      // refreshed status still includes this execution.
      await onReleased();
    } finally {
      pending.current.delete(execution.runId);
      setBusy((current) => { const next = new Set(current); next.delete(execution.runId); return next; });
      // The confirm closes before a possibly slow request completes. Restore
      // the enabled retry control if disabling it left focus on the page body.
      requestAnimationFrame(() => {
        if (trigger.isConnected && document.activeElement === document.body) trigger.focus({ preventScroll: true });
      });
    }
  };

  if (!executions.length) return null;
  return (
    <section className="sched-banner sched-blocked" role="alert" aria-labelledby={titleId}>
      <div className="sched-blocked-heading">
        <AlertTriangle size={16} aria-hidden="true" />
        <div>
          <h2 id={titleId}>Scheduled runs need attention</h2>
          <p>All new scheduled runs are paused until an earlier execution is confirmed stopped. Stop the previous Michi process and its agent before confirming.</p>
        </div>
      </div>
      <ul className="sched-blocked-list">
        {executions.map((execution) => {
          const name = jobs.find((job) => job.id === execution.jobId)?.name ?? 'Previous scheduled job';
          const error = errors[execution.runId];
          const waiting = busy.has(execution.runId);
          return <li key={execution.runId}>
            <div className="sched-blocked-run">
              <div>
                <strong>{name}</strong>
                <span>{workspaceName(execution.workspaceId)} · Blocked {relativePastTime(execution.since, now)}</span>
              </div>
              <Button size="sm" disabled={waiting} aria-label={`${error ? 'Retry confirming' : 'Confirm'} stopped: ${name}`}
                onClick={(event) => { void confirmStopped(execution, name, event.currentTarget); }}>
                {waiting ? 'Checking…' : error ? 'Retry' : 'Confirm stopped'}
              </Button>
            </div>
            {error && <p className="sched-blocked-error">{error}</p>}
          </li>;
        })}
      </ul>
    </section>
  );
}
