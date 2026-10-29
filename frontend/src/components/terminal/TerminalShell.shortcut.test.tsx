import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import TerminalShell from './TerminalShell';
import { PrefsProvider } from '../../state/prefs';
import { AgentDomainProvider } from '../../state/agentDomain';
import { clearRemoteRecoveryIssue, getRemoteRecoveryIssues, reportRemoteRecoveryFailure, REMOTE_RECOVERY_GRACE_MS } from '../../state/remoteRecovery';
import { closeRemoteAuthentication, completeRemoteAuthentication, requestRemoteAuthentication } from '../../state/remoteAuthentication';
import { remoteSignInLabel } from 'michi-shared';
import { getAssistantSnapshot, resetAssistantStoreForTests } from '../../state/assistant/assistantStore';
import { openBackgroundWork } from './backgroundWork/backgroundWorkEvents';

function renderShell() {
  return render(<PrefsProvider><AgentDomainProvider><TerminalShell /></AgentDomainProvider></PrefsProvider>);
}

vi.mock('../RemoteAuthenticationTerminal', () => ({ default: () => <div>Authentication terminal</div> }));
// Panes render as stand-ins: these tests are about the shell's keys.
vi.mock('./TPane', () => ({ default: ({ nodeId }: { nodeId: string }) => <div data-testid={`tpane-${nodeId}`} /> }));

const closePaneSpy = vi.hoisted(() => vi.fn());
const createBlankChildSpy = vi.hoisted(() => vi.fn());
const clearSelectionSpy = vi.hoisted(() => vi.fn());
const clearTreeSelectionSpy = vi.hoisted(() => vi.fn());
const platformState = vi.hoisted(() => ({ isMac: false }));
const storeState = vi.hoisted(() => ({
  projectId: 'p1',
  chatIds: ['n1', 'n2'] as string[],
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
      activeProject: { id: storeState.projectId, name: 'P', artifacts: [], trees: [], chatIds: storeState.chatIds, edges: [], activeTreeId: storeState.activeTreeId, createdAt: 0 },
      activeProjectId: storeState.projectId,
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
      activeProject: { id: storeState.projectId, name: 'P', artifacts: [], trees: [], chatIds: storeState.chatIds, edges: [], activeTreeId: storeState.activeTreeId, createdAt: 0 },
      activeProjectId: storeState.projectId,
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
    useChatNodeReader: () => () => undefined,
    chatLabel: () => '',
  };
});

vi.mock('./backgroundWork/BackgroundWorkDrawer', () => ({
  default: ({ open, request, requestSeq, onClose }: { open: boolean; request: { nodeId: string; focus?: unknown }; requestSeq: number; onClose: () => void }) => open
    ? <div role="dialog" aria-label="Background work">{`${request.nodeId} ${JSON.stringify(request.focus ?? null)} #${requestSeq}`}<button onClick={onClose}>close drawer</button></div>
    : null,
}));

// The useNodesSelector mock above answers {} to every selector; the button has its own tests.
vi.mock('./backgroundWork/BackgroundWorkButton', () => ({ default: () => null }));

vi.mock('./useTerminalColors', () => ({
  useTerminalColors: () => ({}),
}));

// The ⌘J assistant never answers here: the panel stays on its skeleton.
vi.mock('../../services/api/assistant', async () => {
  const actual = await vi.importActual<typeof import('../../services/api/assistant')>('../../services/api/assistant');
  return { ...actual, fetchAssistant: () => new Promise(() => {}) };
});

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
  storeState.projectId = 'p1';
  storeState.chatIds = ['n1', 'n2'];
  storeState.activeTreeId = null;
  storeState.focusedPane = null;
  storeState.openPanes = [];
  storeState.selection = new Set();
  storeState.treeSelection = new Set();
});
afterEach(() => {
  act(() => { for (const issue of getRemoteRecoveryIssues()) clearRemoteRecoveryIssue(issue.connectionId); });
  vi.useRealTimers();
});

