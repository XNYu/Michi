/**
 * The assistant's conversation opened as a pane makes its hidden workspace
 * the active one: the topbar names it "Assistant" and offers none of the
 * launchers that act on the active workspace.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/api')>()),
  allocateNodeIdsLocal: (() => { let i = 0; return (count = 1) => Array.from({ length: count }, () => `n-tb-${++i}`); })(),
  checkVersion: vi.fn().mockResolvedValue({ updateAvailable: false }),
  triggerUpdate: vi.fn(),
  listAgentModes: () => Promise.resolve({ availableModes: [], defaultModeId: null }),
  listModels: () => Promise.resolve({ models: [], defaultModel: null }),
  fetchAgentStatus: () => Promise.resolve(null),
  fetchPrefs: () => Promise.resolve(null),
  savePrefs: () => Promise.resolve(),
  warmCwd: () => Promise.resolve({ ok: true }),
  subscribeChat: vi.fn(() => () => {}),
  subscribeChats: vi.fn(() => () => {}),
  subscribeBackground: vi.fn(() => () => {}),
  fetchAllWorkspacesMeta: vi.fn(async () => []),
  fetchTreeMessages: vi.fn(async () => []),
  listBackendConnections: async () => [],
}));
vi.mock('../../../lib/electronBridge', () => ({ getElectron: () => null }));
vi.mock('../PaneLauncher', () => ({ default: () => <button type="button">Pane launcher</button> }));
vi.mock('../BrowserLauncher', () => ({ default: () => <button type="button">Browser launcher</button> }));

import TerminalTopbar from '../Topbar';
import { ChatProvider, useChatActions, useChatStore } from '../../../state/chatStore';
import { PrefsProvider } from '../../../state/prefs';
import { navigateToNode } from '../../../state/navigateToNode';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

const SYSTEM = {
  workspace: { id: 'sys', name: 'Michi assistant workspace', created_at: 1, settings: JSON.stringify({ system: 'assistant' }) },
  trees: [{ id: 't-sys', root_node_id: 'n-sys', last_active_at: 1 }],
  nodes: [{ id: 'n-sys', created_at: 1, title: 'Archive the chat-only threads' }],
  edges: [],
  messages: [],
};

let store: ReturnType<typeof useChatStore>;
let actions: ReturnType<typeof useChatActions>;
function Harness() {
  store = useChatStore();
  actions = useChatActions();
  return null;
}

describe('the topbar with the assistant open as a pane', () => {
  it('says Assistant and drops the workspace launchers', async () => {
    localStorage.clear();
    render(
      <PrefsProvider>
        <ChatProvider>
          <Harness />
          <TerminalTopbar page="dashboard" onNav={vi.fn()} sidebarCollapsed={false} onToggleSidebar={() => {}} workspaceReady />
        </ChatProvider>
      </PrefsProvider>,
    );
    await waitFor(() => expect(store.hydrated).toBe(true));
    await act(async () => { await store.createProject('Work', '/work'); });
    act(() => { store.createThread(); });
    expect(await screen.findByRole('button', { name: 'Overview' })).toBeTruthy();
    expect(screen.getByText('Pane launcher')).toBeTruthy();

    act(() => { actions.installWorkspaceSnapshot(SYSTEM); });
    await waitFor(() => expect(store.projects.some((p) => p.id === 'sys')).toBe(true));
    act(() => {
      navigateToNode({
        projects: store.projects, activeProjectId: store.activeProjectId,
        selectProject: store.selectProject, openPane: store.openPane, openPaneInTree: store.openPaneInTree,
        activateTree: store.activateTree, setFocusedNodeId: store.setFocusedNodeId,
      }, 'n-sys', 'sys');
    });
    await waitFor(() => expect(store.activeProject?.id).toBe('sys'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Overview' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Map' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Digest' })).toBeNull();
    expect(screen.queryByText('Pane launcher')).toBeNull();
    expect(screen.queryByText('Browser launcher')).toBeNull();
    expect(await screen.findByText('Assistant')).toBeTruthy();
    expect(screen.queryByText('Archive the chat-only threads')).toBeNull();
    expect(screen.queryByText('Michi assistant workspace')).toBeNull();
  });

  it('never counts an unread assistant reply on the activity badge', async () => {
    localStorage.clear();
    render(
      <PrefsProvider>
        <ChatProvider>
          <Harness />
          <TerminalTopbar page="home" onNav={vi.fn()} sidebarCollapsed={false} onToggleSidebar={() => {}} workspaceReady />
        </ChatProvider>
      </PrefsProvider>,
    );
    await waitFor(() => expect(store.hydrated).toBe(true));
    await act(async () => { await store.createProject('Work', '/work'); });
    let threadId = '';
    act(() => { threadId = store.createThread()!; });
    act(() => { actions.installWorkspaceSnapshot(SYSTEM); });
    await waitFor(() => expect(store.projects.some((p) => p.id === 'sys')).toBe(true));
    const badge = () => screen.getByRole('button', { name: 'Switch to activity view' }).textContent;

    // The assistant answered in the panel: nothing for the user to find in Activity.
    act(() => { actions.dispatch({ type: 'done', nodeId: 'n-sys', assistantId: 'a-1', completedAt: Date.now() + 60_000 }); });
    await waitFor(() => expect(store.focusedNodeId).toBe(threadId));
    expect(badge()).toBe('');

    // A reply in the user's own thread (not focused) still counts.
    act(() => { store.setFocusedNodeId(null); });
    act(() => { actions.dispatch({ type: 'done', nodeId: threadId, assistantId: 'a-2', completedAt: Date.now() + 60_000 }); });
    await waitFor(() => expect(badge()).toBe('1'));
  });
});
