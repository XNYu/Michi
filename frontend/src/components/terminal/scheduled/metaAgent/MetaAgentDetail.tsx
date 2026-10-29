import React from 'react';
import { ChevronRight, GitBranch, MessageSquare, Pause, Play, Shield } from 'lucide-react';
import { toast } from 'sonner';
import type { MetaAgentCursorRow, MetaAgentOverview, MetaAgentRecentRun } from 'michi-shared';
import { Button } from '../../../ui/controls';
import { useChatActions } from '../../../../state/chatStore';
import {
  cursorStateLabel, firstRunText, lastSeen, quietText, readRange, readSteps, restrictionText, runTime, runTitle, runtimeText, summaryText,
} from './metaAgentCopy';
import { META_AGENT_PAGE_TITLE, requestMetaAgentSettings } from './metaAgentNav';
import { pauseMetaAgentMaintenance, refreshMetaAgentOverview, useMetaAgentOverview } from './useMetaAgentOverview';
import { refreshMetaAgent, useMetaAgent } from '../../../../state/metaAgent/useMetaAgent';
import { META_AGENT_HEADLINE, metaAgentStatus, type MetaAgentStatus } from '../../../../state/metaAgent/metaAgentStatus';
import { metaAgentRuntimeLabel } from '../../settings/metaAgent/runtimeCopy';
import { runMetaAgentUpdate } from '../../../../state/metaAgent/metaAgentUpdate';
import '../../pages/Scheduled.css';
import './metaAgent.css';

const STATE_LABELS: Record<MetaAgentOverview['state'], string> = { running: 'Running', paused: 'Paused', error: 'Error' };

/** The tag beside the kicker, from the same status the Spaces sidebar and Home read. */
export function metaAgentStateTag(status: MetaAgentStatus, overview: MetaAgentOverview): { state: string; label: string } {
  switch (status.kind) {
    case 'guard-failed': case 'stopped': return { state: 'error', label: STATE_LABELS.error };
    case 'not-running': case 'unsupported': return { state: 'off', label: 'Not running' };
    case 'paused': return { state: 'paused', label: STATE_LABELS.paused };
    case 'offline': return { state: overview.state, label: STATE_LABELS[overview.state] };
    default: return { state: 'running', label: STATE_LABELS.running };
  }
}

function tone(row: MetaAgentRecentRun): string {
  if (row.state === 'failed') return 'error';
  if (row.kind === 'first-run') return 'first';
  if (row.kind === 'summary') return 'summary';
  if (row.noModelCall) return 'quiet';
  return row.state === 'done' ? 'read' : row.state;
}

function dotTone(state: MetaAgentCursorRow['state']): string | undefined {
  return state === 'next' ? 'waiting' : state === 'error' ? 'error' : undefined;
}

/** A run that read in its own conversation, which background maintenance keeps out of the conversation lists. */
export type MetaAgentRunTarget = { workspaceId: string; nodeId: string };

function runTarget(row: MetaAgentRecentRun): MetaAgentRunTarget | null {
  return row.nodeId && row.workspaceId ? { workspaceId: row.workspaceId, nodeId: row.nodeId } : null;
}

function RunItem({ row, now, onOpenRun }: { row: MetaAgentRecentRun; now: number; onOpenRun?: (target: MetaAgentRunTarget) => void }) {
  const body = <>
    <div className="meta-sched__run-title">{runTitle(row)}<span className="meta-sched__time">{runTime(row, now)}</span></div>
    <div className="meta-sched__run-text">
      {row.kind === 'first-run' ? firstRunText(row)
        : row.kind === 'summary' ? summaryText(row)
        : row.noModelCall || row.state === 'failed' ? quietText(row)
          : <><code>{readRange(row)}</code>{readSteps(row).map((step) => ` → ${step}`).join('')}</>}
    </div>
  </>;
  const target = onOpenRun ? runTarget(row) : null;
  return (
    <li className="meta-sched__run" data-tone={tone(row)}>
      {target ? (
        <button type="button" className="meta-sched__run-open t-row-hover t-row-focus" onClick={() => onOpenRun!(target)}
          aria-label={`${runTitle(row)}, ${runTime(row, now)}, open its conversation`}>
          <span className="meta-sched__run-main">{body}</span>
          <span className="sched-run-open"><MessageSquare size={14} aria-hidden="true" /><ChevronRight size={14} aria-hidden="true" /></span>
        </button>
      ) : body}
    </li>
  );
}