describe('TerminalShell background work drawer', () => {
  it('opens only on request, with the requested scope and focus, and hides native surfaces', async () => {
    renderShell();
    expect(screen.queryByRole('dialog', { name: 'Background work' })).toBeNull();
    act(() => openBackgroundWork({ nodeId: 'n1', focus: { kind: 'subagent', sessionId: 's1' } }));
    const dialog = await screen.findByRole('dialog', { name: 'Background work' });
    expect(dialog.textContent).toContain('n1 {"kind":"subagent","sessionId":"s1"} #1');
    expect(document.documentElement.dataset.nativeSurfacesVisible).toBe('false');
    act(() => openBackgroundWork({ nodeId: 'n2' }));
    expect(screen.getByRole('dialog', { name: 'Background work' }).textContent).toContain('n2 null #2');
    fireEvent.click(screen.getByText('close drawer'));
    expect(screen.queryByRole('dialog', { name: 'Background work' })).toBeNull();
  });

  it('closes when the active workspace no longer owns the conversation', async () => {
    const { rerender } = renderShell();
    act(() => openBackgroundWork({ nodeId: 'n1' }));
    expect(await screen.findByRole('dialog', { name: 'Background work' })).toBeTruthy();
    // Another workspace becomes active (keyboard switch while the modal is open).
    storeState.projectId = 'p2';
    storeState.chatIds = ['n9'];
    rerender(<PrefsProvider><AgentDomainProvider><TerminalShell /></AgentDomainProvider></PrefsProvider>);
    expect(screen.queryByRole('dialog', { name: 'Background work' })).toBeNull();
    // Coming back does not reopen the old request.
    storeState.projectId = 'p1';
    storeState.chatIds = ['n1', 'n2'];
    rerender(<PrefsProvider><AgentDomainProvider><TerminalShell /></AgentDomainProvider></PrefsProvider>);
    expect(screen.queryByRole('dialog', { name: 'Background work' })).toBeNull();
    // A request for a conversation this workspace does not own never opens.
    act(() => openBackgroundWork({ nodeId: 'n9' }));
    expect(screen.queryByRole('dialog', { name: 'Background work' })).toBeNull();
  });

  it('ignores malformed requests', () => {
    renderShell();
    act(() => { window.dispatchEvent(new CustomEvent('michi:open-background-work', { detail: { focus: { kind: 'subagent', sessionId: 's1' } } })); });
    expect(screen.queryByRole('dialog', { name: 'Background work' })).toBeNull();
  });
});

