import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDefinitionDtoV1 } from 'michi-shared';
import { AgentDefinitionStatus } from 'michi-shared';
import { indexBackendProjects, setActiveBackendConnectionId } from '../../config/backendConnections';
import { locatedAgentResource } from '../../state/agentIdentity';
import { _resetForTest } from '../../state/manageRoute';
import TerminalShell from './TerminalShell';

const shell = vi.hoisted(() => ({ activeProjectId: 'remote-ws', narrow: false }));
const loadDefinitions = vi.hoisted(() => vi.fn(async () => {}));
const dispatch = vi.hoisted(() => vi.fn());
const contextPolicy = { version: 1 as const, includeWorkspaceInstructions: true, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 100_000 };
const permissionPolicy = { version: 1 as const, preset: 'research' as const, categories: {}, maxDelegationDepth: 0, maxConcurrentRuns: 1, maxWallTimeMs: 60_000, maxAttempts: 1 };
const definition = (backend: string, scope: 'global' | 'workspace'): ReturnType<typeof locatedAgentResource<AgentDefinitionDtoV1>> => locatedAgentResource(backend, { version: 1, id: 'same-id', ownerUserId: 'owner', scope, workspaceId: scope === 'workspace' ? `${backend === 'remote-a' ? 'remote' : 'other'}-ws` : null, name: `${backend} Agent`, description: 'Does work.', instructions: 'Work.', runtimeProfile: { version: 1, runtimeId: 'pi' }, fallbackChain: [], toolRefs: [], skillRefs: [], mcpServerRefs: [], permissionPolicy, contextPolicy, defaultRunTtlMs: null, status: AgentDefinitionStatus.Draft, revision: 1, createdAt: 1, updatedAt: 1 });
const domainState = vi.hoisted(() => ({ definitions: {} as Record<string, ReturnType<typeof definition>>, runs: {} }));

vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<typeof import('../../state/chatStore')>('../../state/chatStore');
  const project = () => ({ id: shell.activeProjectId, name: shell.activeProjectId, backendConnectionId: shell.activeProjectId === 'remote-ws' ? 'remote-a' : 'remote-b', artifacts: [], trees: [], chatIds: [], edges: [], activeTreeId: null, createdAt: 0 });
  return { ...actual, useChatProjects: () => ({ activeProject: project(), activeProjectId: shell.activeProjectId, projects: [project()], order: [], edges: [], theme: 'light', availableModes: [], agentStatus: { customAgentsEnabled: true }, warmFailedError: null, focusedNodeId: null, selection: new Set(), hydrated: true, treeSelection: new Set(), searchHighlightTerm: null, canNavBack: false, canNavForward: false }), useChatPanes: () => ({ openPanes: [], focusedPane: null, focusNonce: 0, paneItems: {}, viewMode: 'single' as const }), useChatActions: () => ({ createProject: async () => 'p', enterChatsWorkspace: async () => 'p', focusPane: () => {}, closePane: () => {}, openPane: () => {}, createBlankChild: async () => {}, restoreLastDeletion: () => null, clearSelection: () => {}, clearTreeSelection: () => {}, selectAllTrees: () => {}, navBack: () => {}, navForward: () => {} }), useStructuralSelector: (selector: (nodes: Record<string, never>) => unknown) => selector({}), useNodesSelector: () => 0, chatLabel: () => '' };
});
vi.mock('../../state/agentDomain', () => ({ useAgentDomain: () => ({ state: domainState, loadDefinitions, dispatch }) }));
vi.mock('../../state/prefs', async () => { const actual = await vi.importActual<typeof import('../../state/prefs')>('../../state/prefs'); return { ...actual, usePrefs: () => ({ prefs: actual.DEFAULT_PREFS, setPref: vi.fn() }) }; });
vi.mock('../../services/api', () => ({ createAgentDefinition: vi.fn(), deleteAgentDefinition: vi.fn(), disableAgentDefinition: vi.fn(), duplicateAgentDefinition: vi.fn(), enableAgentDefinition: vi.fn(), getAgentDefinition: vi.fn(), updateAgentDefinition: vi.fn() }));
vi.mock('./useTerminalColors', () => ({ useTerminalColors: () => ({}) }));
vi.mock('./Topbar', () => ({ default: ({ onToggleSidebar }: { onToggleSidebar: () => void }) => <button onClick={onToggleSidebar}>toggle sidebar</button> }));
vi.mock('./Sidebar', () => ({ default: ({ onNav, narrowMode, narrowOverlayOpen }: { onNav: (page: string) => void; narrowMode: boolean; narrowOverlayOpen: boolean }) => narrowMode && !narrowOverlayOpen ? null : <nav aria-label="test sidebar"><button onClick={() => onNav('agents')}>Agents</button></nav> }));
vi.mock('./WarmFailedBanner', () => ({ default: () => null }));
vi.mock('./AskUserAlertBar', () => ({ default: () => null }));
vi.mock('./pages/Home', () => ({ default: () => <div>Home page</div> }));
vi.mock('./pages/Dashboard', () => ({ default: () => <div>Dashboard page</div> }));
vi.mock('../NewWorkspaceDialog', () => ({ default: () => null }));
vi.mock('./agents/AgentLibraryPage', () => ({ default: (props: { definitions: Array<{ backendConnectionId: string; value: { name: string } }>; onCreate: (scope: 'workspace' | 'global') => void; onEdit: (resource: { backendConnectionId: string; value: { id: string; scope: 'workspace'; workspaceId: string; name: string } }) => void }) => <div><h1>Library route</h1><div data-testid="library-resources">{props.definitions.map((resource) => `${resource.backendConnectionId}:${resource.value.name}`).join(',')}</div><button onClick={() => props.onCreate('workspace')}>create workspace Agent</button><button onClick={() => props.onCreate('global')}>create global Agent</button>{props.definitions[0] && <button onClick={() => props.onEdit(props.definitions[0] as never)}>edit Agent</button>}</div> }));
vi.mock('./agents/AgentEditorPage', () => ({ default: (props: { initialScope: string; workspaceId: string | null; definition?: { backendConnectionId: string } | null; onCancel: () => void }) => <div><h1>Editor route</h1><span data-testid="editor-scope">{props.initialScope}:{props.workspaceId ?? 'none'}:{props.definition?.backendConnectionId ?? 'new'}</span><button onClick={props.onCancel}>back to Library</button></div> }));

