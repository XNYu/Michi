import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import TerminalShell from './TerminalShell';

const closePaneSpy = vi.hoisted(() => vi.fn());
const storeState = vi.hoisted(() => ({ focusedPane: null as string | null, openPanes: [] as string[] }));

vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../state/chatStore');
  return {
    ...actual,
    useChatStore: () => ({
      activeProject: { id: 'p1', name: 'P', contexts: [], trees: [], chatIds: [], edges: [], activeTreeId: null, createdAt: 0 },
      activeProjectId: 'p1',
      projects: [],
      openPanes: storeState.openPanes, focusedPane: storeState.focusedPane, focusedNodeId: null,
      selection: new Set(),
      nodes: {},
      hydrated: true,
      treeSelection: new Set(),
      clearTreeSelection: () => {}, selectAllTrees: () => {},
      restoreLastDeletion: () => null, openPane: () => {}, closePane: closePaneSpy,
      createThread: () => {}, createBlankChild: () => {},
      focusPane: () => {}, selectProject: () => {}, createProject: () => {},
      // Home's composer (rendered by TerminalShell) reads these at render time.
      availableModes: [], agentStatus: null, refreshAgentStatus: () => {},
      sendMessage: () => {}, createContext: () => {},
    }),
    useChatProjects: () => ({
      activeProject: { id: 'p1', name: 'P', contexts: [], trees: [], chatIds: [], edges: [], activeTreeId: null, createdAt: 0 },
      activeProjectId: 'p1',
      projects: [],
      order: [],
      edges: [],
      theme: 'light',
      availableModes: [],
      agentStatus: null,
      warmFailedError: null,
      openPanes: storeState.openPanes,
      focusedPane: storeState.focusedPane,
      focusedNodeId: null,
      viewMode: 'single',
      selection: new Set(),
      hydrated: true,
      treeSelection: new Set(),
      searchHighlightTerm: null,
    }),
    useChatActions: () => ({
      createProject: () => Promise.resolve('p1'),
      enterChatsWorkspace: () => Promise.resolve('chats-default'),
      focusPane: () => {},
      closePane: closePaneSpy,
      openPane: () => {},
      createBlankChild: () => {},
      restoreLastDeletion: () => null,
      clearTreeSelection: () => {},
      selectAllTrees: () => {},
    }),
    useChatNodesSnapshot: () => ({}),
    useNodesSelector: () => ({}),
    useStructuralSelector: (selector: (nodes: Record<string, unknown>) => unknown) => selector({}),
    useChatNode: () => null,
    chatLabel: () => '',
  };
});

vi.mock('./useTerminalColors', () => ({
  useTerminalColors: () => ({}),
}));

vi.mock('../../state/prefs', async () => {
  const actual = await vi.importActual<any>('../../state/prefs');
  return {
    ...actual,
    usePrefs: () => ({
      prefs: { sidebarCollapsed: false, workspaceOrder: [] },
      setPref: () => {},
    }),
  };
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  closePaneSpy.mockReset();
  storeState.focusedPane = null;
  storeState.openPanes = [];
});
afterEach(() => { vi.useRealTimers(); });

describe('TerminalShell shortcuts', () => {
  it('Cmd+; dispatches michi:toggle-contexts', () => {
    render(<TerminalShell />);
    const spy = vi.fn();
    window.addEventListener('michi:toggle-contexts', spy);
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: ';', metaKey: true, bubbles: true,
      }));
    } finally {
      window.removeEventListener('michi:toggle-contexts', spy);
    }
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // Regression: TPane auto-focuses its composer textarea when becoming
  // focused, so before this fix ⌘W was being swallowed by the isEditable
  // gate as soon as the user click-switched into a pane.
  it('Cmd+W closes the focused pane even when a textarea has focus', () => {
    storeState.focusedPane = 'L';
    storeState.openPanes = ['L', 'R'];
    render(<TerminalShell />);
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    expect(document.activeElement).toBe(ta);
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'w', metaKey: true, bubbles: true,
      }));
    } finally {
      ta.remove();
    }
    expect(closePaneSpy).toHaveBeenCalledTimes(1);
    expect(closePaneSpy).toHaveBeenCalledWith('L');
  });
});
