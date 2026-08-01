import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  fetchAllWorkspacesMeta: vi.fn(),
  fetchTreeMessages: vi.fn<(workspaceId: string, treeId: string) => Promise<unknown[]>>(async () => []),
  fetchWorkspace: vi.fn<() => Promise<unknown>>(async () => null),
  subscribeBackground: vi.fn(() => () => {}),
  subscribeChat: vi.fn(() => () => {}),
  claimPane: vi.fn(async () => ({ owner: true })),
  cancelChat: vi.fn(async () => {}),
  allocateNodeIds: vi.fn(async () => ['node-created']),
  ensureSession: vi.fn(),
  streamMessage: vi.fn(() => () => {}),
}));

vi.mock('../services/api', () => ({
  fetchAllWorkspacesMeta: apiMocks.fetchAllWorkspacesMeta,
  fetchPersistenceCapabilities: vi.fn(async () => ({
    protocolVersion: 2,
    authoritativeTurnPersistence: true,
    durableNodePrerequisite: true,
    explicitCommands: true,
    backgroundWorkspaceSync: false,
    legacySyncAccepted: true,
  })),
  fetchTreeMessages: apiMocks.fetchTreeMessages,
  fetchWorkspace: apiMocks.fetchWorkspace,
  fetchWorkspaces: vi.fn(async () => []),
  applyWorkspaceCommands: vi.fn(async () => {}),
  fetchAgentStatus: vi.fn(async () => null),
  fetchReady: vi.fn(async () => ({ status: 'ready' })),
  listAgentModes: vi.fn(async () => []),
  listAgentModels: vi.fn(async () => ({ models: [], defaultModel: null })),
  fetchPrefs: vi.fn(async () => null),
  savePrefs: vi.fn(async () => {}),
  artifactWatchStreamUrl: vi.fn((id: string) => `/api/workspaces/${id}/watch/stream`),
  postArtifactWatchPaths: vi.fn(async () => ({ watching: [] })),
  subscribeBackground: apiMocks.subscribeBackground,
  subscribeChat: apiMocks.subscribeChat,
  claimPane: apiMocks.claimPane,
  heartbeatPane: vi.fn(async () => true),
  releasePane: vi.fn(async () => {}),
  warmCwd: vi.fn(async () => ({ ok: true })),
  cancelChat: apiMocks.cancelChat,
  allocateNodeIds: apiMocks.allocateNodeIds,
  setChatMode: vi.fn(async () => null),
  respondToPermission: vi.fn(async () => ({ ok: true })),
  cancelPermission: vi.fn(async () => ({ ok: true })),
  respondToUserInput: vi.fn(async () => ({ ok: true })),
  skipUserInput: vi.fn(async () => ({ ok: true })),
  ensureSession: apiMocks.ensureSession,
  streamMessage: apiMocks.streamMessage,
}));

import { ChatProvider, useChatActions, useChatNodesSnapshot, useChatStore } from './chatStore';
import { PrefsProvider } from './prefs';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <PrefsProvider><ChatProvider>{children}</ChatProvider></PrefsProvider>;
}

