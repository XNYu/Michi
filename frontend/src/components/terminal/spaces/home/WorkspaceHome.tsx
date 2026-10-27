import React from 'react';
import { ChevronRight, FileText, MessageSquare, Plus, Sparkles } from 'lucide-react';
import { META_AGENT_DEFAULT_FIRST_RUN_DAYS, type FirstRunProgressDto, type HomeSectionKey, type SpacesHomeSectionsDto, type WorkspaceHomeDto } from 'michi-shared';
import { useChatActions, useChatNodesSnapshot, useChatProjects } from '../../../../state/chatStore';
import type { ChatNodeState, Project } from '../../../../state/chatTypes';
import { findTreeIdForNode } from '../../../../state/tree';
import { isVisibleConversationNode } from '../../../../state/conversationVisibility';
import { useWorkspaceHome } from '../../../../state/pages/useSpacesHome';
import { useSpaces } from '../../../../state/pages/useSpaces';
import { markWorkspaceHomeOpened, newerFirstRun, retrySpacesFirstRunNow, useSpacesFirstRun } from '../../../../state/metaAgent/spacesFirstRun';
import { REMOTE_SPACES_NOTE, spacesSupportsConnection } from '../../../../state/metaAgent/remoteSpaces';
import { getKnownBackendConnections } from '../../../../config/backendConnections';
import { Button } from '../../../ui/controls';
import { useMinuteClock } from '../../content/home/useMinuteClock';
import { CreateSpaceDialog, type OpenNativePageRoute } from '../SpacesPage';
import { HomePlaceholder, useHomeDocument } from './HomeDocument';
import { homeAge } from './homeFormat';
import { useHomeNavigation } from './useHomeNavigation';
import { NewChatSheetSlot, PageProgressCards, type SpaceConversationScope } from './homeLinks';
import { useSpacesHomeSections } from './homeCounts';
import '../../content/home/michiHome.css';
import './home.css';
import { LayoutRulesMenuButton } from '../layoutRules/LayoutRulesMenu';

export interface WorkspaceHomeViewProps {
  workspaceId: string;
  backendConnectionId: string;
  onOpenPage: (route: OpenNativePageRoute) => void;
}

export type RelatedConversationState = 'running' | 'waiting' | 'failed' | 'stalled' | 'done';

export interface RelatedConversation {
  /** The conversation's root node: opening it opens the conversation. */
  nodeId: string;
  title: string;
  /** When anything in the conversation last moved. */
  at: number;
  state: RelatedConversationState | null;
  runtimeId: string | null;
}

export const RELATED_CONVERSATION_STATE: Record<RelatedConversationState, string> = {
  running: 'Running', waiting: 'Waiting on you', failed: 'Failed', stalled: 'Stalled', done: 'Done',
};
const STATE_RANK: Record<RelatedConversationState, number> = { running: 5, waiting: 4, failed: 3, stalled: 2, done: 1 };
const SECTION_STATE: Record<HomeSectionKey, RelatedConversationState> = { waiting: 'waiting', stalled: 'stalled', done: 'done' };

/**
 * The workspace's conversations (its unarchived trees, without background
 * maintenance runs or page helpers), newest first. A
 * conversation's state is the strongest of what its nodes are doing now and
 * where the Home sections place them.
 */
export function workspaceConversations(
  project: Project | undefined,
  nodes: Readonly<Record<string, ChatNodeState>>,
  sections: SpacesHomeSectionsDto | null,
): RelatedConversation[] {
  if (!project) return [];
  const states = new Map<string, RelatedConversationState>();
  const mark = (nodeId: string, state: RelatedConversationState) => {
    const treeId = findTreeIdForNode(nodeId, project);
    const current = treeId ? states.get(treeId) : undefined;
    if (treeId && (!current || STATE_RANK[state] > STATE_RANK[current])) states.set(treeId, state);
  };
  for (const nodeId of project.chatIds) {
    const status = nodes[nodeId]?.status;
    if (status === 'streaming') mark(nodeId, 'running');
    else if (status === 'error') mark(nodeId, 'failed');
  }
  for (const key of ['waiting', 'stalled', 'done'] as const) {
    for (const item of sections?.[key].items ?? []) {
      if (item.target.kind === 'conversation' && item.target.workspaceId === project.id) mark(item.target.nodeId, SECTION_STATE[key]);
    }
  }
  return project.trees
    .filter((tree) => !tree.archivedAt && nodes[tree.rootNodeId]?.kind === 'chat' && isVisibleConversationNode(nodes[tree.rootNodeId]))
    .map((tree) => {
      const root = nodes[tree.rootNodeId]!;
      return {
        nodeId: tree.rootNodeId,
        title: tree.name?.trim() || root.title?.trim() || 'Untitled conversation',
        at: tree.lastActiveAt,
        state: states.get(tree.id) ?? null,
        runtimeId: root.runtimeId ?? null,
      };
    })
    .sort((a, b) => b.at - a.at);
}

