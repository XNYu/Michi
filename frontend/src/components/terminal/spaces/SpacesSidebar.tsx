import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, EyeOff, FileText, Home, Kanban, Plus, Settings2, Sparkles, Table2 } from 'lucide-react';
import type { FirstRunProgressDto, PageSummaryDto, SpaceSummaryDto, WorkspaceHomeSummaryDto } from 'michi-shared';
import type { Project } from '../../../state/chatTypes';
import { useChatProjects } from '../../../state/chatStore';
import { usePrefs } from '../../../state/prefs';
import { backendConnectionIdForWorkspace } from '../../../config/backendConnections';
import { useSpaces } from '../../../state/pages/useSpaces';
import { useSpaceTree } from '../../../state/pages/useSpaceTree';
import { subscribePageChanges } from '../../../state/pages/pageEvents';
import { listWorkspaceDatabases, type PageDatabaseSummary } from '../../../services/api/pages';
import { setWorkspaceHomeHidden } from '../../../services/api/spacesHome';
import { useSpacesHomeWorkspaces } from '../../../state/pages/useSpacesHome';
import { sortLiveProjects } from '../../../state/sidebarSelectors';
import type { SpacesHomeTarget } from '../../../state/shellArea';
import { firstRunActive, refreshSpacesFirstRun, useSpacesFirstRun } from '../../../state/metaAgent/spacesFirstRun';
import { clearHeldWorkspaceHome } from '../../../state/pages/workspaceHomeNav';
import { spacesSupportsConnection } from '../../../state/metaAgent/remoteSpaces';
import type { OpenNativePageRoute } from './SpacesPage';
import { WorkspaceFirstRunBadge } from './home/MetaAgentSidebarStatus';
import ContextMenu from '../../ContextMenu';
import { RowKebab } from '../primitives';
import '../rail/rail.css';
import './spacesSidebar.css';
import { AssistantHistory } from './AssistantHistory';
import { pageIsWithin, usePageActions } from './usePageActions';

export type SpacesSidebarCurrent = SpacesHomeTarget | ({ kind: 'page' } & OpenNativePageRoute);
type WorkspaceTarget = { workspaceId: string; backendConnectionId: string };
type Tone = 'calm' | 'pending';

const EXPANDED_KEY = 'michi.spaces-sidebar.expanded';

function readExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []);
  } catch { return new Set(); }
}

function useExpandedWorkspaces(): [ReadonlySet<string>, (key: string) => void] {
  const [expanded, setExpanded] = useState<Set<string>>(readExpanded);
  const toggle = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next])); } catch { /* optional UI memory */ }
      return next;
    });
  }, []);
  return [expanded, toggle];
}

