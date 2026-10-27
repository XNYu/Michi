/**
 * Regression test for: clicking a branch inside an inactive thread (same
 * workspace) must activate that thread *and* leave focus on the clicked
 * branch — not on the destination tree's root.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, act, waitFor } from '@testing-library/react';
import { ChatProvider, useChatStore } from '../../state/chatStore';
import { PrefsProvider } from '../../state/prefs';
import type { ChatNodeState, Project } from '../../state/chatTypes';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    listModels: vi.fn().mockResolvedValue({ models: [], defaultModel: null }),
    listAgentModes: vi.fn().mockResolvedValue({ availableModes: [], defaultModeId: null }),
    fetchAllWorkspaces: vi.fn().mockResolvedValue([]),
    fetchAllWorkspacesMeta: vi.fn().mockResolvedValue([]),
    fetchTreeMessages: vi.fn().mockResolvedValue([]),
    fetchWorkspaces: vi.fn().mockResolvedValue([]),
    fetchWorkspace: vi.fn().mockResolvedValue(null),
    warmCwd: vi.fn().mockResolvedValue(undefined),
  };
});

beforeEach(() => {
  localStorage.clear();
});

function StoreProbe({ outRef }: { outRef: { current: ReturnType<typeof useChatStore> | null } }) {
  outRef.current = useChatStore();
  return null;
}

function setupSeeded(seed: { projects: Project[]; nodes: Record<string, ChatNodeState> }) {
  localStorage.setItem(
    'michi:v1:state',
    JSON.stringify({ version: 2, projects: seed.projects, nodes: seed.nodes, activeProjectId: 'p1' }),
  );
  localStorage.setItem('michi:migrated', '1');
  const storeRef: { current: ReturnType<typeof useChatStore> | null } = { current: null };
  render(
    <PrefsProvider>
      <ChatProvider>
        <StoreProbe outRef={storeRef} />
      </ChatProvider>
    </PrefsProvider>,
  );
  return storeRef;
}

// Mirror WorkspaceTree.selectBranch's plain-click branch.
function clickBranchAcrossThread(
  store: ReturnType<typeof useChatStore>,
  nodeId: string,
) {
  const owningProject = store.projects.find(
    (p) => !p.deletedAt && p.chatIds.includes(nodeId),
  );
  if (!owningProject) throw new Error('owning project missing');
  // Resolve owning tree by walking branch edges back to a root.
  const parentOf = new Map<string, string>();
  for (const e of owningProject.edges) {
    if (e.kind !== undefined && e.kind !== 'branch') continue;
    parentOf.set(e.target, e.source);
  }
  let cur: string | undefined = nodeId;
  let owningTreeId: string | null = null;
  while (cur) {
    const matched = owningProject.trees.find((t) => t.rootNodeId === cur);
    if (matched) { owningTreeId = matched.id; break; }
    cur = parentOf.get(cur);
  }
  if (!owningTreeId) throw new Error('owning tree missing');
  const crossesThread =
    owningProject.id !== store.activeProjectId ||
    owningTreeId !== owningProject.activeTreeId;
  if (crossesThread) {
    store.openPaneInTree(owningProject.id, owningTreeId, nodeId);
    if (owningProject.id !== store.activeProjectId) store.selectProject(owningProject.id);
    if (owningTreeId !== owningProject.activeTreeId) {
      store.activateTree(owningTreeId, owningProject.id);
    }
  } else {
    store.openPane(nodeId);
  }
  store.setFocusedNodeId(nodeId);
}

function crossWorkspaceFixture() {
  const nodes: Record<string, ChatNodeState> = {
    rootA: { nodeId: 'rootA', chatId: null, projectId: 'p1', kind: 'chat',
      title: 'Thread A', messages: [], followUps: [], status: 'idle' },
    rootB: { nodeId: 'rootB', chatId: null, projectId: 'p2', kind: 'chat',
      title: 'Thread B', messages: [], followUps: [], status: 'idle' },
    branchB: { nodeId: 'branchB', chatId: null, projectId: 'p2', kind: 'chat',
      title: 'Branch under B', messages: [], followUps: [], status: 'idle' },
  };
  const projects: Project[] = [
    {
      id: 'p1', name: 'Workspace one', cwd: '~/x',
      chatIds: ['rootA'], edges: [],
      trees: [{ id: 'tA', rootNodeId: 'rootA', createdAt: 0, lastActiveAt: 100 }],
      activeTreeId: 'tA', createdAt: 0,
    },
    {
      id: 'p2', name: 'Workspace two', cwd: '~/y',
      chatIds: ['rootB', 'branchB'],
      edges: [{ source: 'rootB', target: 'branchB', kind: 'branch' }],
      trees: [{ id: 'tB', rootNodeId: 'rootB', createdAt: 0, lastActiveAt: 50 }],
      activeTreeId: 'tB', createdAt: 0,
    },
  ];
  return { nodes, projects };
}

describe('cross-thread branch click', () => {
  it('cross workspace: clicks branchB in p2 → p2/tB activated, focus on branchB, pane = [branchB]', async () => {
    const storeRef = setupSeeded(crossWorkspaceFixture());
    await waitFor(() => expect(storeRef.current?.activeProject?.id).toBe('p1'));

    act(() => {
      clickBranchAcrossThread(storeRef.current!, 'branchB');
    });

    await waitFor(() => {
      expect(storeRef.current?.activeProject?.id).toBe('p2');
    });
    expect(storeRef.current?.activeProject?.activeTreeId).toBe('tB');
    expect(storeRef.current?.focusedNodeId).toBe('branchB');
    expect(storeRef.current?.openPanes).toEqual(['branchB']);
    expect(storeRef.current?.focusedPane).toBe('branchB');
  });
});
