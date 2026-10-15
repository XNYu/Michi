import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import TerminalShell from './TerminalShell';
import { PrefsProvider } from '../../state/prefs';
import { AgentDomainProvider } from '../../state/agentDomain';

function renderShell() {
  return render(<PrefsProvider><AgentDomainProvider><TerminalShell /></AgentDomainProvider></PrefsProvider>);
}


const closePaneSpy = vi.hoisted(() => vi.fn());
const createBlankChildSpy = vi.hoisted(() => vi.fn());
const clearSelectionSpy = vi.hoisted(() => vi.fn());
const clearTreeSelectionSpy = vi.hoisted(() => vi.fn());
const platformState = vi.hoisted(() => ({ isMac: false }));
const storeState = vi.hoisted(() => ({
  activeTreeId: null as string | null,
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
      activeProject: { id: 'p1', name: 'P', artifacts: [], trees: [], chatIds: [], edges: [], activeTreeId: storeState.activeTreeId, createdAt: 0 },
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
      createThread: () => {}, createBlankChild: createBlankChildSpy,
      focusPane: () => {}, selectProject: () => {}, createProject: () => {},
      // Home's composer (rendered by TerminalShell) reads these at render time.
      availableModes: [], agentStatus: null, refreshAgentStatus: () => {},
      sendMessage: () => {}, createContext: () => {},
    }),
    useChatProjects: () => ({
      activeProject: { id: 'p1', name: 'P', artifacts: [], trees: [], chatIds: [], edges: [], activeTreeId: storeState.activeTreeId, createdAt: 0 },
      activeProjectId: 'p1',
      projects: [],
      order: [],
      edges: [],
      theme: 'light',
      availableModes: [],
      agentStatus: null,
      warmFailedError: null,
      focusedNodeId: null,
      selection: storeState.selection,
      hydrated: true,
      treeSelection: storeState.treeSelection,
      searchHighlightTerm: null,
    }),
    useChatPanes: () => ({
      openPanes: storeState.openPanes,
      focusedPane: storeState.focusedPane,
      focusNonce: 0,
      paneItems: {},
      viewMode: 'single' as const,
    }),
    useChatActions: () => ({
      createProject: () => Promise.resolve('p1'),
      enterChatsWorkspace: () => Promise.resolve('chats-default'),
      focusPane: () => {},
      closePane: closePaneSpy,
      openPane: () => {},
      createBlankChild: createBlankChildSpy,
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

vi.mock('../../lib/platform', async () => {
  const actual = await vi.importActual<typeof import('../../lib/platform')>('../../lib/platform');
  return {
    ...actual,
    get IS_MAC() { return platformState.isMac; },
  };
});

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
  createBlankChildSpy.mockReset();
  createBlankChildSpy.mockResolvedValue('child');
  clearSelectionSpy.mockReset();
  clearTreeSelectionSpy.mockReset();
  platformState.isMac = false;
  storeState.activeTreeId = null;
  storeState.focusedPane = null;
  storeState.openPanes = [];
  storeState.selection = new Set();
  storeState.treeSelection = new Set();
});
afterEach(() => { vi.useRealTimers(); });

describe('TerminalShell shortcuts', () => {
  it('Cmd+; dispatches michi:toggle-artifacts (legacy Contexts shortcut)', () => {
    renderShell();
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

  it('uses the Home background when Dashboard has no presented panes', () => {
    storeState.activeTreeId = 'tree-1';
    const { container } = renderShell();

    fireEvent.keyDown(window, {
      key: '1', metaKey: true, bubbles: true,
    });

    expect(container.querySelector('h1')?.textContent).toContain(
      'Another road diverged in a yellow wood.',
    );
    const topbar = container.querySelector<HTMLElement>('.terminal-topbar');
    expect(topbar).toBeTruthy();
    expect(topbar?.style.background).toBe('var(--term-bg)');
  });

  it('Shift+Cmd+A dispatches michi:toggle-artifacts', () => {
    renderShell();
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
    renderShell();
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

  // Regression: TPane refocuses its composer when a reply finishes, so ⌘⌥T
  // was swallowed by the isEditable gate at the moment users want to branch.
  it('Cmd+Option+T branches from the focused pane even when a textarea has focus', () => {
    storeState.focusedPane = 'L';
    renderShell();
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    let notPrevented: boolean;
    try {
      // macOS reports ⌥T as '†'.
      notPrevented = fireEvent.keyDown(window, { key: '†', metaKey: true, altKey: true });
      // Focus must leave the parent's composer: the new pane mounts already
      // focused, so nothing else moves typing focus out of it.
      expect(document.activeElement).not.toBe(ta);
    } finally {
      ta.remove();
    }
    expect(notPrevented).toBe(false);
    expect(createBlankChildSpy).toHaveBeenCalledTimes(1);
    expect(createBlankChildSpy.mock.calls[0][0]).toBe('L');
  });

  it('Cmd+T opens Home even when a textarea has focus', () => {
    const { container } = renderShell();
    const topbar = () => container.querySelector<HTMLElement>('.terminal-topbar');
    fireEvent.keyDown(window, { key: '1', metaKey: true });
    expect(topbar()?.dataset.page).toBe('dashboard');
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    try {
      fireEvent.keyDown(window, { key: 't', metaKey: true });
    } finally {
      ta.remove();
    }
    expect(topbar()?.dataset.page).toBe('home');
  });

  // On macOS, Ctrl+T in a text field is the system "transpose characters"
  // binding. Moving ⌘T/⌘⌥T above the isEditable gate must not steal it.
  it('leaves macOS Ctrl+T and Ctrl+Option+T to a focused text field', () => {
    platformState.isMac = true;
    // focusedPane alone arms ⌘⌥T; leaving openPanes empty keeps a real TPane
    // (which needs CSS.highlights) out of the dashboard.
    storeState.focusedPane = 'L';
    const { container } = renderShell();
    fireEvent.keyDown(window, { key: '1', metaKey: true });
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    let ctrlT: boolean;
    let ctrlOptT: boolean;
    try {
      ctrlT = fireEvent.keyDown(window, { key: 't', ctrlKey: true });
      ctrlOptT = fireEvent.keyDown(window, { key: '†', ctrlKey: true, altKey: true });
      expect(document.activeElement).toBe(ta);
    } finally {
      ta.remove();
    }
    expect(ctrlT).toBe(true);
    expect(ctrlOptT).toBe(true);
    expect(container.querySelector<HTMLElement>('.terminal-topbar')?.dataset.page).toBe('dashboard');
    expect(createBlankChildSpy).not.toHaveBeenCalled();
  });

  it('keeps Ctrl+T as new thread on macOS when nothing editable has focus', () => {
    platformState.isMac = true;
    const { container } = renderShell();
    fireEvent.keyDown(window, { key: '1', metaKey: true });
    fireEvent.keyDown(window, { key: 't', ctrlKey: true });
    expect(container.querySelector<HTMLElement>('.terminal-topbar')?.dataset.page).toBe('home');
  });

  it('Escape clears node and tree selection together', () => {
    storeState.selection = new Set(['node-1']);
    storeState.treeSelection = new Set(['tree-1']);
    renderShell();
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
