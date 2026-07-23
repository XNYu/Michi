/**
 * Opening a conversation from global search (CommandPalette → navigateToNode)
 * must land the focused pane on the target node and make the sidebar expand
 * down to its row (WorkspaceTree's reveal effect) — across workspace and
 * thread boundaries.
 *
 * The third case is the regression: navigating to a node in ANOTHER
 * workspace's active tree used to take the plain `openPane` branch, which
 * writes through the still-active (old workspace) paneKey; the
 * workspace-switch auto-open effect then focused the destination tree's root,
 * so the sidebar never revealed the conversation the user clicked.
 */
import React from 'react';
import { vi } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  __esModule: true,
  allocateNodeIds: (() => { let i = 0; return async (count = 1) => Array.from({ length: count }, () => `n-test-${++i}`); })(),
  listAgentModes: () => Promise.resolve([]),
  fetchAgentStatus: () => Promise.resolve(null),
  listModels: () => Promise.resolve({ models: [], defaultModel: null }),
  fetchPrefs: () => Promise.resolve(null),
  savePrefs: () => Promise.resolve(),
  deleteWorkspace: () => Promise.resolve({ ok: true }),
  setChatMode: () => Promise.resolve('fake-chat'),
  respondToPermission: () => Promise.resolve({ ok: true }),
  cancelPermission: () => Promise.resolve({ ok: true }),
  warmCwd: () => Promise.resolve({ ok: true }),
  claimPane: () => Promise.resolve({ owner: true }),
  heartbeatPane: () => Promise.resolve(true),
  releasePane: () => Promise.resolve(),
  subscribeChat: vi.fn(() => () => {}),
  subscribeChats: vi.fn(() => () => {}),
  subscribeBackground: vi.fn(() => () => {}),
  cancelChat: () => Promise.resolve(),
  ensureSession: vi.fn(() => Promise.resolve({ chatId: 'fake-chat', currentModeId: null, resumeStrategy: 'fresh' })),
  streamMessage: vi.fn(() => () => {}),
}));
vi.mock('../../services/notifications', () => ({ notify: vi.fn() }));

import { ChatProvider, useChatStore } from '../../state/chatStore';
import { PrefsProvider, usePrefs } from '../../state/prefs';
import { navigateToNode, type NavigateToNodeDeps } from '../../state/navigateToNode';
import WorkspaceTree from './WorkspaceTree';

// jsdom in this repo lacks the CSS global the reveal effect uses
if (typeof (globalThis as any).CSS === 'undefined') {
  (globalThis as any).CSS = { escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) };
}

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

let storeRef: ReturnType<typeof useChatStore>;
let prefsRef: ReturnType<typeof usePrefs>;

function Probe() {
  storeRef = useChatStore();
  prefsRef = usePrefs();
  return null;
}

function mountTree() {
  return render(
    <PrefsProvider>
      <ChatProvider>
        <Probe />
        <WorkspaceTree />
      </ChatProvider>
    </PrefsProvider>,
  );
}

/** Build the deps object the same way CommandPalette does, from live store state. */
function deps(): NavigateToNodeDeps {
  return {
    projects: storeRef.projects,
    activeProjectId: storeRef.activeProject?.id ?? null,
    selectProject: storeRef.selectProject,
    openPane: storeRef.openPane,
    openPaneInTree: storeRef.openPaneInTree,
    activateTree: storeRef.activateTree,
    setFocusedNodeId: storeRef.setFocusedNodeId,
  };
}

const row = (nodeId: string) => document.querySelector(`[data-sidebar-row="${nodeId}"]`);