export function SpacesSidebar({ current, onOpenHome, onOpenWorkspace, onOpenPage, onOpenAssistant, onOpenAllTasks, onNewSpace, onOpenSettings, settingsOpen, assistantOpen }: {
  current: SpacesSidebarCurrent;
  /** Reminder counts are temporarily hidden in Pages navigation. */
  waitingCount?: number;
  onOpenHome: () => void;
  onOpenWorkspace: (target: WorkspaceTarget) => void;
  onOpenPage: (route: OpenNativePageRoute) => void;
  onOpenAssistant: () => void;
  /** Opens All tasks; without it there is no All tasks row. */
  onOpenAllTasks?: () => void;
  onNewSpace: () => void;
  onOpenSettings?: () => void;
  settingsOpen?: boolean;
  assistantOpen?: boolean;
}) {
  const { projects } = useChatProjects();
  const { prefs } = usePrefs();
  const [expanded, toggle] = useExpandedWorkspaces();
  const workspaces = useMemo(
    () => sortLiveProjects(projects.filter((project) => !project.system && !project.archivedAt && !project.deletedAt), prefs.workspaceOrder ?? []),
    [projects, prefs.workspaceOrder],
  );
  const groups = useMemo(() => {
    const byConnection = new Map<string, Project[]>();
    for (const workspace of workspaces) {
      const connectionId = backendConnectionIdForWorkspace(workspace.id);
      byConnection.set(connectionId, [...(byConnection.get(connectionId) ?? []), workspace]);
    }
    return [...byConnection.entries()];
  }, [workspaces]);
  // Nothing is read from a remote connection: its databases are not listed either.
  const localGroups = useMemo(() => groups.filter(([connectionId]) => spacesSupportsConnection(connectionId)), [groups]);
  const databases = useWorkspaceDatabases(localGroups);
  // All tasks counts the tasks in every local workspace's task database.
  const taskCount = databases.reduce((sum, database) => sum + (database.role === 'tasks' ? database.rowCount : 0), 0);
  const allTasksCurrent = current.kind === 'all-tasks' && !settingsOpen;
  const homeCurrent = current.kind === 'home' && !settingsOpen;
  const localFirstRun = useSpacesFirstRun('local');
  const homeReading = firstRunActive(localFirstRun.data);
  const openHome = useCallback(() => { clearHeldWorkspaceHome(); onOpenHome(); }, [onOpenHome]);

  const openAllTasks = useCallback(() => { clearHeldWorkspaceHome(); onOpenAllTasks?.(); }, [onOpenAllTasks]);

  return (
    <div className="area-side spaces-side" aria-label="Pages navigation">
      <div className="area-side__grow term-scrollbar">
        <div className="area-side__row is-strong is-nav" role="button" tabIndex={0} aria-current={homeCurrent ? 'page' : undefined} onClick={openHome} onKeyDown={keys(openHome)}>
          <Home size={15} strokeWidth={1.5} aria-hidden="true" />
          <span className="area-side__label">Home</span>
          {homeReading && <span className="agent-spinner" role="img" aria-label="Meta agent is reading" />}
        </div>
        <div className="area-side__row is-strong is-nav" role="button" tabIndex={0} onClick={onOpenAssistant} onKeyDown={keys(onOpenAssistant)}>
          <Sparkles size={15} strokeWidth={1.5} aria-hidden="true" />
          <span className="area-side__label">Assistant</span>
        </div>
        <AssistantHistory onOpenAssistant={onOpenAssistant} visible={assistantOpen} />
        {onOpenAllTasks && (
          <div className="area-side__row is-strong is-nav" role="button" tabIndex={0} aria-current={allTasksCurrent ? 'page' : undefined} onClick={openAllTasks} onKeyDown={keys(openAllTasks)}>
            <Kanban size={15} strokeWidth={1.5} aria-hidden="true" />
            <span className="area-side__label">All tasks</span>
            {taskCount > 0 && <span className="area-side__count" aria-label={`${taskCount} tasks`}>{taskCount}</span>}
          </div>
        )}
        <div className="area-side__section">Pages
          <button type="button" className="area-side__section-btn" aria-label="New page" onClick={onNewSpace}><Plus size={14} strokeWidth={1.5} aria-hidden="true" /></button>
        </div>
        {localGroups.map(([connectionId, list]) => (
          <ConnectionWorkspaces key={connectionId} connectionId={connectionId} workspaces={list} current={current} expanded={expanded}
            onToggle={toggle} onOpenWorkspace={onOpenWorkspace} onOpenPage={onOpenPage} />
        ))}
        {localGroups.length === 0 && <div className="area-side__note">No pages yet.</div>}
        <div className="area-side__section">Databases</div>
        <DatabaseRows databases={databases} />
      </div>
      <div className="area-side__foot spaces-side__footer">
        <button type="button" className="area-side__row is-strong is-nav" aria-label="Pages settings" aria-current={settingsOpen ? 'page' : undefined} onClick={onOpenSettings}>
          <Settings2 size={15} strokeWidth={1.5} aria-hidden="true" /><span className="area-side__label">Settings</span>
        </button>
      </div>
    </div>
  );
}

function keys(action: () => void) {
  return (event: React.KeyboardEvent) => {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    action();
  };
}