/** Scheduled › Meta agent: what the background maintenance is doing and where each workspace's cursor stands. */
export function MetaAgentDetail({ overview, status: given, now, busy, onTogglePause, onOpenSettings, onRetry, onOpenRun }: {
  overview: MetaAgentOverview;
  /** The shared Meta agent status; read from the overview alone when not given. */
  status?: MetaAgentStatus;
  now: number;
  busy: boolean;
  onTogglePause: (paused: boolean) => void;
  onOpenSettings: () => void;
  /** Restart what stopped after failures and run one round now; not offered when only Settings can fix it. */
  onRetry?: () => void;
  /** Opens a recent run's conversation; rows that name none (merged checks, the first read) stay plain. */
  onOpenRun?: (target: MetaAgentRunTarget) => void;
}) {
  const { runtime, today, cursors, recentRuns } = overview;
  const status = given ?? metaAgentStatus({ overview });
  const tag = metaAgentStateTag(status, overview);
  const paused = overview.state === 'paused';
  const stopped = status.kind === 'stopped' || status.kind === 'guard-failed';
  const stop = status.stop;
  return (
    <main className="area-settings meta-sched term-scrollbar" aria-labelledby="meta-sched-title">
      <div className="area-settings__doc meta-sched__doc">
        <header className="meta-sched__head">
          <p className="area-settings__kicker meta-sched__kicker">
            Scheduled · System · <span className="meta-sched__tag" data-state={tag.state}>{tag.label}</span>
          </p>
          {/* Pausing needs the scheduler, which is what is missing while not running. */}
          {cursors.length > 0 && status.kind !== 'not-running' && (
            <Button size="sm" className="meta-sched__pause" disabled={busy} onClick={() => onTogglePause(!paused)}
              aria-label={paused ? 'Resume background updates' : 'Pause background updates'}>
              {paused ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}{paused ? 'Resume' : 'Pause'}
            </Button>
          )}
          <h1 id="meta-sched-title" className="area-settings__title meta-sched__title">{META_AGENT_PAGE_TITLE}</h1>
          <p className="meta-sched__line">One background check every 60 seconds finds pending work across workspaces. AI runs only when there is work to process.</p>
          {overview.lastCheckedAt != null && <p className="meta-sched__line">Last checked {lastSeen(overview.lastCheckedAt, now)} · no AI used for checks</p>}
          {stopped && (
            <p className="meta-sched__status" role="alert">
              {META_AGENT_HEADLINE.stopped}: {status.reason ?? 'reason unknown'}
              {onRetry && <> · <button type="button" className="meta-sched__link" disabled={busy} onClick={onRetry}>Retry</button></>}
              {' · '}<button type="button" className="meta-sched__link" onClick={onOpenSettings}>Open Settings › Meta agent</button>
              {stop?.detail && <span className="meta-sched__status-detail">{stop.detail}</span>}
            </p>
          )}
          {status.kind === 'unsupported' && (
            <p className="meta-sched__status" role="alert">
              {META_AGENT_HEADLINE.unsupported}: {status.reason}
              {' · '}<button type="button" className="meta-sched__link" onClick={onOpenSettings}>Open Settings › Meta agent</button>
            </p>
          )}
          {status.kind === 'not-running' && <p className="meta-sched__status" data-state="off" role="status">{META_AGENT_HEADLINE['not-running']}: {status.reason}</p>}
          {paused && status.kind === 'paused' && <p className="meta-sched__status" data-state="paused">Background updates are paused: new conversations aren’t read and pages aren’t updated. The chat window in Pages still works.</p>}
          <div className="meta-sched__src">
            <GitBranch size={12} aria-hidden="true" />
            <span>{runtimeText(runtime)} · </span>
            <button type="button" className="meta-sched__link" onClick={onOpenSettings} aria-label="Change the Meta agent’s AI service">Change</button>
          </div>
          <div className="meta-sched__src"><Shield size={12} aria-hidden="true" /><span>Limits: {restrictionText(runtime.runtimeId)}</span></div>
        </header>

        <dl className="meta-sched__metrics">
          <div className="meta-sched__metric">
            <dt>Checks today</dt><dd className="meta-sched__value">{today.checks}</dd>
            <dd>{today.checksTruncated ? 'or more (older runs were pruned)' : 'times'}</dd>
          </div>
          <div className="meta-sched__metric">
            <dt>AI calls</dt><dd className="meta-sched__value">{today.modelCalls}</dd>
            <dd>maintenance sessions started</dd>
          </div>
          <div className="meta-sched__metric">
            <dt>Page changes</dt><dd className="meta-sched__value">{today.writes}</dd>
            <dd>{today.pendingProposals > 0 ? `${today.pendingProposals} ${today.pendingProposals === 1 ? 'suggestion' : 'suggestions'} for you` : 'no suggestions for you'}</dd>
          </div>
        </dl>

        <section aria-labelledby="meta-sched-cursors">
          <h2 id="meta-sched-cursors" className="meta-sched__h2">How far each workspace is read</h2>
          {cursors.length === 0 ? <p className="meta-sched__note">No workspace has background updates turned on yet.</p> : (
            <table className="meta-sched__table">
              <thead><tr><th>Workspace</th><th>Read up to</th><th>Not read yet</th><th>Last read</th><th>State</th></tr></thead>
              <tbody>
                {cursors.map((row) => (
                  <tr key={row.workspaceId}>
                    <td><span className="meta-sched__ws"><span className="area-side__dot meta-sched__dot" data-tone={dotTone(row.state)} aria-hidden="true" />{row.workspaceName}</span></td>
                    <td className="meta-sched__mono">#{row.cursor}</td>
                    <td className="meta-sched__mono">{row.unread}</td>
                    <td>{lastSeen(row.lastRunAt, now)}</td>
                    <td title={row.error}>{cursorStateLabel(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="meta-sched__note">The number counts finished conversation turns in each workspace. It moves on only after the pages are updated.</p>
        </section>

        <section aria-labelledby="meta-sched-runs">
          <h2 id="meta-sched-runs" className="meta-sched__h2">Recent runs</h2>
          {recentRuns.length === 0 ? <p className="meta-sched__note">No runs yet.</p> : (
            <ol className="meta-sched__runs">{recentRuns.map((row, i) => <RunItem key={`${row.at}-${i}`} row={row} now={now} onOpenRun={onOpenRun} />)}</ol>
          )}
        </section>
      </div>
    </main>
  );
}

/** The Scheduled area's main column while the Meta agent row is selected. */
export default function MetaAgentScheduledPage({ onOpenSettings = requestMetaAgentSettings }: { onOpenSettings?: () => void } = {}) {
  const load = useMetaAgentOverview();
  const agent = useMetaAgent();
  const [busy, setBusy] = React.useState(false);
  const { revealBackendNode } = useChatActions();

  const openRun = (target: MetaAgentRunTarget) => {
    void revealBackendNode(target.workspaceId, target.nodeId).then((opened) => {
      if (!opened) toast.error('That conversation is no longer available');
    }, () => { toast.error('That conversation is no longer available'); });
  };

  const togglePause = (paused: boolean) => {
    setBusy(true);
    pauseMetaAgentMaintenance(paused)
      .catch((reason: unknown) => { toast.error(reason instanceof Error ? reason.message : 'Couldn’t change the background updates'); void refreshMetaAgentOverview(); })
      .finally(() => setBusy(false));
  };

  // Resuming restarts what stopped after failures; the round then runs through Update's path, guard retry included.
  const retry = () => {
    setBusy(true);
    pauseMetaAgentMaintenance(false)
      .then(() => refreshMetaAgent())
      .then(() => runMetaAgentUpdate('local'))
      .catch((reason: unknown) => { toast.error(reason instanceof Error ? reason.message : 'Could not retry the Meta agent'); })
      .finally(() => { setBusy(false); void refreshMetaAgentOverview(); });
  };

  if (load.kind !== 'ready') {
    return (
      <main className="area-settings meta-sched term-scrollbar" aria-label="Meta agent · Maintain Pages">
        <div className="area-settings__doc meta-sched__doc">
          <p className="area-settings__kicker meta-sched__kicker">Scheduled · System</p>
          <h1 className="area-settings__title meta-sched__title">{META_AGENT_PAGE_TITLE}</h1>
          {load.kind === 'loading' && <div className="sched-loading" role="status" aria-label="Loading the Meta agent’s status"><span /><span /></div>}
          {load.kind === 'unavailable' && <p className="meta-sched__note">This Michi backend does not report the Meta agent’s maintenance yet.</p>}
          {load.kind === 'failed' && (
            <p className="meta-sched__status" role="alert">Could not read the Meta agent’s status: {load.message} · <button type="button" className="meta-sched__link" onClick={() => { void refreshMetaAgentOverview(); }}>Retry</button></p>
          )}
        </div>
      </main>
    );
  }
  const status = metaAgentStatus({ info: agent.info, infoStatus: agent.status, overview: load.overview, runtimeLabel: metaAgentRuntimeLabel });
  return <MetaAgentDetail overview={load.overview} status={status} now={load.at} busy={busy} onTogglePause={togglePause} onOpenSettings={onOpenSettings} onRetry={retry} onOpenRun={openRun} />;
}
