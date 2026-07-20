import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import TerminalShell from './TerminalShell';


const closePaneSpy = vi.hoisted(() => vi.fn());
const clearSelectionSpy = vi.hoisted(() => vi.fn());
const clearTreeSelectionSpy = vi.hoisted(() => vi.fn());
const storeState = vi.hoisted(() => ({
  focusedPane: null as string | null,
  openPanes: [] as string[],
  selection: new Set<string>(),
  treeSelection: new Set<string>(),
}));

vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../state/chatStore');
  return {
    ...actual,
    useChatStore: () => ({
      activeProject: { id: 'p1', name: 'P', artifacts: [], trees: [], chatIds: [], edges: [], activeTreeId: null, createdAt: 0 },
      activeProjectId: 'p1',
      projects: [],
      openPanes: storeState.openPanes, focusedPane: storeState.focusedPane, focusedNodeId: null,
      selection: storeState.selection,
      nodes: {},
      hydrated: true,
      treeSelection: storeState.treeSelection,
      clearSelection: clearSelectionSpy,
      clearTreeSelection: clearTreeSelectionSpy, selectAllTrees: () => {},
      restoreLastDeletion: () => null, openPane: () => {}, closePane: closePaneSpy,
      createThread: () => {}, createBlankChild: () => {},
      focusPane: () => {}, selectProject: () => {}, createProject: () => {},
      // Home's composer (rendered by TerminalShell) reads these at render time.
      availableModes: [], agentStatus: null, refreshAgentStatus: () => {},
      sendMessage: () => {}, createContext: () => {},
    }),
    useChatProjects: () => ({
      activeProject: { id: 'p1', name: 'P', artifacts: [], trees: [], chatIds: [], edges: [], activeTreeId: null, createdAt: 0 },
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
      selection: storeState.selection,
      hydrated: true,
      treeSelection: storeState.treeSelection,
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
      clearSelection: clearSelectionSpy,
      clearTreeSelection: clearTreeSelectionSpy,
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
      prefs: actual.DEFAULT_PREFS,
      setPref: () => {},
    }),
  };
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  closePaneSpy.mockReset();
  clearSelectionSpy.mockReset();
  clearTreeSelectionSpy.mockReset();
  storeState.focusedPane = null;
  storeState.openPanes = [];
  storeState.selection = new Set();
  storeState.treeSelection = new Set();
});
afterEach(() => { vi.useRealTimers(); });

describe('TerminalShell shortcuts', () => {
  it('Cmd+; dispatches michi:toggle-artifacts (legacy Contexts shortcut)', () => {
    render(<TerminalShell />);
    const spy = vi.fn();
    window.addEventListener('michi:toggle-artifacts', spy);
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: ';', metaKey: true, bubbles: true,
      }));
    } finally {
      window.removeEventListener('michi:toggle-artifacts', spy);
    }
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('Shift+Cmd+A dispatches michi:toggle-artifacts', () => {
    render(<TerminalShell />);
    const spy = vi.fn();
    window.addEventListener('michi:toggle-artifacts', spy);
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'a', metaKey: true, shiftKey: true, bubbles: true,
      }));
    } finally {
      window.removeEventListener('michi:toggle-artifacts', spy);
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

  it('Escape clears node and tree selection together', () => {
    storeState.selection = new Set(['node-1']);
    storeState.treeSelection = new Set(['tree-1']);
    render(<TerminalShell />);
    const focusTarget = document.createElement('button');
    document.body.appendChild(focusTarget);
    focusTarget.focus();

    try {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true,
      }));
    } finally {
      focusTarget.remove();
    }

    expect(clearSelectionSpy).toHaveBeenCalledOnce();
    expect(clearTreeSelectionSpy).toHaveBeenCalledOnce();
  });
});