function ConnectionWorkspaces({ connectionId, workspaces, current, expanded, onToggle, onOpenWorkspace, onOpenPage }: {
  connectionId: string;
  workspaces: Project[];
  current: SpacesSidebarCurrent;
  expanded: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onOpenWorkspace: (target: WorkspaceTarget) => void;
  onOpenPage: (route: OpenNativePageRoute) => void;
}) {
  const { spaces } = useSpaces(connectionId);
  const firstRun = useSpacesFirstRun(connectionId);
  const workspaceHomes = useSpacesHomeWorkspaces(connectionId);
  const homes = useMemo(() => {
    const result = new Map<string, WorkspaceHomeSummaryDto>((workspaceHomes.data ?? firstRun.data?.workspaces ?? []).map((home) => [home.workspaceId, home]));
    // A first read can finish between the ordinary summary polls. Its newer
    // result exposes the new content immediately without erasing cached homes.
    for (const home of firstRun.data?.workspaces ?? []) {
      const current = result.get(home.workspaceId);
      if (!current || (home.firstRun?.updatedAt ?? 0) > (current.firstRun?.updatedAt ?? 0)) result.set(home.workspaceId, home);
    }
    return result;
  }, [workspaceHomes.data, firstRun.data]);
  const [showHidden, setShowHidden] = useState(false);
  const setHidden = useCallback((workspaceId: string, hidden: boolean) => {
    void setWorkspaceHomeHidden(workspaceId, hidden, connectionId)
      .then(() => { workspaceHomes.refresh(); return refreshSpacesFirstRun(connectionId); }, () => {});
  }, [connectionId, workspaceHomes.refresh]);
  const row = (workspace: Project, hidden: boolean) => {
    const own = (spaces ?? []).filter((space) => space.workspaceId === workspace.id);
    const key = `${connectionId}:${workspace.id}`;
    const home = homes.get(workspace.id);
    const run = home?.firstRun ?? null;
    const written = !run || run.state === 'done';
    const tone: Tone = written ? 'calm' : 'pending';
    return (
      <WorkspaceRow key={key} workspace={workspace} connectionId={connectionId} spaces={own} tone={tone} open={expanded.has(key)} run={run}
        hidden={hidden} current={current} onToggle={() => onToggle(key)} onOpenWorkspace={onOpenWorkspace} onOpenPage={onOpenPage}
        onSetHidden={(next) => setHidden(workspace.id, next)} />
    );
  };
  const available = workspaces.filter((workspace) => {
    const home = homes.get(workspace.id);
    // Explicitly created pages remain reachable even before their home is written.
    return (home?.hasContent ?? !!home?.homePageId) || (spaces ?? []).some((space) => space.workspaceId === workspace.id);
  });
  const shown = available.filter((workspace) => (homes.get(workspace.id)?.hiddenAt ?? null) === null);
  const hidden = available.filter((workspace) => (homes.get(workspace.id)?.hiddenAt ?? null) !== null);
  const toggleHidden = () => setShowHidden((value) => !value);
  return <>
    {shown.map((workspace) => row(workspace, false))}
    {available.length === 0 && <div className="area-side__note">No pages yet.</div>}
    {hidden.length > 0 && <>
      <div className="area-side__row spaces-side__hidden" role="button" tabIndex={0} aria-expanded={showHidden} onClick={toggleHidden} onKeyDown={keys(toggleHidden)}>
        <EyeOff size={14} strokeWidth={1.5} aria-hidden="true" />
        <span className="area-side__label">Hidden from Pages</span>
        <span className="area-side__count" aria-label={`${hidden.length} hidden`}>{hidden.length}</span>
      </div>
      {showHidden && hidden.map((workspace) => row(workspace, true))}
    </>}
  </>;
}

