import React from 'react';
import type { MetaAgentResolvedRuntime, ScheduledJobDto } from 'michi-shared';
import { LOCAL_BACKEND_CONNECTION_ID } from '../../../config/backendConnections';
import { usePageMaintenance } from '../../../state/pages/usePageMaintenance';
import type { PageMaintenanceIdentity, PageMaintenanceWorkspace } from '../../../services/api/pageMaintenance';
import { requestMetaAgentSettings } from '../scheduled/metaAgent/metaAgentNav';
import { metaAgentRuntimeLabel } from '../settings/metaAgent/runtimeCopy';

export function MaintenanceEnrollmentCheckbox({ checked, onChange, disabled = false }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, color: 'var(--term-fg)', fontSize: 'var(--fs-sm)' }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span><strong>Keep up to date from this workspace’s conversations</strong><br /><span style={{ color: 'var(--term-muted)' }}>You can change this later. Existing pages are not enrolled automatically.</span></span>
    </label>
  );
}

type MaintenanceIdentity = Pick<PageMaintenanceIdentity, 'backendConnectionId' | 'workspaceId'>;

export interface MaintenanceStatusProps extends MaintenanceIdentity {
  pendingProposals?: number;
  spaceId?: string;
  spaceTitle?: string;
  onOpenJob?: (jobId: string) => void;
}

function jobInfo(value: PageMaintenanceWorkspace | null): ScheduledJobDto | null {
  return value?.job ?? null;
}

function lastRunLabel(value: PageMaintenanceWorkspace | null): string | null {
  const job = jobInfo(value);
  const run = value?.status?.lastRun;
  if (run) {
    const status = run.status.replaceAll('_', ' ');
    return `Last run ${status}${run.finishedAt ? ` · ${new Date(run.finishedAt).toLocaleString()}` : ` · started ${new Date(run.startedAt).toLocaleString()}`}`;
  }
  if (typeof job?.lastRunAt === 'number') {
    const status = job.lastStatus ? job.lastStatus.replaceAll('_', ' ') : 'started';
    return `Last run ${status} · ${new Date(job.lastRunAt).toLocaleString()}`;
  }
  return null;
}