describe('sidebar reveal when opening a search result (navigateToNode)', () => {
  let scrollSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    localStorage.clear();
    scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy as unknown as typeof Element.prototype.scrollIntoView;
  });

  it('same workspace, historical thread, deep node — expands thread pinned collapsed', async () => {
    mountTree();
    await act(async () => { await storeRef.createProject('ws1', undefined); });
    await waitFor(() => expect(storeRef.activeProject).toBeTruthy());
    const pid = storeRef.activeProject!.id;

    let rootA = '';
    let rootB = '';
    let childB = '';
    await act(async () => { rootA = (await storeRef.createThread()) ?? ''; });
    await act(async () => { rootB = (await storeRef.createThread()) ?? ''; });
    await act(async () => { childB = await storeRef.createBlankChild(rootB); });
    const treeA = storeRef.activeProject!.trees.find((t) => t.rootNodeId === rootA)!.id;
    const treeB = storeRef.activeProject!.trees.find((t) => t.rootNodeId === rootB)!.id;

    // back to thread A — thread B becomes "historical", pinned collapsed the
    // way snapshotBeforeSwitch leaves rows after past sidebar switches
    act(() => { storeRef.activateTree(treeA, pid); });
    act(() => {
      prefsRef.setPref('sidebarExpanded', {
        ...prefsRef.prefs.sidebarExpanded,
        threads: { ...prefsRef.prefs.sidebarExpanded.threads, [treeB]: false },
      });
    });
    expect(row(childB)).toBeNull();
    scrollSpy.mockClear();

    act(() => { navigateToNode(deps(), childB, pid); });

    await waitFor(() => expect(storeRef.focusedPane).toBe(childB));
    await waitFor(() => expect(row(childB)).not.toBeNull());
    await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
  });

  it('different workspace, non-active thread of target workspace', async () => {
    mountTree();
    await act(async () => { await storeRef.createProject('wsTarget', undefined); });
    await waitFor(() => expect(storeRef.activeProject).toBeTruthy());
    const pidTarget = storeRef.activeProject!.id;

    let rootA = '';
    let rootB = '';
    let childB = '';
    await act(async () => { rootA = (await storeRef.createThread()) ?? ''; });
    await act(async () => { rootB = (await storeRef.createThread()) ?? ''; });
    await act(async () => { childB = await storeRef.createBlankChild(rootB); });
    const treeA = storeRef.projects.find((p) => p.id === pidTarget)!.trees.find((t) => t.rootNodeId === rootA)!.id;
    act(() => { storeRef.activateTree(treeA, pidTarget); });

    await act(async () => { await storeRef.createProject('wsOther', undefined); });
    await waitFor(() => expect(storeRef.activeProject!.name).toBe('wsOther'));
    await act(async () => { await storeRef.createThread(); });
    expect(row(childB)).toBeNull();
    scrollSpy.mockClear();

    act(() => { navigateToNode(deps(), childB, pidTarget); });

    await waitFor(() => expect(storeRef.focusedPane).toBe(childB));
    await waitFor(() => expect(row(childB)).not.toBeNull());
    await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
  });

  it('historical thread beyond the Show-more preview cap still gets revealed', async () => {
    // Distinct, increasing timestamps so sortTrees ranks the first-created
    // tree last (real threads never share a lastActiveAt millisecond).
    let now = 1_000_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => (now += 1));
    try {
      mountTree();
      await act(async () => { await storeRef.createProject('ws1', undefined); });
      await waitFor(() => expect(storeRef.activeProject).toBeTruthy());
      const pid = storeRef.activeProject!.id;

      let rootOld = '';
      let childOld = '';
      await act(async () => { rootOld = (await storeRef.createThread()) ?? ''; });
      await act(async () => { childOld = await storeRef.createBlankChild(rootOld); });
      // six fresher threads push the first one past THREAD_PREVIEW_LIMIT (5)
      for (let i = 0; i < 6; i++) await act(async () => { await storeRef.createThread(); });

      // beyond the cap → its row is not in the DOM at all
      expect(row(rootOld)).toBeNull();
      scrollSpy.mockClear();

      act(() => { navigateToNode(deps(), childOld, pid); });

      await waitFor(() => expect(storeRef.focusedPane).toBe(childOld));
      // active tree is appended below the preview slice, then revealed
      await waitFor(() => expect(row(rootOld)).not.toBeNull());
      await waitFor(() => expect(row(childOld)).not.toBeNull());
      await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('archived thread: navigating to it still focuses the pane even though the sidebar no longer shows archived sections', async () => {
    mountTree();
    await act(async () => { await storeRef.createProject('ws1', undefined); });
    await waitFor(() => expect(storeRef.activeProject).toBeTruthy());
    const pid = storeRef.activeProject!.id;

    let rootT = '';
    let childT = '';
    await act(async () => { rootT = (await storeRef.createThread()) ?? ''; });
    await act(async () => { childT = await storeRef.createBlankChild(rootT); });
    const treeT = storeRef.activeProject!.trees.find((t) => t.rootNodeId === rootT)!.id;
    await act(async () => { await storeRef.createThread(); }); // another live thread stays active
    act(() => { storeRef.archiveTree(treeT); });

    // Archived threads are not shown in sidebar (ArchivedSection removed)
    expect(row(rootT)).toBeNull();
    scrollSpy.mockClear();

    act(() => { navigateToNode(deps(), childT, pid); });

    // Navigation still focuses the pane even for archived nodes
    await waitFor(() => expect(storeRef.focusedPane).toBe(childT));
    // Sidebar rows remain absent since archived section was removed
    expect(row(rootT)).toBeNull();
    expect(row(childT)).toBeNull();
  });

  it('different workspace, node in the ACTIVE tree of target workspace (regression)', async () => {
    mountTree();
    await act(async () => { await storeRef.createProject('wsTarget', undefined); });
    await waitFor(() => expect(storeRef.activeProject).toBeTruthy());
    const pidTarget = storeRef.activeProject!.id;

    let rootB = '';
    let childB = '';
    await act(async () => { rootB = (await storeRef.createThread()) ?? ''; });
    await act(async () => { childB = await storeRef.createBlankChild(rootB); });
    // tree B stays the ACTIVE tree of wsTarget

    await act(async () => { await storeRef.createProject('wsOther', undefined); });
    await waitFor(() => expect(storeRef.activeProject!.name).toBe('wsOther'));
    await act(async () => { await storeRef.createThread(); });
    scrollSpy.mockClear();

    act(() => { navigateToNode(deps(), childB, pidTarget); });

    // the conversation the user clicked is the focused pane — not the root
    // the auto-open effect would have substituted via the stale-slot path
    await waitFor(() => expect(storeRef.focusedPane).toBe(childB));
    await waitFor(() => expect(row(childB)).not.toBeNull());
    await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
  });
});
