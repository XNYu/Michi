import React from 'react';
import { RefreshCw } from 'lucide-react';
import type { PageLayoutRule, WorkspaceHomeSummaryDto } from 'michi-shared';
import { useProgressCards, useSpaceActivity, useSpacesHome, useSpacesHomeWorkspaces } from '../../../../state/pages/useSpacesHome';
import { retryMetaAgentGuard, useMetaAgent } from '../../../../state/metaAgent/useMetaAgent';
import { metaAgentStatus, type MetaAgentStatusKind } from '../../../../state/metaAgent/metaAgentStatus';
import { firstRunActive, firstRunProgress, retrySpacesFirstRunNow, spacesHomeUpdating, useSpacesFirstRun } from '../../../../state/metaAgent/spacesFirstRun';
import { resumeMetaAgent, useMetaAgentOverview } from '../../../../state/metaAgent/useMetaAgentOverview';
import { retryStoppedMetaAgent, runMetaAgentUpdate, useMetaAgentUpdate } from '../../../../state/metaAgent/metaAgentUpdate';
import { requestWorkspaceHome } from '../../../../state/pages/workspaceHomeNav';
import { Button } from '../../../ui/controls';
import { useMinuteClock } from '../../content/home/useMinuteClock';
import { openMetaAgentDetail, requestMetaAgentSettings } from '../../scheduled/metaAgent/metaAgentNav';
import { MetaAgentGuardAlert } from '../../settings/metaAgent/MetaAgentGuardAlert';
import { metaAgentRuntimeLabel } from '../../settings/metaAgent/runtimeCopy';
import { HomePlaceholder, useHomeDocument } from './HomeDocument';
import { HomeSectionBlock } from './HomeSections';
import { SpaceActivityList } from './HomeActivity';
import { NewChatSheetSlot, SpaceProgressCardList, type SpaceConversationScope } from './homeLinks';
import { DEFAULT_META_STATUS, MetaAgentStatusLine, type MetaAgentHomeStatus, type MetaAgentLineMode } from './MetaAgentStatusLine';
import { homeAge, homeDateLabel, latestAgentWrite, splitHomeBlocks } from './homeFormat';
import { useHomeNavigation } from './useHomeNavigation';
import { useSpacesHomeSections } from './homeCounts';
import { useMarkSpacesHomeLookedOnLeave } from './useMarkSpacesHomeLooked';
import { LayoutRulesMenuButton } from '../layoutRules/LayoutRulesMenu';
import { LayoutRuleSectionMarks } from '../layoutRules/LayoutRuleSectionMarks';
import './home.css';

export interface SpacesHomeViewProps {
  /** The backend connection whose Spaces Home this is. */
  backendConnectionId?: string;
  now?: Date;
  /** Overrides what the status line says about the Meta agent's ordinary state. */
  meta?: Partial<MetaAgentHomeStatus>;
  /** Replaces Update's own round (one Meta agent run per workspace with new conversations). */
  onUpdate?: () => void;
}

const openScheduledMetaAgent = () => {
  openMetaAgentDetail();
  window.dispatchEvent(new CustomEvent('michi:nav-page', { detail: { page: 'scheduled' } }));
};

/** The status line's mode for each state; a failed restriction check shows its own alert instead. */
const LINE_MODE: Record<MetaAgentStatusKind, MetaAgentLineMode> = {
  offline: 'offline', 'guard-failed': 'stopped', 'not-running': 'not-running', unsupported: 'unavailable', stopped: 'stopped',
  'first-run': 'first-run', paused: 'paused', 'just-read': 'just-read', normal: 'normal',
};

/** A table row on the Home whose first cell names a workspace opens that workspace's home. */
function useWorkspaceRowLinks(ref: React.RefObject<HTMLElement | null>, workspaces: readonly WorkspaceHomeSummaryDto[], connectionId: string) {
  React.useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const byName = new Map(workspaces.map((workspace) => [workspace.workspaceName.trim().toLowerCase(), workspace.workspaceId] as const));
    for (const row of Array.from(root.querySelectorAll<HTMLTableRowElement>('.spaces-home-blocks tbody tr'))) {
      const id = byName.get(row.cells[0]?.textContent?.trim().toLowerCase() ?? '');
      // A linked row opens its workspace, so a click on it does not also target the table's block.
      if (id) { row.setAttribute('data-home-workspace', id); row.setAttribute('data-michi-interactive', ''); }
      else { row.removeAttribute('data-home-workspace'); row.removeAttribute('data-michi-interactive'); }
    }
  });
  return React.useCallback((event: React.MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('a, button, input, textarea, [contenteditable="true"]')) return;
    const row = target.closest<HTMLElement>('tr[data-home-workspace]');
    const workspaceId = row?.getAttribute('data-home-workspace');
    if (workspaceId) requestWorkspaceHome({ workspaceId, backendConnectionId: connectionId });
  }, [connectionId]);
}