describe('background feed hydration gate', () => {
  beforeEach(() => {
    apiMocks.fetchTreeMessages.mockReset();
    apiMocks.fetchTreeMessages.mockResolvedValue([]);
    apiMocks.subscribeChat.mockReset();
    apiMocks.subscribeChat.mockReturnValue(() => {});
  });

  it('reattaches one direct replay stream for a hydrated foreground turn', async () => {
    localStorage.clear();
    apiMocks.subscribeChat.mockClear();
    apiMocks.fetchTreeMessages.mockResolvedValue([
      { id: 'user-live', node_id: 'node-live', role: 'user', content: 'question', seq: 0, created_at: 1 },
      { id: 'assistant-live', node_id: 'node-live', role: 'assistant', content: 'partial', seq: 1, created_at: 2 },
    ]);
    apiMocks.fetchAllWorkspacesMeta.mockResolvedValue([{
      workspace: { id: 'workspace-live', name: 'Live', active_tree_id: 'tree-live', created_at: 1 },
      trees: [{ id: 'tree-live', workspace_id: 'workspace-live', root_node_id: 'node-live', created_at: 1, last_active_at: 1 }],
      nodes: [{
        id: 'node-live', workspace_id: 'workspace-live', tree_id: 'tree-live', kind: 'chat',
        acp_session_id: 'chat-live', status: 'streaming', last_applied_turn_id: 'turn-live',
        last_applied_seq: 4, message_count: 2, created_at: 1,
      }],
      edges: [], messages: [], artifacts: [],
    }]);

    renderHook(() => useChatNodesSnapshot(), { wrapper });
    await vi.waitFor(() => expect(apiMocks.subscribeChat).toHaveBeenCalledTimes(1));
    const [, handlers, from] = apiMocks.subscribeChat.mock.calls[0] as unknown as [
      string,
      {
        onEnvelope: (data: { assistantId: string; turnId: string; seq: number }) => boolean;
        onChunk: (text: string, seq: number, assistantId: string, turnId: string) => void;
      },
      { turnId: string; seq: number },
    ];
    expect(from).toEqual({ turnId: 'turn-live', seq: 4 });

    let accepted = false;
    let duplicateAccepted = true;
    act(() => {
      accepted = handlers.onEnvelope({ assistantId: 'assistant-live', turnId: 'turn-live', seq: 5 });
      handlers.onChunk(' tail', 5, 'assistant-live', 'turn-live');
      duplicateAccepted = handlers.onEnvelope({ assistantId: 'assistant-live', turnId: 'turn-live', seq: 5 });
    });
    expect(accepted).toBe(true);
    expect(duplicateAccepted).toBe(false);
    expect(apiMocks.subscribeChat).toHaveBeenCalledTimes(1);
  });

  it('starts a missed durable agent-spawn prompt exactly once after hydration', async () => {
    localStorage.clear();
    apiMocks.subscribeBackground.mockClear();
    apiMocks.ensureSession.mockReset();
    apiMocks.streamMessage.mockReset();
    apiMocks.ensureSession.mockResolvedValue({
      chatId: 'node-spawn', currentModeId: null, runtimeId: 'kiro', resumeStrategy: 'live',
    });
    apiMocks.streamMessage.mockReturnValue(() => {});
    apiMocks.fetchAllWorkspacesMeta.mockResolvedValue([{
      workspace: { id: 'workspace-spawn', name: 'Recovery', active_tree_id: 'tree-spawn', created_at: 1 },
      trees: [{ id: 'tree-spawn', workspace_id: 'workspace-spawn', root_node_id: 'node-spawn', created_at: 1, last_active_at: 1 }],
      nodes: [{
        id: 'node-spawn', workspace_id: 'workspace-spawn', tree_id: 'tree-spawn', kind: 'chat',
        spawned_by_agent: 1, title: 'Recovered child', acp_session_id: 'runtime-child', runtime_id: 'kiro',
        composer_draft: JSON.stringify({ __michiPendingSpawnPrompt: 'Investigate the durable gap' }),
        created_at: 1,
      }],
      edges: [], messages: [], artifacts: [],
    }]);

    const { result } = renderHook(
      () => ({ store: useChatStore(), nodes: useChatNodesSnapshot() }),
      { wrapper },
    );
    await vi.waitFor(() => expect(result.current.store.hydrated).toBe(true));
    expect(result.current.nodes['node-spawn']?.pendingSpawnPrompt).toBe('Investigate the durable gap');
    await vi.waitFor(() => expect(apiMocks.streamMessage).toHaveBeenCalledTimes(1));

    expect(apiMocks.ensureSession).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'node-spawn', chatId: 'node-spawn', workspaceId: 'workspace-spawn',
    }));
    const [, recoveredPrompt] = apiMocks.streamMessage.mock.calls[0] as unknown as [string, string];
    expect(recoveredPrompt).toBe('Investigate the durable gap');
    expect(result.current.nodes['node-spawn']?.messages[0]).toMatchObject({
      role: 'user', text: 'Investigate the durable gap',
    });
  });

  it('does not subscribe until node/chat metadata hydration has completed', async () => {
    localStorage.clear();
    apiMocks.subscribeBackground.mockClear();
    const hydration = deferred<unknown[]>();
    apiMocks.fetchAllWorkspacesMeta.mockReturnValue(hydration.promise);
    renderHook(() => useChatStore(), { wrapper });

    await act(async () => { await Promise.resolve(); });
    expect(apiMocks.subscribeBackground).not.toHaveBeenCalled();

    await act(async () => {
      hydration.resolve([]);
      await hydration.promise;
      await Promise.resolve();
    });

    expect(apiMocks.subscribeBackground).toHaveBeenCalledTimes(1);
  });

  it('cancels a background self-turn while its pane claim is still pending', async () => {
    localStorage.clear();
    apiMocks.fetchAllWorkspacesMeta.mockResolvedValue([]);
    apiMocks.subscribeBackground.mockClear();
    apiMocks.claimPane.mockClear();
    apiMocks.cancelChat.mockClear();
    const claim = deferred<{ owner: boolean }>();
    apiMocks.claimPane.mockReturnValue(claim.promise);

    const { result } = renderHook(
      () => ({ store: useChatStore(), actions: useChatActions() }),
      { wrapper },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.actions.createProject('Background stop');
    });

    let nodeId = '';
    await act(async () => {
      nodeId = await result.current.actions.createThread() ?? '';
      result.current.actions.dispatch({ type: 'bind-chat', nodeId });
    });
    expect(nodeId).not.toBe('');
    await vi.waitFor(() => expect(apiMocks.claimPane).toHaveBeenCalledWith(nodeId, expect.any(String), expect.any(String)));
    await vi.waitFor(() => expect(apiMocks.subscribeBackground).toHaveBeenCalled());

    const [handlersForChat] = apiMocks.subscribeBackground.mock.calls.at(-1)! as unknown as [
      (chatId: string, envelopeNodeId?: string) => {
        onTurnStart: (data: { turnId: string; assistantId: string; userText: string; selfInitiated?: boolean }) => void;
      },
    ];
    const handlers = handlersForChat(nodeId, nodeId);
    act(() => {
      handlers.onTurnStart({
        turnId: 'turn-self',
        assistantId: 'assistant-self',
        userText: '',
        selfInitiated: true,
      });
      result.current.actions.cancelStream(nodeId);
    });

    expect(apiMocks.cancelChat).toHaveBeenCalledWith(nodeId, expect.any(String), 'turn-self');

    await act(async () => {
      claim.resolve({ owner: true });
      await claim.promise;
    });
  });

  it('installs a full durable workspace snapshot before acknowledging a replay gap', async () => {
    localStorage.clear();
    apiMocks.subscribeBackground.mockClear();
    apiMocks.fetchAllWorkspacesMeta.mockResolvedValue([{
      workspace: { id: 'ws-gap', name: 'Gap', active_tree_id: 'tree-gap', created_at: 1 },
      trees: [{ id: 'tree-gap', workspace_id: 'ws-gap', root_node_id: 'node-gap', created_at: 1, last_active_at: 1 }],
      nodes: [{
        id: 'node-gap', workspace_id: 'ws-gap', tree_id: 'tree-gap',
        acp_session_id: 'chat-gap', status: 'streaming', message_count: 1, created_at: 1,
      }],
      edges: [], messages: [], artifacts: [],
    }]);
    apiMocks.fetchWorkspace.mockResolvedValue({
      workspace: { id: 'ws-gap', name: 'Gap', active_tree_id: 'tree-gap', created_at: 1 },
      trees: [{ id: 'tree-gap', workspace_id: 'ws-gap', root_node_id: 'node-gap', created_at: 1, last_active_at: 2 }],
      nodes: [
        {
          id: 'node-gap', workspace_id: 'ws-gap', tree_id: 'tree-gap',
          acp_session_id: 'chat-gap', title: 'Recovered', status: 'idle', created_at: 1,
        },
        {
          id: 'spawned', workspace_id: 'ws-gap', tree_id: 'tree-gap', parent_node_id: 'node-gap',
          acp_session_id: 'chat-spawned', title: 'Recovered child', status: 'idle',
          spawned_by_agent: 1, created_at: 2,
        },
      ],
      edges: [{
        id: 'edge-gap', workspace_id: 'ws-gap', source_node_id: 'node-gap',
        target_node_id: 'spawned', kind: 'branch', created_at: 2,
      }],
      messages: [{
        id: 'assistant-gap', node_id: 'node-gap', role: 'assistant',
        content: 'durable body', seq: 0, created_at: 2,
      }],
      artifacts: [{
        id: 'ctx-gap', workspace_id: 'ws-gap', name: 'durable-context',
        file_path: '.artifacts/durable-context.md', source: 'agent', type: 'doc',
        created_at: 2, updated_at: 2,
      }],
    });

    const { result } = renderHook(
      () => ({ store: useChatStore(), nodes: useChatNodesSnapshot() }),
      { wrapper },
    );
    await vi.waitFor(() => expect(apiMocks.subscribeBackground).toHaveBeenCalledTimes(1));
    const [, options] = apiMocks.subscribeBackground.mock.calls[0] as unknown as [
      unknown,
      { onReplayGap: (gap: { chatId: string; nodeId: string; turnId: string; seq: number }) => Promise<void> },
    ];

    await act(async () => {
      await options.onReplayGap({
        chatId: 'node-gap', nodeId: 'node-gap', turnId: 'turn-durable', seq: 9,
      });
    });

    expect(apiMocks.fetchWorkspace).toHaveBeenCalledWith('ws-gap', expect.any(AbortSignal));
    expect(result.current.nodes['node-gap']).toEqual(expect.objectContaining({
      title: 'Recovered', status: 'idle',
      lastAppliedBackgroundTurnId: 'turn-durable', lastAppliedBackgroundSeq: 9,
    }));
    expect(result.current.nodes.spawned).toEqual(expect.objectContaining({
      chatId: 'spawned', spawnedByAgent: true,
    }));
    expect(result.current.store.projects[0].edges).toEqual([
      expect.objectContaining({ source: 'node-gap', target: 'spawned' }),
    ]);
    expect(result.current.store.projects[0].artifacts).toEqual([
      expect.objectContaining({ id: 'ctx-gap', name: 'durable-context' }),
    ]);
  });

  it('reattaches a streaming placeholder in a NON-active tree once it is activated', async () => {
    localStorage.clear();
    apiMocks.subscribeChat.mockClear();
    apiMocks.fetchTreeMessages.mockReset();
    // Only the background tree has a persisted checkpoint body; the active tree
    // (eager-loaded at boot) is empty. Keyed by treeId so both call sites agree.
    apiMocks.fetchTreeMessages.mockImplementation(async (_ws: string, treeId: string) =>
      treeId === 'tree-bg'
        ? [
            { id: 'user-bg', node_id: 'node-bg', role: 'user', content: 'q', seq: 0, created_at: 1 },
            { id: 'assistant-bg', node_id: 'node-bg', role: 'assistant', content: 'partial', seq: 1, created_at: 2 },
          ]
        : [],
    );
    apiMocks.fetchAllWorkspacesMeta.mockResolvedValue([{
      workspace: { id: 'ws', name: 'Two trees', active_tree_id: 'tree-active', created_at: 1 },
      trees: [
        { id: 'tree-active', workspace_id: 'ws', root_node_id: 'node-a', created_at: 1, last_active_at: 2 },
        { id: 'tree-bg', workspace_id: 'ws', root_node_id: 'node-bg', created_at: 1, last_active_at: 1 },
      ],
      nodes: [
        {
          id: 'node-a', workspace_id: 'ws', tree_id: 'tree-active', kind: 'chat',
          acp_session_id: 'chat-a', status: 'idle', created_at: 1,
        },
        {
          id: 'node-bg', workspace_id: 'ws', tree_id: 'tree-bg', kind: 'chat',
          acp_session_id: 'chat-bg', status: 'streaming', last_applied_turn_id: 'turn-bg',
          last_applied_seq: 4, message_count: 2, created_at: 2,
        },
      ],
      edges: [], messages: [], artifacts: [],
    }]);

    const { result } = renderHook(
      () => ({ store: useChatStore(), actions: useChatActions(), nodes: useChatNodesSnapshot() }),
      { wrapper },
    );
    await vi.waitFor(() => expect(result.current.store.hydrated).toBe(true));

    // The streaming node is a placeholder in a non-active tree: its body was
    // never eager-loaded, so recover() has no assistant message to reattach to
    // and nothing subscribes yet.
    expect(apiMocks.subscribeChat).not.toHaveBeenCalled();
    expect(result.current.nodes['node-bg']?.messagesLoaded).toBe(false);

    // Activating the tree lazy-loads its checkpoint body, then reattaches the
    // live replay stream from the persisted watermark.
    await act(async () => { result.current.actions.activateTree('tree-bg', 'ws'); });
    await vi.waitFor(() => expect(apiMocks.fetchTreeMessages).toHaveBeenCalledWith('ws', 'tree-bg'));
    await vi.waitFor(() => expect(apiMocks.subscribeChat).toHaveBeenCalledTimes(1));

    const [chatId, handlers, from] = apiMocks.subscribeChat.mock.calls[0] as unknown as [
      string,
      { onEnvelope: (data: { assistantId: string; turnId: string; seq: number }) => boolean },
      { turnId: string; seq: number },
    ];
    expect(chatId).toBe('node-bg');
    expect(from).toEqual({ turnId: 'turn-bg', seq: 4 });
    // recover() only subscribes when the reattach target has an assistant
    // message, so the reconnect above is itself proof the checkpoint body was
    // loaded (i.e. the pane now shows the backend's latest progress). We assert
    // via subscribeChat rather than the RAF-coalesced nodes snapshot, which does
    // not flush under jsdom's requestAnimationFrame.

    // Live frames past the watermark are accepted (streaming continues); a
    // replayed duplicate is rejected by the exactly-once gate.
    let accepted = false;
    let duplicate = true;
    act(() => {
      accepted = handlers.onEnvelope({ assistantId: 'assistant-bg', turnId: 'turn-bg', seq: 5 });
      duplicate = handlers.onEnvelope({ assistantId: 'assistant-bg', turnId: 'turn-bg', seq: 5 });
    });
    expect(accepted).toBe(true);
    expect(duplicate).toBe(false);
  });
});
