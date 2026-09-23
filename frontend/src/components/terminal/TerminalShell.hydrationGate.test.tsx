/**
 * Hydration gate: while the store is loading from the backend (hydrated===false),
 * TerminalShell paints navigation but not empty-workspace content or commands.
 * This is the view-layer half of the hydration barrier —
 * it prevents the cold-start flash where the backend isn't listening yet and
 * `projects` is momentarily empty.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import TerminalShell from './TerminalShell';
import { PrefsProvider } from '../../state/prefs';

const renderShell = () => render(
  <PrefsProvider>
    <TerminalShell />
  </PrefsProvider>,
);

const gate = vi.hoisted(() => ({ hydrated: false }));
const mutations = vi.hoisted(() => ({ createProject: vi.fn(), createBlankChild: vi.fn(), restoreLastDeletion: vi.fn(), closePane: vi.fn() }));

vi.mock('./pages/Settings', () => ({ default: ({ workspaceReady }: { workspaceReady: boolean }) => <div>Appearance settings: {String(workspaceReady)}</div> }));

const projectsValue = () => ({
  activeProject: null,
  activeProjectId: null,
  projects: [],
  order: [],
  edges: [],
  theme: 'light',
  availableModes: [],
  agentStatus: null,
  warmFailedError: null,
  focusedNodeId: null,
  selection: new Set<string>(),
  hydrated: gate.hydrated,
  treeSelection: new Set<string>(),
  searchHighlightTerm: null,
});

vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../state/chatStore');
  return {
    ...actual,
    useChatProjects: () => projectsValue(),
    useChatPanes: () => ({ openPanes: [], focusedPane: null, focusNonce: 0, paneItems: {}, viewMode: 'single' as const }),
    useChatActions: () => ({
      createProject: mutations.createProject,
      enterChatsWorkspace: () => Promise.resolve('chats-default'),
      focusPane: () => {}, closePane: mutations.closePane, openPane: () => {},
      createBlankChild: mutations.createBlankChild, restoreLastDeletion: mutations.restoreLastDeletion,
      clearSelection: () => {}, clearTreeSelection: () => {}, selectAllTrees: () => {},
    }),
    useStructuralSelector: (s: (n: Record<string, unknown>) => unknown) => s({}),
    useChatNodesSnapshot: () => ({}),
    useNodesSelector: () => ({}),
    useChatNode: () => null,
    chatLabel: () => '',
  };
});

describe('TerminalShell hydration gate', () => {
  beforeEach(() => {
    gate.hydrated = false;
    vi.clearAllMocks();
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false }));
  });

  it('paints shell navigation while keeping unknown workspaces behind the barrier', () => {
    gate.hydrated = false;
    renderShell();
    expect(screen.getByText(/loading workspaces/i)).toBeTruthy();
    expect(document.querySelector('.terminal-topbar')).not.toBeNull();
    expect(document.querySelector('.terminal-sidebar')).not.toBeNull();
    expect(screen.getByText('Settings')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Search' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText(/new workspace/i)).toBeNull();
    expect(screen.queryByText('No project chats')).toBeNull();
    fireEvent.click(screen.getByText('Workspaces'));
    expect(screen.getByRole('status', { name: 'Loading workspaces' })).toBeTruthy();
  });

  it('allows settings to open before workspace hydration', async () => {
    renderShell();
    fireEvent.click(screen.getByText('Settings'));
    expect(await screen.findByText('Appearance settings: false')).toBeTruthy();
  });

  it('blocks workspace commands and dialogs while hydration is pending', () => {
    renderShell();
    for (const key of ['z', 'w', 't']) {
      fireEvent.keyDown(window, { key, metaKey: true, altKey: key === 't' });
    }
    fireEvent(window, new CustomEvent('michi:open-new-workspace'));
    fireEvent(window, new CustomEvent('michi:toggle-artifacts'));
    expect(screen.queryByRole('dialog')).toBeNull();
    for (const mutation of Object.values(mutations)) expect(mutation).not.toHaveBeenCalled();
  });
  // The hydrated-path render (full shell chrome, no splash) is exercised by
  // TerminalShell.shortcut.test.tsx, which mounts the shell with hydrated:true.
});