export function MaintenanceStatus({ backendConnectionId, workspaceId, pendingProposals = 0, spaceId, spaceTitle, onOpenJob }: MaintenanceStatusProps) {
  const maintenance = usePageMaintenance({ backendConnectionId, workspaceId });
  const { value, loading, busy } = maintenance;
  const config = value?.config ?? null;
  const job = jobInfo(value);
  const [catchUpQueued, setCatchUpQueued] = React.useState<string | null>(null);

  const updating = Boolean(job?.activeRunId)
    || value?.backlog.plans.some((plan) => plan.state === 'routing' || plan.state === 'processing');
  const pending = value?.backlog.pendingSources ?? value?.status?.pendingSources ?? 0;
  const attention = value?.backlog.attentionSources ?? value?.status?.attentionSources ?? 0;
  const lastStatus = typeof job?.lastStatus === 'string' ? job.lastStatus : value?.status?.lastRun?.status;
  const schedulerUnavailable = value?.scheduler === 'unavailable';
  const failed = schedulerUnavailable || lastStatus === 'failed' || lastStatus === 'timed_out' || lastStatus === 'interrupted' || job?.autoPaused === true;
  const notConfigured = !config;
  const paused = Boolean(config && (!config.enabled || config.paused || job?.enabled === false || job?.autoPaused === true));
  const stateLabel = loading ? 'Loading status' : maintenance.error ? 'Status unavailable' : notConfigured ? 'Not enabled' : attention > 0 ? 'Needs attention' : failed ? 'Last update failed'
    : updating ? 'Updating' : paused ? 'Paused' : pending > 0 ? `${pending} new turns waiting` : 'Up to date';
  const statusDetail = maintenance.error
    ? 'The latest maintenance status could not be loaded. Retry to confirm the current cursor and run state.'
    : schedulerUnavailable
    ? 'The workspace backend scheduler is unavailable. Maintenance will resume only when the backend and selected runtime are available.'
    : attention > 0
    ? `${attention} source ${attention === 1 ? 'turn needs' : 'turns need'} attention.`
    : failed
      ? (typeof job?.lastError === 'string' && job.lastError ? job.lastError : 'The last scheduled check did not finish successfully.')
      : updating
        ? 'The Meta agent is reading completed conversations and updating the workspace’s pages.'
        : notConfigured
          ? 'Enable updates to use new conversations in this workspace. Older conversations are not read automatically.'
          : paused
          ? 'Automatic maintenance is paused. Completed conversations are not being processed while paused.'
          : pending > 0
            ? 'Newly completed conversations are waiting to be read.'
            : 'All available conversations have been reviewed for page updates.';
  const excluded = Boolean(spaceId && value?.excludedSpaceIds.includes(spaceId));
  const jobId = config?.jobId;
  const runNow = async () => { await maintenance.runNow(); };
  const enableOrPause = async () => {
    await maintenance.update({
      ...(config ? { expectedRevision: config.revision } : {}),
      enabled: true,
      paused: false,
    });
  };
  const togglePause = async () => {
    if (!config) return;
    await maintenance.update({ expectedRevision: config.revision, enabled: true, paused: !config.paused });
  };
  const safeAction = (action: () => Promise<void>) => (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    void action().catch(() => undefined);
  };

  return (
    <section aria-label="Workspace conversation maintenance" style={{ color: 'var(--term-fg)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <p style={{ margin: '0 0 5px', color: 'var(--term-muted)', fontSize: 'var(--fs-xs)', letterSpacing: 'var(--ls-caps)', textTransform: 'uppercase' }}>Conversation maintenance</p>
          <h3 aria-live="polite" style={{ margin: 0, fontSize: 'var(--fs-lg)' }}>{stateLabel}</h3>
          <p style={{ margin: '5px 0 0', color: 'var(--term-muted)', fontSize: 'var(--fs-sm)', maxWidth: 680 }}>{statusDetail}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {paused || notConfigured ? <button type="button" disabled={busy || loading} onClick={safeAction(enableOrPause)}>{busy ? 'Saving…' : 'Enable updates'}</button>
            : <button type="button" disabled={busy || loading} onClick={safeAction(togglePause)}>{busy ? 'Saving…' : 'Pause'}</button>}
          <button type="button" disabled={busy || loading || paused || notConfigured || updating} onClick={safeAction(runNow)}>{busy ? 'Working…' : 'Run now'}</button>
          {jobId && onOpenJob && <button type="button" onClick={() => onOpenJob(jobId)}>Open job</button>}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginTop: 10, color: 'var(--term-muted)', fontSize: 'var(--fs-xs)' }}>
        {lastRunLabel(value) && <span>{lastRunLabel(value)}</span>}
        {pendingProposals > 0 && <strong style={{ color: 'var(--term-fg)' }}>{pendingProposals} {pendingProposals === 1 ? 'suggestion' : 'suggestions'} waiting for review</strong>}
      </div>

      <p style={{ margin: '12px 0 0', color: 'var(--term-muted)', fontSize: 'var(--fs-xs)' }}>
        Runs on the Meta agent{value?.runtime ? `: ${runtimeLine(value.runtime)}` : ''}.{' '}
        {backendConnectionId === LOCAL_BACKEND_CONNECTION_ID
          ? <button type="button" onClick={requestMetaAgentSettings}>Change in Settings › Meta agent</button>
          : 'It is set in Settings › Meta agent on that machine.'}
      </p>

      {spaceId && <div style={{ borderTop: '1px solid var(--term-line)', marginTop: 12, paddingTop: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)' }}>
          <input type="checkbox" checked={!excluded} disabled={busy || loading} onChange={(event) => void maintenance.setSpaceExcluded(spaceId, !event.target.checked).catch(() => undefined)} />
          Keep {spaceTitle ? `“${spaceTitle}”` : 'this page'} up to date from workspace conversations
        </label>
        {excluded && <div style={{ marginTop: 7, color: 'var(--term-muted)', fontSize: 'var(--fs-xs)' }}>
          Re-enable this page before queueing an explicit catch-up of recent completed conversations. Re-enabling alone does not revisit earlier turns.
          {value?.backlog.plans.some((plan) => plan.state === 'attention') && <button type="button" disabled={busy} onClick={() => {
            const plans = value.backlog.plans.filter((plan) => plan.state === 'attention');
            const plan = plans.at(-1);
            const sourceTurnIds = plan?.sources.filter((source) => source.state === 'attention').map((source) => source.sourceTurnId) ?? [];
            if (plan && sourceTurnIds.length) void maintenance.reconsider(plan.id, sourceTurnIds).catch(() => undefined);
          }}>Reconsider attention sources</button>}
        </div>}
        {!excluded && config && (value?.catchUpSuggestions ?? []).some((suggestion) => suggestion.spaceId === spaceId && suggestion.availablePositions > 0) && <div style={{ marginTop: 9, padding: 9, border: '1px solid var(--term-line)', borderRadius: 5 }}>
          <strong style={{ fontSize: 'var(--fs-sm)' }}>Catch up conversations missed while this page was excluded</strong>
          <p style={{ margin: '4px 0 7px', color: 'var(--term-muted)', fontSize: 'var(--fs-xs)' }}>
            Re-enabling this page does not revisit earlier turns. Queue a bounded catch-up for a recorded exclusion period; each request is limited to this page and its current child pages.
          </p>
          {(value?.catchUpSuggestions ?? []).filter((suggestion) => suggestion.spaceId === spaceId && suggestion.availablePositions > 0).map((suggestion) => <div key={suggestion.periodId} style={{ paddingTop: 8, marginTop: 8, borderTop: '1px solid var(--term-line)' }}>
            <p style={{ margin: '0 0 6px', color: 'var(--term-muted)', fontSize: 'var(--fs-xs)' }}>
              Excluded {new Date(suggestion.excludedAt).toLocaleString()} · re-enabled {new Date(suggestion.reenabledAt).toLocaleString()}. Queue completion positions {suggestion.after + 1}–{suggestion.through} ({suggestion.availablePositions} available, up to {suggestion.maxPositions} per request).
            </p>
            {suggestion.latestSources.length > 0 && <ul style={{ margin: '0 0 7px', paddingLeft: 18, color: 'var(--term-muted)', fontSize: 'var(--fs-xs)' }}>
              {suggestion.latestSources.map((source) => <li key={source.turnId}>{new Date(source.completedAt).toLocaleString()} · {source.preview || `Completion position ${source.completionSeq}`}</li>)}
              {suggestion.sourceCount > suggestion.latestSources.length && <li>and {suggestion.sourceCount - suggestion.latestSources.length} more conversation {suggestion.sourceCount - suggestion.latestSources.length === 1 ? 'turn' : 'turns'}</li>}
            </ul>}
            <button type="button" disabled={busy || updating} onClick={(event) => {
              event.preventDefault();
              void maintenance.catchUp(spaceId, suggestion.after, suggestion.through)
                .then((queued) => setCatchUpQueued(`Catch-up queued for completion positions ${queued.after + 1}–${queued.through}.`))
                .catch(() => undefined);
            }}>{busy ? 'Queueing…' : 'Queue this period'}</button>
          </div>)}
          {catchUpQueued && <p role="status" style={{ margin: '6px 0 0', color: 'var(--term-muted)', fontSize: 'var(--fs-xs)' }}>{catchUpQueued}</p>}
        </div>}
      </div>}
      {maintenance.error && <p role="alert" style={{ marginBottom: 0, color: 'var(--term-danger)' }}>{maintenance.error}<button type="button" onClick={maintenance.refresh}>Retry</button></p>}
      {value?.backlog.plans.filter((plan) => plan.state === 'attention').map((plan) => {
        const sources = plan.sources.filter((source) => source.state === 'attention');
        return <div key={plan.id} style={{ marginTop: 10, paddingTop: 9, borderTop: '1px solid var(--term-line)' }}>
          <strong>Needs attention · {sources.length} source {sources.length === 1 ? 'turn' : 'turns'}</strong>
          {sources.map((source) => <div key={source.sourceTurnId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 5, fontSize: 'var(--fs-xs)' }}>
            <span>{source.terminalReason || `Source turn at sequence ${source.completionSeq}`}</span>
            <button type="button" disabled={busy} onClick={() => void maintenance.reconsider(plan.id, [source.sourceTurnId]).catch(() => undefined)}>Reconsider</button>
          </div>)}
        </div>;
      })}
    </section>
  );
}

/** "Claude · claude-opus-5.5 (follows global)". */
function runtimeLine(runtime: MetaAgentResolvedRuntime): string {
  const parts = [metaAgentRuntimeLabel(runtime.runtimeId), runtime.modelId].filter(Boolean).join(' · ');
  return `${parts} (${runtime.followsGlobal ? 'follows global' : 'custom'})`;
}

export default MaintenanceStatus;