function WorkspaceRow({ workspace, connectionId, spaces, tone, open, run, hidden, current, onToggle, onOpenWorkspace, onOpenPage, onSetHidden }: {
  workspace: Project;
  connectionId: string;
  spaces: SpaceSummaryDto[];
  tone: Tone;
  open: boolean;
  /** The workspace home's first read, while the Meta agent writes it. */
  run: FirstRunProgressDto | null;
  /** Hidden from Spaces: listed only under the hidden row, with a way to show it again. */
  hidden: boolean;
  current: SpacesSidebarCurrent;
  onToggle: () => void;
  onOpenWorkspace: (target: WorkspaceTarget) => void;
  onOpenPage: (route: OpenNativePageRoute) => void;
  onSetHidden: (hidden: boolean) => void;
}) {
  const isCurrent = current.kind === 'workspace' && current.workspaceId === workspace.id && current.backendConnectionId === connectionId;
  const hasChildren = spaces.length > 0;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // The default home is never deleted: hiding it is the only way to take a workspace out of Spaces.
  const sections = [{ items: [hidden
    ? { id: 'show', label: 'Show in Pages', run: () => onSetHidden(false) }
    : { id: 'hide', label: 'Hide from Pages', run: () => onSetHidden(true) }] }];
  return <>
    <div className="area-side__row is-strong is-split t-row-hover" aria-current={isCurrent ? 'page' : undefined} data-workspace={workspace.id} data-first-run={run?.state}
      data-hidden={hidden || undefined} data-menu-open={menu ? '' : undefined}
      onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }); }}>
      {hasChildren
        ? <button type="button" className="area-side__twist" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${workspace.name}`} onClick={onToggle}><ChevronRight size={11} strokeWidth={1.6} aria-hidden="true" /></button>
        : <span className="area-side__twist" aria-hidden="true" />}
      <button type="button" className="area-side__main" onClick={() => onOpenWorkspace({ workspaceId: workspace.id, backendConnectionId: connectionId })}>
        <span className="area-side__dot" data-tone={tone} aria-hidden="true" />
        <span className="area-side__label">{workspace.name}</span>
        <WorkspaceFirstRunBadge run={run} />
      </button>
      <RowKebab open={!!menu} onOpen={setMenu} ariaLabel={`Actions for ${workspace.name}`} />
    </div>
    {menu && <ContextMenu x={menu.x} y={menu.y} sections={sections} onClose={() => setMenu(null)} />}
    {open && hasChildren && <WorkspacePages workspaceId={workspace.id} connectionId={connectionId} spaces={spaces} current={current} onOpenPage={onOpenPage} onOpenWorkspace={onOpenWorkspace} />}
  </>;
}

function WorkspacePages({ workspaceId, connectionId, spaces, current, onOpenPage, onOpenWorkspace }: {
  workspaceId: string;
  connectionId: string;
  spaces: SpaceSummaryDto[];
  current: SpacesSidebarCurrent;
  onOpenPage: (route: OpenNativePageRoute) => void;
  onOpenWorkspace: (target: WorkspaceTarget) => void;
}) {
  const { pages, status } = useSpaceTree({ backendConnectionId: connectionId, workspaceId });
  const [menu, setMenu] = useState<{ page: PageSummaryDto; x: number; y: number } | null>(null);
  const readOnly = status !== 'ready';
  const actions = usePageActions({
    identity: { workspaceId, backendConnectionId: connectionId }, pages: pages ?? [], readOnly,
    onOpen: pageId => onOpenPage({ pageId, workspaceId, backendConnectionId: connectionId }),
    onChanged: () => {}, // notifyPageChanged refreshes the sidebar's tree and Space summaries.
    onTrashed: target => {
      if (current.kind === 'page' && current.workspaceId === workspaceId && current.backendConnectionId === connectionId
        && pageIsWithin(pages ?? [], current.pageId, target.id)) onOpenWorkspace({ workspaceId, backendConnectionId: connectionId });
    },
  });
  const children = useMemo(() => {
    const map = new Map<string, PageSummaryDto[]>();
    for (const page of pages ?? []) {
      if (!page.parentId) continue;
      map.set(page.parentId, [...(map.get(page.parentId) ?? []), page]);
    }
    for (const list of map.values()) list.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
    return map;
  }, [pages]);
  const roots = [...spaces].sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
  const row = (page: PageSummaryDto, depth: number, seen: ReadonlySet<string>): React.ReactNode => {
    const isCurrent = current.kind === 'page' && current.pageId === page.id && current.backendConnectionId === connectionId;
    const open = () => onOpenPage({ pageId: page.id, workspaceId, backendConnectionId: connectionId });
    const nextSeen = new Set(seen).add(page.id);
    return (
      <React.Fragment key={page.id}>
        <div className="area-side__row is-page is-split t-row-hover" style={{ '--page-depth': depth } as React.CSSProperties}
          data-page-id={page.id} data-menu-open={menu?.page.id === page.id ? '' : undefined}
          aria-current={isCurrent ? 'page' : undefined}
          onContextMenu={event => { event.preventDefault(); setMenu({ page, x: event.clientX, y: event.clientY }); }}>
          <button type="button" className="area-side__main" aria-current={isCurrent ? 'page' : undefined} onClick={open}>
            <FileText size={14} strokeWidth={1.5} aria-hidden="true" />
            <span className="area-side__label">{page.title || 'Untitled page'}</span>
          </button>
          <RowKebab open={menu?.page.id === page.id} onOpen={point => setMenu({ page, ...point })} ariaLabel={`Actions for ${page.title || 'Untitled page'}`} />
        </div>
        {(children.get(page.id) ?? []).filter((child) => !seen.has(child.id)).map((child) => row(child, depth + 1, nextSeen))}
      </React.Fragment>
    );
  };
  return <>
    {roots.map((space) => row(space, 0, new Set()))}
    {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} sections={[
      { items: [
        { id: 'child', label: 'Add a page inside', disabled: readOnly, run: () => actions.createChild(menu.page.id) },
        { id: 'rename', label: 'Rename', disabled: readOnly, run: () => actions.rename(menu.page) },
        ...(menu.page.parentId ? [{ id: 'move', label: 'Move…', disabled: readOnly, run: () => actions.move(menu.page) }] : []),
      ] },
      { items: [{ id: 'trash', label: menu.page.parentId ? 'Move to trash' : 'Move page to trash', danger: true, disabled: readOnly, run: () => actions.trash(menu.page) }] },
    ]} />}
    {actions.dialog}
  </>;
}

/** The databases of the workspaces listed, read again when a page changes: the Databases list and All tasks' count. */
function useWorkspaceDatabases(groups: ReadonlyArray<readonly [string, Project[]]>): PageDatabaseSummary[] {
  const [databases, setDatabases] = useState<PageDatabaseSummary[]>([]);
  const [version, setVersion] = useState(0);
  const signature = groups.map(([connectionId, list]) => `${connectionId}:${list.map((item) => item.id).join(',')}`).join('|');
  useEffect(() => {
    const unsubscribe = groups.map(([backendConnectionId]) => subscribePageChanges({ backendConnectionId }, () => setVersion((value) => value + 1)));
    return () => { for (const stop of unsubscribe) stop(); };
    // groups is re-derived each render; its content is captured by signature.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  useEffect(() => {
    const controller = new AbortController();
    const requests = groups.flatMap(([backendConnectionId, list]) => list.map((workspace) =>
      listWorkspaceDatabases(workspace.id, { backendConnectionId, workspaceId: workspace.id, signal: controller.signal })));
    void Promise.allSettled(requests).then((results) => {
      if (controller.signal.aborted) return;
      setDatabases(results.flatMap((result) => result.status === 'fulfilled' ? result.value : []));
    });
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, version]);
  return databases;
}

function DatabaseRows({ databases }: { databases: readonly PageDatabaseSummary[] }) {
  // A workspace's task database is not listed: All tasks stands for them.
  const shown = databases.filter((database) => database.role !== 'tasks');
  if (shown.length === 0) return <div className="area-side__note">No databases yet.</div>;
  return <>{[...shown].sort((a, b) => a.title.localeCompare(b.title)).map((database) => (
    <div key={`${database.workspaceId}:${database.id}`} className="area-side__row is-strong" aria-disabled="true">
      <Table2 size={15} strokeWidth={1.5} aria-hidden="true" />
      <span className="area-side__label">{database.title || 'Untitled database'}</span>
      <span className="area-side__count">{database.rowCount}</span>
    </div>
  ))}</>;
}

export default SpacesSidebar;
