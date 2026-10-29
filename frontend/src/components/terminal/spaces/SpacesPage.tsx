import React, { useMemo, useState } from 'react';
import { useChatProjects } from '../../../state/chatStore';
import { notifyPageChanged } from '../../../state/pages/pageEvents';
import { backendConnectionIdForWorkspace, getKnownBackendConnections } from '../../../config/backendConnections';
import { createPage } from '../../../services/api/pages';
import { getPageMaintenance, setPageMaintenanceSpaceExcluded } from '../../../services/api/pageMaintenance';
import { MaintenanceEnrollmentCheckbox } from './MaintenanceStatus';
import type { SpacesHomeTarget } from '../../../state/shellArea';
import { useSpacesFirstRun } from '../../../state/metaAgent/spacesFirstRun';
import { clearHeldWorkspaceHome, useHeldWorkspaceHome } from '../../../state/pages/workspaceHomeNav';
import type { SpaceRoute } from './SpaceView';
import './spaces.css';
import '../rail/rail.css';

export type NativePageRoute = SpaceRoute;
export type OpenNativePageRoute = Omit<Extract<NativePageRoute, { type: 'space' }>, 'type'>;
export const OPEN_NATIVE_PAGE_EVENT = 'michi:open-native-page';

/** Open a native page in the terminal shell while retaining its owning backend and workspace. */
export function openNativePageRoute(route: OpenNativePageRoute): void {
  window.dispatchEvent(new CustomEvent<OpenNativePageRoute>(OPEN_NATIVE_PAGE_EVENT, { detail: route }));
}

const templates = [
  { value: 'blank', label: 'Blank' },
  { value: 'release', label: 'Release' },
  { value: 'research', label: 'Research' },
  { value: 'travel', label: 'Travel' },
] as const;