const RELATED_SHOWN = 8;

/**
 * Where the page was read from: the first read's conversations, how far
 * incremental reading has got (the maintenance cursor, which moves as new
 * conversations finish).
 */
function sourceLine(home: WorkspaceHomeDto | null, run: FirstRunProgressDto | null): string | null {
  if (!home || (run && run.state !== 'done')) return null;
  const incremental = home.incremental ?? null;
  const parts = [
    run && run.readCount > 0 ? `From ${run.readCount} ${run.readCount === 1 ? 'conversation' : 'conversations'}` : null,
    // #0: nothing has been read incrementally yet (older conversations finished before turns were numbered).
    incremental && incremental.readThrough > 0 ? `read through #${incremental.readThrough}` : null,
  ].filter((part): part is string => Boolean(part));
  if ((!run && !incremental) || parts.length === 0) return null;
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

function FirstRunPending({ run, name, onRetry }: { run: FirstRunProgressDto | null; name: string; onRetry(): void }) {
  if (!run || run.state === 'done') return null;
  const message = run.state === 'failed'
    ? `Not written${run.error ? `: ${run.error}` : ''}.`
    : run.state === 'queued'
      ? `Queued: ${name} has ${run.total} past ${run.total === 1 ? 'conversation' : 'conversations'} to read.`
      : `The Meta agent is reading ${name}’s ${run.total} past ${run.total === 1 ? 'conversation' : 'conversations'} and writes them here when it is done.`;
  return (
    <div className="spaces-home-pending" role="status" data-state={run.state}>
      <p className="spaces-home-pending__msg">
        {run.state !== 'failed' && <span className="agent-spinner" aria-hidden="true" />}
        <span>{message}</span>
        {run.state === 'failed' && <Button size="sm" onClick={onRetry}>Retry</Button>}
      </p>
      {run.state !== 'failed' && <div className="michi-doc-skeleton spaces-home-pending__skeleton" aria-hidden="true">
        <span style={{ width: '70%', height: 18 }} /><span style={{ width: '40%' }} />
        <div className="spaces-home-pending__cards"><span /><span /><span /></div>
        <span style={{ width: '90%' }} /><span style={{ width: '82%' }} /><span style={{ width: '86%' }} />
      </div>}
    </div>
  );
}

/** A workspace on a remote connection: nothing is read or written for it, and its home says so. */
function RemoteWorkspaceHome({ workspaceId, backendConnectionId }: WorkspaceHomeViewProps) {
  const { projects } = useChatProjects();
  const name = projects.find((candidate) => candidate.id === workspaceId)?.name ?? 'Workspace';
  const connection = getKnownBackendConnections().find((candidate) => candidate.id === backendConnectionId)?.name;
  return (
    <main className="area-settings michi-doc space-doc spaces-home spaces-ws-home" aria-labelledby="workspace-home-title" data-remote="">
      <div className="area-settings__doc spaces-home__doc">
        <header className="spaces-home__head">
          <p className="area-settings__kicker">{name} · workspace home</p>
          <div className="spaces-home__title-row"><h1 id="workspace-home-title" className="spaces-home__title">{name}</h1></div>
        </header>
        <div className="spaces-home-empty-ws" role="status">
          <p className="spaces-home-lead">{REMOTE_SPACES_NOTE}.</p>
          <p className="spaces-home-muted">
            {name} is on {connection ? `the remote connection ${connection}` : 'a remote connection'}. The Meta agent reads only the workspaces on this
            computer, so it doesn’t write a home for this one. Its conversations are still in Conversations.
          </p>
        </div>
      </div>
    </main>
  );
}

/** A workspace's default home in Spaces: the Meta agent's page, the workspace's Spaces and its conversations. */
export function WorkspaceHomeView(props: WorkspaceHomeViewProps) {
  return spacesSupportsConnection(props.backendConnectionId) ? <LocalWorkspaceHome {...props} /> : <RemoteWorkspaceHome {...props} />;
}

function LocalWorkspaceHome({ workspaceId, backendConnectionId, onOpenPage }: WorkspaceHomeViewProps) {
  const clock = useMinuteClock(true);
  const { projects, agentStatus } = useChatProjects();
  const { selectProject } = useChatActions();
  const nodes = useChatNodesSnapshot();
  const project = projects.find((candidate) => candidate.id === workspaceId);
  const home = useWorkspaceHome(workspaceId, backendConnectionId);
  const { spaces } = useSpaces(backendConnectionId);
  const sections = useSpacesHomeSections(backendConnectionId);
  const live = useSpacesFirstRun(backendConnectionId);
  const run = newerFirstRun(home.data?.firstRun, live.data?.workspaces.find((item) => item.workspaceId === workspaceId)?.firstRun);
  const firstRunActive = Boolean(run && run.state !== 'done');
  // Until its first read is written the page is only its placeholder, like the rest of the home.
  const reading = firstRunActive && run?.state !== 'failed' && (home.data?.page.blocks.length ?? 0) === 0;
  // While the Meta agent is writing the page, the empty-page editor would only race it.
  const doc = useHomeDocument({ backendConnectionId, initial: home.data?.page ?? null, allowEmptyEditor: !firstRunActive });
  const nav = useHomeNavigation(backendConnectionId, doc.page?.id ?? null);
  const [creating, setCreating] = React.useState(false);
  const [allConversations, setAllConversations] = React.useState(false);

  const name = project?.name ?? home.data?.page.title ?? 'Workspace';
  const page = doc.page;
  const blocks = page?.blocks ?? [];
  const own = (spaces ?? []).filter((space) => space.workspaceId === workspaceId);
  const related = React.useMemo(() => workspaceConversations(project, nodes, sections.data), [nodes, project, sections.data]);
  const shownRelated = allConversations ? related : related.slice(0, RELATED_SHOWN);
  const runtimeName = (runtimeId: string) => agentStatus?.availableRuntimes?.find((runtime) => runtime.id === runtimeId)?.label || runtimeId;
  const noConversations = project ? project.chatIds.length === 0 : false;
  // The first read found nothing in its range, though the workspace has older conversations.
  const nothingRecent = run?.state === 'done' && run.total === 0 && !noConversations;
  const firstRunDays = home.data?.firstRunDays ?? META_AGENT_DEFAULT_FIRST_RUN_DAYS;
  const source = sourceLine(home.data, run);
  const scope: SpaceConversationScope = { backendConnectionId, pageId: page?.id ?? null, workspaceId, workspaceName: name, pageTitle: name };
  const writtenAt = run?.state === 'done' ? run.updatedAt : null;
  React.useEffect(() => {
    if (writtenAt !== null && page) markWorkspaceHomeOpened(backendConnectionId, workspaceId, writtenAt);
  }, [backendConnectionId, workspaceId, writtenAt, page]);

  const newConversation = () => {
    selectProject(workspaceId);
    window.dispatchEvent(new CustomEvent('michi:goto-home'));
  };

  if (home.status === 'loading' && !page) {
    return <main className="area-settings michi-doc spaces-home" aria-label={name}><div className="area-settings__doc spaces-home__doc">
      <p className="area-settings__kicker">{name} · workspace home</p>
      <div className="michi-doc-skeleton" aria-hidden="true"><span style={{ width: '46%', height: 24 }} /><span style={{ width: '62%' }} /><span style={{ width: '100%', height: 64 }} /></div>
      <p className="spaces-home-muted" role="status">Loading…</p>
    </div></main>;
  }

  return (
    <main className="area-settings michi-doc space-doc spaces-home spaces-ws-home" aria-labelledby="workspace-home-title">
      <div className="area-settings__doc spaces-home__doc">
        <NewChatSheetSlot scope={scope} />
        <header className="spaces-home__head">
          <p className="area-settings__kicker">{name} · workspace home</p>
          <div className="spaces-home__title-row">
            <h1 id="workspace-home-title" className="spaces-home__title">{name}</h1>
            <span className="spaces-home-spacer" /><LayoutRulesMenuButton pageId={page?.id ?? null} backendConnectionId={backendConnectionId} readOnly={home.stale} />
          </div>
          {page && blocks.length > 0 && <p className="spaces-home__updated">
            <time dateTime={new Date(page.updatedAt).toISOString()} title={new Date(page.updatedAt).toLocaleString()}>Updated {homeAge(page.updatedAt, clock)}</time>
          </p>}
        </header>
        {home.status === 'error' && !page && <p className="spaces-home-muted" role="alert">
          {home.error || 'This workspace home could not be loaded.'} <button type="button" className="spaces-home-link" onClick={home.refresh}>Retry</button>
        </p>}
        {home.stale && <p className="spaces-home-muted" role="status">Showing the last saved page. Reconnect before editing.</p>}

        {page && blocks.length === 0 && noConversations && !firstRunActive ? (
          <div className="spaces-home-empty-ws">
            <p className="spaces-home-lead">No conversations yet. Start one and this page writes itself.</p>
            <div><Button size="sm" onClick={newConversation}><MessageSquare size={12} strokeWidth={1.7} aria-hidden="true" />New conversation</Button></div>
          </div>
        ) : <>
          {doc.renderBlocks(blocks.slice(0, 1), 'lead')}
          {source && <div className="spaces-home-source"><Sparkles size={12} strokeWidth={1.7} aria-hidden="true" /><span>{source}</span></div>}
          <PageProgressCards scope={scope} />
          {home.data && blocks.length === 0 && firstRunActive && <FirstRunPending run={run} name={name} onRetry={() => { void retrySpacesFirstRunNow(backendConnectionId, workspaceId); }} />}
          {home.data && blocks.length === 0 && !firstRunActive && (nothingRecent
            ? <p className="spaces-home-muted" role="status">
              The first read found no conversations in its {firstRunDays}-day range. Your older conversations are still listed below.
              When background updates are enabled, the Meta agent can write this page after a new conversation finishes.
            </p>
            : <HomePlaceholder text="The Meta agent writes this page from the workspace’s conversations." />)}
          {doc.renderBlocks(blocks.slice(1), 'rest')}

          {!reading && <>
          <section className="spaces-home-section" aria-labelledby="workspace-home-spaces">
            <div className="spaces-home-section__head"><h2 id="workspace-home-spaces" className="spaces-home-h2">Pages in this workspace</h2></div>
            <div className="spaces-home-space-cards">
              {own.map((space) => (
                <button key={space.id} type="button" className="spaces-home-space-card" onClick={() => onOpenPage({ pageId: space.id, workspaceId, backendConnectionId })}>
                  <span className="spaces-home-space-card__title"><FileText size={14} strokeWidth={1.6} aria-hidden="true" />{space.title || 'Untitled page'}</span>
                  <span className="spaces-home-space-card__sub">
                    {space.pageCount} {space.pageCount === 1 ? 'page' : 'pages'}
                    {space.pendingProposals > 0 && <> · <span className="spaces-home-accent">{space.pendingProposals} waiting for you</span></>}
                  </span>
                </button>
              ))}
              <button type="button" className="spaces-home-space-card spaces-home-space-card--add" onClick={() => setCreating(true)}>
                <Plus size={14} strokeWidth={1.7} aria-hidden="true" />New page
              </button>
            </div>
          </section>

          <section className="spaces-home-section" aria-labelledby="workspace-home-threads">
            <div className="spaces-home-section__head">
              <h2 id="workspace-home-threads" className="spaces-home-h2">Related conversations</h2>
              <span className="spaces-home-section__note">Opens in the conversation view</span>
              {related.length > RELATED_SHOWN && <button type="button" className="michi-home-view-all spaces-home-section__all" onClick={() => setAllConversations((all) => !all)}>
                {allConversations ? 'Show fewer' : <>View all <span className="michi-home-view-all__count">{related.length}</span></>}
              </button>}
            </div>
            {related.length === 0 && <p className="spaces-home-muted">No conversations in this workspace yet.</p>}
            {related.length > 0 && <div className="spaces-home-threads">
              {shownRelated.map((thread) => (
                <button key={thread.nodeId} type="button" className="spaces-home-threads__row" onClick={() => { void nav.openThread({ nodeId: thread.nodeId, workspaceId }); }}>
                  <MessageSquare size={13} strokeWidth={1.7} aria-hidden="true" />
                  <span className="spaces-home-threads__title">{thread.title}</span>
                  {thread.runtimeId && <span className="michi-tag spaces-home-threads__runtime">{runtimeName(thread.runtimeId)}</span>}
                  <span className="spaces-home-spacer" />
                  <span className="spaces-home-muted" data-state={thread.state ?? undefined}>
                    {[thread.state && RELATED_CONVERSATION_STATE[thread.state], homeAge(thread.at, clock)].filter(Boolean).join(' · ')}
                  </span>
                  <ChevronRight size={13} strokeWidth={1.7} aria-hidden="true" />
                </button>
              ))}
            </div>}

          </section>
          </>}
        </>}
      </div>
      {creating && <CreateSpaceDialog activeWorkspaceId={workspaceId} onClose={() => setCreating(false)} onCreated={(route) => { setCreating(false); onOpenPage(route); }} />}
    </main>
  );
}

export default WorkspaceHomeView;