/**
 * The Spaces landing page. It is a real page: its own blocks edit like any
 * other, and between them sit the sections Michi counts from its own
 * conversations (Waiting, Stalled, Done), Space activity and the cards of
 * conversations started from a Space.
 */
const NO_RULES: readonly PageLayoutRule[] = [];

export function SpacesHomeView({ backendConnectionId = 'local', now, meta, onUpdate }: SpacesHomeViewProps) {
  const clock = useMinuteClock(true);
  const home = useSpacesHome(backendConnectionId);
  const workspaces = useSpacesHomeWorkspaces(backendConnectionId);
  const sections = useSpacesHomeSections(backendConnectionId);
  // Just done counts from the last look; leaving this page, once it showed the sections, is that look.
  useMarkSpacesHomeLookedOnLeave(backendConnectionId, sections.data !== null);
  const activity = useSpaceActivity(backendConnectionId);
  const cards = useProgressCards(backendConnectionId);
  const agent = useMetaAgent();
  const firstRun = useSpacesFirstRun(backendConnectionId);
  const overview = useMetaAgentOverview();
  const update = useMetaAgentUpdate();
  const running = firstRunActive(firstRun.data);
  const doc = useHomeDocument({
    backendConnectionId,
    initial: home.data?.page ?? null,
    allowEmptyEditor: !running,
    workspaceHomes: firstRun.data?.workspaces ?? workspaces.data,
  });
  const page = doc.page;
  const nav = useHomeNavigation(backendConnectionId, page?.id ?? null);
  const rootRef = React.useRef<HTMLElement>(null);
  const homes = firstRun.data?.workspaces ?? workspaces.data ?? [];
  const onBlocksClick = useWorkspaceRowLinks(rootRef, homes, backendConnectionId);
  const openWorkspace = React.useCallback((workspaceId: string) => requestWorkspaceHome({ workspaceId, backendConnectionId }), [backendConnectionId]);

  const info = agent.info;
  const agentState = metaAgentStatus({
    info, infoStatus: agent.status, firstRun, overview: overview.overview, offline: home.stale, runtimeLabel: metaAgentRuntimeLabel,
  });
  const offline = agentState.kind === 'offline';
  const failures = agentState.kind === 'guard-failed' ? agentState.guardFailures : [];
  const runtimeId = info?.resolved.runtimeId;
  const status: MetaAgentHomeStatus = {
    ...DEFAULT_META_STATUS,
    runtimeLabel: runtimeId ? metaAgentRuntimeLabel(runtimeId) : null,
    followsGlobal: info?.resolved.followsGlobal,
    lastWrite: latestAgentWrite(activity.data),
    ...meta,
  };
  const mode = LINE_MODE[agentState.kind];
  const showAgentStatus = mode !== 'normal' || update.phase === 'failed'
    || overview.overview?.cursors?.some(cursor => cursor.problem);

  const update_ = () => {
    home.refresh();
    workspaces.refresh();
    sections.refresh();
    activity.refresh();
    cards.refresh();
    doc.pageState.refresh();
    if (onUpdate) onUpdate();
    else void runMetaAgentUpdate(backendConnectionId);
  };

  const retryGuard = async () => {
    await retryMetaAgentGuard();
    if (firstRun.data?.haltedReason || firstRunProgress(firstRun.data).failed.length > 0) await retrySpacesFirstRunNow(backendConnectionId);
  };

  const blocks = page?.blocks ?? [];
  const segments = splitHomeBlocks(blocks);
  const empty = page !== null && blocks.length === 0;
  const homeScope: SpaceConversationScope = { backendConnectionId, pageId: page?.id ?? null, workspaceId: null, workspaceName: null, pageTitle: 'Home' };

  return (
    <main ref={rootRef} className="area-settings michi-doc space-doc spaces-home" aria-labelledby="spaces-home-title" onClick={onBlocksClick}>
      <div className="area-settings__doc spaces-home__doc">
        <NewChatSheetSlot scope={homeScope} />
        <header className="spaces-home__head">
          <div className="spaces-home__title-row">
            <h1 id="spaces-home-title" className="spaces-home__title">Home</h1>
            <span className="spaces-home__date">{homeDateLabel(now ?? new Date(clock))}</span>
            <span className="spaces-home-spacer" />
            <Button size="sm" className="spaces-home__update" onClick={update_} disabled={offline || update.phase === 'running'} aria-busy={update.phase === 'running' || undefined}>
              <RefreshCw size={12} strokeWidth={1.8} aria-hidden="true" />Update
            </Button>
            <LayoutRulesMenuButton pageId={page?.id ?? null} backendConnectionId={backendConnectionId} readOnly={offline} />
          </div>
          {page && blocks.length > 0 && <p className="spaces-home__updated">
            <time dateTime={new Date(page.updatedAt).toISOString()} title={new Date(page.updatedAt).toLocaleString()}>Updated {homeAge(page.updatedAt, clock)}</time>
          </p>}
        </header>
        {failures.length > 0 && !offline
          ? <MetaAgentGuardAlert failures={failures} onRetry={retryGuard} onChangeRuntime={requestMetaAgentSettings} />
          : showAgentStatus && <MetaAgentStatusLine
            status={status}
            showLastWrite={false}
            workspaces={workspaces.data}
            clock={clock}
            mode={mode}
            reason={agentState.reason}
            stop={agentState.stop}
            firstRunDays={info?.settings.firstRunDays}
            firstRun={firstRun.data}
            cursors={overview.overview?.cursors}
            recentRuns={overview.overview?.recentRuns}
            update={update}
            homeUpdating={spacesHomeUpdating(firstRun.data)}
            onOpenScheduled={openScheduledMetaAgent}
            onOpenSettings={requestMetaAgentSettings}
            onResume={() => { void resumeMetaAgent(); }}
            onRetry={() => retryStoppedMetaAgent(backendConnectionId)}
            onOpenWorkspace={openWorkspace}
            onRetryWorkspace={(workspaceId) => { void retrySpacesFirstRunNow(backendConnectionId, workspaceId); }}
          />}
        {home.status === 'error' && !page && <p className="spaces-home-muted" role="alert">
          {home.error || 'The Pages Home could not be loaded.'} <button type="button" className="spaces-home-link" onClick={home.refresh}>Retry</button>
        </p>}
        {home.stale && <p className="spaces-home-muted" role="status">Showing the last saved Home. Reconnect before editing.</p>}

        {empty ? <HomePlaceholder /> : doc.renderBlocks(segments.lead, 'lead')}
        <SpaceProgressCardList scope={homeScope} cards={cards.data ?? []} everyPage onChanged={cards.refresh} />
        {empty ? <HomePlaceholder title="This week’s focus" /> : doc.renderBlocks(segments.middle, 'middle')}
        <SpaceActivityList items={activity.data} clock={clock} onOpen={nav.openActivity} />
        {empty ? <HomePlaceholder title="Workspaces" /> : doc.renderBlocks(segments.beforeThreads, 'before-threads')}
        <HomeSectionBlock section="stalled" connectionId={backendConnectionId} data={sections.data?.stalled ?? null} clock={clock} onAct={nav.openSectionItem} onOpenWorkspace={openWorkspace}>
          <LayoutRuleSectionMarks pageId={page?.id ?? null} backendConnectionId={backendConnectionId} rules={home.data?.layoutRules ?? NO_RULES} ruleIds={sections.data?.stalled.ruleIds} />
        </HomeSectionBlock>
        <HomeSectionBlock section="done" connectionId={backendConnectionId} data={sections.data?.done ?? null} clock={clock} onAct={nav.openSectionItem} onOpenWorkspace={openWorkspace}>
          <LayoutRuleSectionMarks pageId={page?.id ?? null} backendConnectionId={backendConnectionId} rules={home.data?.layoutRules ?? NO_RULES} ruleIds={sections.data?.done.ruleIds} />
        </HomeSectionBlock>
        {empty && <HomePlaceholder title="Cross-workspace decisions" />}
        {doc.renderBlocks(segments.rest, 'rest')}
      </div>
    </main>
  );
}

export default SpacesHomeView;
