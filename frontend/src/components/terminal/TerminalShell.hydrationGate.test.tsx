/**
 * Hydration gate: while the store is loading from the backend (hydrated===false),
 * TerminalShell must show a splash, NOT the shell chrome with an empty
 * "no workspace" state. This is the view-layer half of the hydration barrier —
 * it prevents the cold-start flash where the backend isn't listening yet and
 * `projects` is momentarily empty.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import TerminalShell from './TerminalShell';
import { PrefsProvider } from '../../state/prefs';

const renderShell = () => render(
  <PrefsProvider>
    <TerminalShell />
  </PrefsProvider>,
);

const gate = vi.hoisted(() => ({ hydrated: false }));

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
  openPanes: [],
  focusedPane: null,
  focusedNodeId: null,
  viewMode: 'single',
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
    useChatActions: () => ({
      createProject: () => Promise.resolve('p1'),
      enterChatsWorkspace: () => Promise.resolve('chats-default'),
      focusPane: () => {}, closePane: () => {}, openPane: () => {},
      createBlankChild: () => {}, restoreLastDeletion: () => null,
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
  beforeEach(() => { gate.hydrated = false; });

  it('shows a loading splash while not hydrated (no empty-workspace flash)', () => {
    gate.hydrated = false;
    renderShell();
    expect(screen.getByText(/loading workspaces/i)).toBeTruthy();
    // The shell chrome (e.g. the New Workspace dialog / sidebar) must NOT paint
    // yet — that is exactly the empty-state flash the gate exists to prevent.
    expect(screen.queryByText(/new workspace/i)).toBeNull();
  });
  // The hydrated-path render (full shell chrome, no splash) is exercised by
  // TerminalShell.shortcut.test.tsx, which mounts the shell with hydrated:true.
});