beforeEach(() => {
  _resetForTest(); loadDefinitions.mockClear(); dispatch.mockClear(); shell.activeProjectId = 'remote-ws';
  indexBackendProjects([{ id: 'remote-ws', backendConnectionId: 'remote-a', chatIds: [] }, { id: 'other-ws', backendConnectionId: 'remote-b', chatIds: [] }]);
  setActiveBackendConnectionId('remote-a');
  const a = definition('remote-a', 'workspace'); const b = definition('remote-b', 'workspace');
  domainState.definitions = { a, b }; domainState.runs = {};
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: shell.narrow ? 600 : 1200 });
});

describe('TerminalShell Agent management routes', () => {
  it('opens the Library on the active Workspace Backend without unioning equal IDs', async () => {
    render(<TerminalShell />);
    fireEvent.click(screen.getByRole('button', { name: 'Agents' }));
    expect(await screen.findByRole('heading', { name: 'Library route' })).not.toBeNull();
    expect(loadDefinitions).toHaveBeenCalledWith('remote-ws');
    expect(screen.getByTestId('library-resources').textContent).toContain('remote-a:remote-a Agent');
    expect(screen.getByTestId('library-resources').textContent).not.toContain('remote-b');
  });

  it('preserves Workspace/Global create scope, editor deep-link, and back navigation', async () => {
    render(<TerminalShell />); fireEvent.click(screen.getByRole('button', { name: 'Agents' }));
    fireEvent.click(await screen.findByRole('button', { name: 'create workspace Agent' }));
    expect((await screen.findByTestId('editor-scope')).textContent).toContain('workspace:remote-ws:new');
    fireEvent.click(screen.getByRole('button', { name: 'back to Library' }));
    fireEvent.click(await screen.findByRole('button', { name: 'create global Agent' }));
    expect((await screen.findByTestId('editor-scope')).textContent).toContain('global:none:new');
  });

  it('switches the Library control plane with the active Workspace without ID collision', async () => {
    const view = render(<TerminalShell />); fireEvent.click(screen.getByRole('button', { name: 'Agents' }));
    expect((await screen.findByTestId('library-resources')).textContent).toContain('remote-a:remote-a Agent');
    shell.activeProjectId = 'other-ws';
    view.rerender(<TerminalShell />);
    await waitFor(() => expect(screen.getByTestId('library-resources').textContent).toContain('remote-b:remote-b Agent'));
    expect(screen.getByTestId('library-resources').textContent).not.toContain('remote-a');
    expect(loadDefinitions).toHaveBeenCalledWith('other-ws');
  });

  it('closes the narrow sidebar overlay after Agent navigation', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
    render(<TerminalShell />);
    fireEvent.click(screen.getByRole('button', { name: 'toggle sidebar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Agents' }));
    expect(await screen.findByRole('heading', { name: 'Library route' })).not.toBeNull();
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'test sidebar' })).toBeNull());
  });
});