/** Create a Space in a chosen backend workspace, then open it. */
export function CreateSpaceDialog({ activeWorkspaceId, onClose, onCreated }: {
  activeWorkspaceId?: string;
  onClose: () => void;
  onCreated: (route: OpenNativePageRoute) => void;
}) {
  const { projects } = useChatProjects();
  const activeProject = projects.find((project) => project.id === activeWorkspaceId);
  const connections = getKnownBackendConnections();
  const [connectionId, setConnectionId] = useState(activeProject ? backendConnectionIdForWorkspace(activeProject.id) : 'local');
  const workspaces = useMemo(() => projects
    .filter((project) => backendConnectionIdForWorkspace(project.id) === connectionId && !project.archivedAt && !project.deletedAt && !project.system)
    .map((project) => ({ id: project.id, name: project.name })), [projects, connectionId]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [title, setTitle] = useState('');
  const [template, setTemplate] = useState<(typeof templates)[number]['value']>('blank');
  const [maintenanceEnabled, setMaintenanceEnabled] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createdPage, setCreatedPage] = useState<{ id: string; workspaceId: string; backendConnectionId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  React.useEffect(() => {
    setWorkspaceId(activeProject && backendConnectionIdForWorkspace(activeProject.id) === connectionId ? activeProject.id : workspaces[0]?.id ?? '');
  }, [activeProject, connectionId, workspaces]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!workspaceId || !title.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const identity = { backendConnectionId: createdPage?.backendConnectionId ?? connectionId, workspaceId: createdPage?.workspaceId ?? workspaceId };
      const page = createdPage ?? await createPage({ workspaceId, title: title.trim(), template }, identity);
      if (!createdPage) setCreatedPage({ id: page.id, workspaceId: identity.workspaceId, backendConnectionId: identity.backendConnectionId });
      const maintenance = await getPageMaintenance(identity);
      if (maintenance.excludedSpaceIds.includes(page.id) === maintenanceEnabled) {
        await setPageMaintenanceSpaceExcluded(page.id, !maintenanceEnabled, maintenance.config?.revision ?? 0, identity);
      }
      notifyPageChanged({ ...identity, pageId: page.id });
      onCreated({ pageId: page.id, workspaceId: identity.workspaceId, backendConnectionId: identity.backendConnectionId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create this page.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="spaces-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !creating) onClose(); }}>
      <form className="spaces-modal" aria-labelledby="spaces-create-heading" onSubmit={(event) => void submit(event)}>
        <div className="spaces-modal-heading"><div><p className="spaces-eyebrow">NEW DOCUMENT</p><h2 id="spaces-create-heading">Create a page</h2></div><button type="button" aria-label="Close" onClick={onClose}>×</button></div>
        {connections.length > 1 && <label>Backend<select disabled={Boolean(createdPage)} value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>
          {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
        </select></label>}
        <label>Workspace<select required disabled={Boolean(createdPage)} value={createdPage?.workspaceId ?? workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}><option value="" disabled>Select a workspace</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
        <label>Name<input autoFocus maxLength={200} required disabled={Boolean(createdPage)} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Product research" /></label>
        <label>Starting point<select disabled={Boolean(createdPage)} value={template} onChange={(event) => setTemplate(event.target.value as typeof template)}>{templates.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <MaintenanceEnrollmentCheckbox checked={maintenanceEnabled} onChange={setMaintenanceEnabled} disabled={creating} />
        {error && <p role="alert" className="spaces-form-error">{error}</p>}
        {!workspaces.length && <p className="spaces-form-error">There are no workspaces on this backend yet.</p>}
        <footer><button type="button" className="spaces-secondary" disabled={creating} onClick={onClose}>Cancel</button><button type="submit" className="spaces-primary" disabled={creating || !workspaceId || !title.trim()}>{creating ? 'Creating…' : 'Create page'}</button></footer>
      </form>
    </div>
  );
}

// Lazy, so the page documents stay out of the shell's own chunk (TerminalShell imports this module eagerly).
const SpacesHomeView = React.lazy(() => import('./home/SpacesHome'));
const WorkspaceHomeView = React.lazy(() => import('./home/WorkspaceHome'));
const AllTasksView = React.lazy(() => import('./allTasks/AllTasksPage'));

/** The Spaces landing page: its own blocks, and the sections Michi counts from conversation state. */
export function SpacesHome({ now }: { now?: Date }) {
  return <React.Suspense fallback={<main className="area-settings michi-doc space-doc" aria-busy="true"><h1>Home</h1><p role="status">Loading Home…</p></main>}><SpacesHomeView now={now} /></React.Suspense>;
}

/** A workspace's home in Spaces: the Meta agent's page, the workspace's Spaces and its conversations. */
export function WorkspaceHome({ workspaceId, backendConnectionId, onOpenPage }: {
  workspaceId: string;
  backendConnectionId: string;
  onOpenPage: (route: OpenNativePageRoute) => void;
}) {
  return <React.Suspense fallback={null}><WorkspaceHomeView workspaceId={workspaceId} backendConnectionId={backendConnectionId} onOpenPage={onOpenPage} /></React.Suspense>;
}

/** All tasks: every workspace's tasks in one database. */
export function AllTasks() {
  return <React.Suspense fallback={null}><AllTasksView /></React.Suspense>;
}

/**
 * The Spaces area's `spaces` page: the global Home, one workspace's home, or All tasks.
 * Opening it is a visit to Spaces, which starts (or wakes) the Meta agent's
 * first run. A workspace home asked for while no Spaces sidebar is mounted
 * to answer shows here until the shell's own target changes.
 */
export function SpacesPage({ target, onOpenPage }: {
  target: SpacesHomeTarget;
  onOpenPage: (route: OpenNativePageRoute) => void;
}) {
  useSpacesFirstRun('local', { start: true });
  const held = useHeldWorkspaceHome();
  React.useEffect(() => () => clearHeldWorkspaceHome(), []);
  React.useEffect(() => { clearHeldWorkspaceHome(); }, [target]);
  const shown: SpacesHomeTarget = held ? { kind: 'workspace', ...held } : target;
  if (shown.kind === 'all-tasks') return <AllTasks />;
  return shown.kind === 'workspace'
    ? <WorkspaceHome workspaceId={shown.workspaceId} backendConnectionId={shown.backendConnectionId} onOpenPage={onOpenPage} />
    : <SpacesHome />;
}

export default SpacesPage;
