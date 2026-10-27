import React from 'react';
import type { FirstRunProgressDto } from 'michi-shared';
import { useMetaAgent } from '../../../../state/metaAgent/useMetaAgent';
import { firstRunProgress, isWorkspaceHomeNew, useSpacesFirstRun } from '../../../../state/metaAgent/spacesFirstRun';
import { useMetaAgentOverview } from '../../../../state/metaAgent/useMetaAgentOverview';
import { META_AGENT_HEADLINE, metaAgentStatus } from '../../../../state/metaAgent/metaAgentStatus';
import { metaAgentRuntimeLabel } from '../../settings/metaAgent/runtimeCopy';
import './sidebarStatus.css';

/** The Spaces sidebar's bottom row: what the Meta agent is doing, or why it is not. The Home says why in full. */
export function MetaAgentSidebarStatus({ connectionId = 'local', onOpenHome }: { connectionId?: string; onOpenHome(): void }) {
  const agent = useMetaAgent();
  const firstRun = useSpacesFirstRun(connectionId);
  const overview = useMetaAgentOverview();
  const info = agent.info;
  const status = metaAgentStatus({ info, infoStatus: agent.status, firstRun, overview: overview.overview, runtimeLabel: metaAgentRuntimeLabel });
  const seeWhy = (headline: string, tone?: 'warn') => (
    <span title={status.reason ?? undefined}>
      {headline} · <button type="button" className="spaces-side-foot-link" data-tone={tone} onClick={onOpenHome}>See why</button>
    </span>
  );
  switch (status.kind) {
    case 'offline':
      return <><span className="area-side__foot-dot" data-tone="off" aria-hidden="true" /><span>{META_AGENT_HEADLINE.offline}</span></>;
    case 'guard-failed':
    case 'stopped':
      return <><span className="area-side__foot-dot" data-tone="danger" aria-hidden="true" />{seeWhy(META_AGENT_HEADLINE[status.kind])}</>;
    case 'not-running':
    case 'unsupported':
      return <><span className="area-side__foot-dot" data-tone="warn" aria-hidden="true" />{seeWhy(META_AGENT_HEADLINE[status.kind], 'warn')}</>;
    case 'first-run': {
      const progress = firstRunProgress(firstRun.data);
      return <><span className="agent-spinner" aria-hidden="true" /><span>Meta agent is reading {progress.read}/{progress.total}</span></>;
    }
    case 'paused':
      return <><span className="area-side__foot-dot" data-tone="off" aria-hidden="true" /><span>{META_AGENT_HEADLINE.paused}</span></>;
    default:
      return <>
        <span className="area-side__foot-dot" data-tone="ok" aria-hidden="true" />
        <span>Meta agent{info ? ` · ${metaAgentRuntimeLabel(info.resolved.runtimeId)}` : ''} · checks new conversations every 60 s</span>
      </>;
  }
}

/** What a workspace row shows about its first read: progress, queued, failed, or New until opened. */
export function WorkspaceFirstRunBadge({ connectionId, workspaceId, run }: { connectionId: string; workspaceId: string; run: FirstRunProgressDto | null | undefined }) {
  if (!run) return null;
  if (run.state === 'reading' || run.state === 'writing') {
    return <>
      <span className="agent-spinner" aria-hidden="true" />
      <span className="spaces-side-progress" aria-label={`Reading ${run.readCount} of ${run.total}`}>{run.readCount}/{run.total}</span>
    </>;
  }
  if (run.state === 'queued') return <span className="spaces-side-progress">Queued</span>;
  if (run.state === 'failed') return <span className="spaces-side-progress" data-tone="danger">Not written</span>;
  return isWorkspaceHomeNew(connectionId, workspaceId, run) ? <span className="spaces-side-new">New</span> : null;
}