describe('TerminalShell shortcuts', () => {
  it('hides native browser surfaces and blocks workspace shortcuts while remote sign-in is open', async () => {
    storeState.focusedPane = 'L';
    storeState.selection = new Set(['node-1']);
    const view = renderShell();
    try {
      fireEvent.keyDown(window, { key: '1', metaKey: true });
      expect(document.documentElement.dataset.nativeSurfacesVisible).toBe('true');
      act(() => requestRemoteAuthentication({ key: 'shell-auth', target: { scope: 'local', host: 'box' } }, true));
      await screen.findByRole('dialog', { name: remoteSignInLabel() });
      expect(document.documentElement.dataset.nativeSurfacesVisible).toBe('false');
      fireEvent.keyDown(window, { key: 'w', metaKey: true });
      expect(closePaneSpy).not.toHaveBeenCalled();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('dialog', { name: remoteSignInLabel() })).toBeNull();
      expect(document.documentElement.dataset.nativeSurfacesVisible).toBe('true');
      expect(clearSelectionSpy).not.toHaveBeenCalled();
      fireEvent.keyDown(window, { key: 'w', metaKey: true });
      expect(closePaneSpy).toHaveBeenCalledWith('L');
    } finally { view.unmount(); closeRemoteAuthentication(); completeRemoteAuthentication('shell-auth'); }
  });

  it('keeps pane shortcuts and Escape from changing the workspace behind remote connection details', () => {
    storeState.focusedPane = 'L';
    storeState.selection = new Set(['node-1']);
    storeState.treeSelection = new Set(['tree-1']);
    reportRemoteRecoveryFailure({ id: 'remote-c', name: 'build+', sshHost: 'build+', transport: 'ssh', hasToken: true, createdAt: 1, updatedAt: 1 }, new Error('offline'));
    vi.setSystemTime(Date.now() + REMOTE_RECOVERY_GRACE_MS);
    renderShell();
    expect(screen.queryByRole('region', { name: 'Remote connection issues' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Remote connection details:/ }));
    expect(screen.getByRole('dialog', { name: 'Remote connections' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'w', metaKey: true });
    expect(closePaneSpy).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Remote connections' })).toBeNull();
    expect(clearSelectionSpy).not.toHaveBeenCalled();
    expect(clearTreeSelectionSpy).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(clearSelectionSpy).toHaveBeenCalledOnce();
    expect(clearTreeSelectionSpy).toHaveBeenCalledOnce();
  });

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

  it('uses Home as the chrome background fallback when Dashboard has no presented panes', () => {
    storeState.activeTreeId = 'tree-1';
    const { container } = renderShell();

    fireEvent.keyDown(window, {
      key: '1', metaKey: true, bubbles: true,
    });

    expect(container.querySelector('.home-page')).toBeTruthy();
    const topbar = container.querySelector<HTMLElement>('.terminal-topbar');
    expect(topbar).toBeTruthy();
    expect(topbar?.style.background).toBe('var(--term-chrome-bg, var(--term-bg))');
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

  const navTo = (page: string) => act(() => { window.dispatchEvent(new CustomEvent('michi:nav-page', { detail: { page } })); });
  const topbarPage = (container: HTMLElement) => container.querySelector<HTMLElement>('.terminal-topbar')?.dataset.page;

  it('redirects legacy All threads navigation to Home and removes its sidebar entry', () => {
    const { container } = renderShell();
    navTo('threads');
    expect(topbarPage(container)).toBe('home');
    expect(screen.queryByRole('main', { name: 'All threads' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'All threads' })).toBeNull();
  });

  it('stays on branch overview for an Esc a menu in the assistant panel closes', async () => {
    const { container } = renderShell();
    navTo('branches');
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    const panel = await screen.findByRole('complementary', { name: 'Assistant' });
    // The composer's Permissions menu: its chip keeps the focus, and the menu
    // closes on Esc from its own window listener.
    const chip = within(panel).getByRole('button', { name: 'Close' });
    chip.focus();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);
    const closeMenu = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); menu.remove(); } };
    try {
      // Whether the menu's listener runs before the shell's or after it.
      window.addEventListener('keydown', closeMenu, true);
      fireEvent.keyDown(chip, { key: 'Escape' });
      expect(menu.isConnected).toBe(false);
      expect(topbarPage(container)).toBe('branches');
      window.removeEventListener('keydown', closeMenu, true);
      document.body.appendChild(menu);
      window.addEventListener('keydown', closeMenu);
      fireEvent.keyDown(chip, { key: 'Escape' });
      expect(menu.isConnected).toBe(false);
      expect(topbarPage(container)).toBe('branches');
      expect(screen.getByRole('complementary', { name: 'Assistant' })).toBeTruthy();
      // With nothing open the panel's Esc closes the panel, still not the page.
      fireEvent.keyDown(chip, { key: 'Escape' });
      expect(screen.queryByRole('complementary', { name: 'Assistant' })).toBeNull();
      expect(topbarPage(container)).toBe('branches');
    } finally {
      window.removeEventListener('keydown', closeMenu, true);
      window.removeEventListener('keydown', closeMenu);
      menu.remove();
      act(() => resetAssistantStoreForTests());
    }
  });

  it('leaves branch overview only for an Esc nothing else took', async () => {
    const { container } = renderShell();
    for (const page of ['branches'] as const) {
      navTo(page);
      expect(topbarPage(container)).toBe(page);
      (document.activeElement as HTMLElement | null)?.blur();
      // A layer that handled the Esc itself (a modal drawer closing).
      const handled = (event: KeyboardEvent) => event.preventDefault();
      window.addEventListener('keydown', handled, true);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      window.removeEventListener('keydown', handled, true);
      expect(topbarPage(container)).toBe(page);
      // A menu still open over the page, whose listener hasn't run yet.
      const menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      document.body.appendChild(menu);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      menu.remove();
      expect(topbarPage(container)).toBe(page);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(topbarPage(container)).not.toBe(page);
    }
  });

  it('Cmd+J toggles the assistant panel, also from inside a text field', async () => {
    renderShell();
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    try {
      fireEvent.keyDown(field, { key: 'j', metaKey: true });
      // The skeleton shows once the first probe's grace period is over.
      expect(await screen.findByRole('complementary', { name: 'Assistant' })).toBeTruthy();
      fireEvent.keyDown(window, { key: 'J', ctrlKey: true });
      expect(screen.queryByRole('complementary', { name: 'Assistant' })).toBeNull();
    } finally {
      field.remove();
      act(() => resetAssistantStoreForTests());
    }
  });

  it('Cmd+W in the assistant panel closes the panel, not the focused pane', async () => {
    storeState.focusedPane = 'L';
    renderShell();
    try {
      fireEvent.keyDown(window, { key: 'j', metaKey: true });
      const close = await screen.findByRole('button', { name: 'Close' });
      close.focus();
      fireEvent.keyDown(close, { key: 'w', metaKey: true });
      expect(screen.queryByRole('complementary', { name: 'Assistant' })).toBeNull();
      expect(closePaneSpy).not.toHaveBeenCalled();
    } finally {
      act(() => resetAssistantStoreForTests());
    }
  });

  it('Cmd+J with the assistant open as a pane brings it back to the floating panel', async () => {
    const info = { nodeId: 'n-asst', workspaceId: 'sys', treeId: 't-asst', settings: { runtimeId: 'claude' as const, modelId: null, reasoning: null }, supportedRuntimes: ['claude' as const] };
    act(() => resetAssistantStoreForTests({ status: 'ready', info }));
    storeState.openPanes = ['n-asst'];
    storeState.focusedPane = 'n-asst';
    closePaneSpy.mockImplementation((id: string) => {
      storeState.openPanes = storeState.openPanes.filter((pane) => pane !== id);
      storeState.focusedPane = null;
    });
    renderShell();
    navTo('dashboard');
    try {
      fireEvent.keyDown(window, { key: 'j', metaKey: true });
      expect(closePaneSpy).toHaveBeenCalledWith('n-asst');
      expect(getAssistantSnapshot().open).toBe(true);
      expect(await screen.findByRole('complementary', { name: 'Assistant' })).toBeTruthy();
    } finally {
      act(() => resetAssistantStoreForTests());
    }
  });

  it('Escape on the page closes the assistant panel before leaving the page', async () => {
    const { container } = renderShell();
    navTo('branches');
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    await screen.findByRole('complementary', { name: 'Assistant' });
    // Focus on the page, outside the panel and outside any text field.
    (document.activeElement as HTMLElement | null)?.blur();
    try {
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(screen.queryByRole('complementary', { name: 'Assistant' })).toBeNull();
      expect(topbarPage(container)).toBe('branches');
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(topbarPage(container)).toBe('dashboard');
    } finally {
      act(() => resetAssistantStoreForTests());
    }
  });

  it('Escape on the page leaves an open menu or dialog its key, not the assistant panel', async () => {
    renderShell();
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    await screen.findByRole('complementary', { name: 'Assistant' });
    (document.activeElement as HTMLElement | null)?.blur();
    const layer = document.createElement('div');
    document.body.appendChild(layer);
    try {
      // Menus, open dialogs, and layers that close on any Esc (the pane find
      // bar, the selection toolbar, the narrow sidebar overlay).
      for (const [name, value] of [['role', 'menu'], ['role', 'dialog'], ['data-escape-layer', 'pane'], ['data-escape-layer', 'shell']]) {
        layer.setAttribute(name, value);
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(screen.getByRole('complementary', { name: 'Assistant' })).toBeTruthy();
        layer.removeAttribute(name);
      }
      // A drawer that is sliding out (aria-hidden) is no longer a layer.
      layer.setAttribute('role', 'dialog');
      layer.setAttribute('aria-hidden', 'true');
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(screen.queryByRole('complementary', { name: 'Assistant' })).toBeNull();
    } finally {
      layer.remove();
      act(() => resetAssistantStoreForTests());
    }
  });

  it('Cmd+J does nothing when the backend has no assistant', () => {
    act(() => resetAssistantStoreForTests({ status: 'unsupported' }));
    try {
      renderShell();
      fireEvent.keyDown(window, { key: 'j', metaKey: true });
      expect(screen.queryByRole('complementary', { name: 'Assistant' })).toBeNull();
    } finally {
      act(() => resetAssistantStoreForTests());
    }
  });
});
