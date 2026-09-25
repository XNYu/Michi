/**
 * Feature 5: Auto-branch on streaming — real behavior test (Task 5.4).
 *
 * Renders ChatProvider and invokes sendMessage / createChildChat on nodes in
 * different statuses, verifying that the services/api mock's streamMessage is
 * (or is not) called. Stronger than the pure-function contract tests in
 * chatStore.test.ts because it exercises the real reducer + useCallback
 * wiring inside the provider.
 *
 * Mock note: Jest 27 + CRA babel-jest had a quirk where `jest.fn(impl)` called
 * inside a `jest.mock` factory silently dropped the implementation. The verbose
 * pattern below (non-spied fns as plain arrows, spied fns as vi.fn()) is a
 * historical workaround preserved during the vitest migration; it can be
 * simplified in a follow-up commit since vitest has no equivalent quirk.
 */
import React from 'react';
import { vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../services/api', () => ({
  __esModule: true,
  allocateNodeIds: (() => { let i = 0; return async (count = 1) => Array.from({ length: count }, () => `n-test-${++i}`); })(),
  allocateNodeIdsLocal: (() => { let i = 0; return (count = 1) => Array.from({ length: count }, () => `n-test-${++i}`); })(),
  // Non-spied: plain arrow that returns what the provider expects.
  listAgentModes: () => Promise.resolve({ availableModes: [], defaultModeId: null }),
  fetchAgentStatus: () => Promise.resolve(null),
  listModels: () => Promise.resolve({ models: [], defaultModel: null }),
  fetchPrefs: () => Promise.resolve(null),
  savePrefs: () => Promise.resolve(),
  deleteWorkspace: () => Promise.resolve({ ok: true }),
  setChatMode: () => Promise.resolve('fake-chat'),
  respondToPermission: () => Promise.resolve({ ok: true }),
  cancelPermission: () => Promise.resolve({ ok: true }),
  warmCwd: () => Promise.resolve({ ok: true }),
  claimPane: vi.fn(() => Promise.resolve({ owner: true })),
  heartbeatPane: () => Promise.resolve(true),
  releasePane: () => Promise.resolve(),
  subscribeChat: vi.fn(() => () => {}),
  subscribeChats: vi.fn(() => () => {}),
  subscribeBackground: vi.fn(() => () => {}),
  cancelChat: () => Promise.resolve(),
  cancelChatAndObserve: vi.fn(() => () => {}),
  fetchAllWorkspacesMeta: vi.fn(async () => []),
  fetchTreeMessages: vi.fn(async () => []),
  listBackendConnections: async () => [],
  // Spied: implementation set in beforeEach.
  bindPendingPrimaryAgent: vi.fn(),
  ensureSession: vi.fn(),
  streamMessage: vi.fn(),
}));

vi.mock('../services/notifications', () => ({ notify: vi.fn() }));
vi.mock('../services/digestApi', () => ({
  streamDigest: vi.fn(async () => '# Decisions\n\nKeep the source thread context.'),
}));

import * as api from '../services/api';
import { notify } from '../services/notifications';
import { ChatProvider, useChatStore, useChatNode, useChatNodesSnapshot } from './chatStore';
import { PrefsProvider } from './prefs';
import type { ChatNodeState } from './chatTypes';
import { dispatchChatStreamEvent } from '../services/chatStreamEvents';

function useStoreAndNodes() {
  const store = useChatStore();
  const nodes = useChatNodesSnapshot();
  return { store, nodes };
}

const mockEnsureSession = api.ensureSession as ReturnType<typeof vi.fn>;
const mockStreamMessage = api.streamMessage as ReturnType<typeof vi.fn>;
const mockNotify = notify as ReturnType<typeof vi.fn>;

// Stub matchMedia — jsdom lacks it and some hooks probe for it.
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

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <PrefsProvider>
      <ChatProvider>{children}</ChatProvider>
    </PrefsProvider>
  );
}

function assistantAnswerRaw(node: ChatNodeState | undefined): string {
  const assistant = node?.messages.find((m) => m.role === 'assistant');
  return (assistant?.blocks ?? [])
    .filter((b) => b.kind === 'answer')
    .map((b) => b.rawText)
    .join('');
}

describe('auto-branch behavior (real provider)', () => {
  beforeEach(() => {
    mockEnsureSession.mockReset();
    mockStreamMessage.mockReset();
    mockNotify.mockReset();
    vi.mocked(api.cancelChatAndObserve).mockReset().mockImplementation(() => () => {});
    vi.mocked(api.subscribeChat).mockReset().mockImplementation(() => () => {});
    vi.mocked(api.subscribeBackground).mockReset().mockImplementation(() => () => {});
    vi.mocked(api.claimPane).mockClear();
    vi.mocked(api.fetchAllWorkspacesMeta).mockReset().mockResolvedValue([]);
    vi.mocked(api.fetchTreeMessages).mockReset().mockResolvedValue([]);
    vi.mocked(api.bindPendingPrimaryAgent).mockReset();
    mockEnsureSession.mockImplementation(() => Promise.resolve({ chatId: 'fake-chat', currentModeId: null, resumeStrategy: 'fresh' }));
    // Real streamMessage returns a cancel fn AND starts an async stream. For
    // our guard test we only need it to be callable and return a no-op cancel.
    mockStreamMessage.mockImplementation(() => () => {});
    localStorage.clear();
  });

  it('includes a newly created tree in an immediate first-turn prerequisite', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });

    await act(async () => {
      await result.current.store.createProject('test', undefined);
    });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());

    let rootId = '';
    await act(async () => {
      rootId = (await result.current.store.createThread()) ?? '';
      result.current.store.sendMessage(rootId, 'hello');
    });

    await waitFor(() => expect(mockEnsureSession).toHaveBeenCalledTimes(1));
    const options = mockEnsureSession.mock.calls[0][0] as {
      graphPrerequisite: {
        workspace: { activeTreeId: string | null };
        tree?: { id: string; rootNodeId: string };
        node: { id: string; treeId: string | null };
      };
    };
    const prerequisite = options.graphPrerequisite;

    expect(prerequisite.tree).toEqual(expect.objectContaining({ rootNodeId: rootId }));
    expect(prerequisite.node).toEqual(expect.objectContaining({ id: rootId }));
    expect(prerequisite.node.treeId).toBe(prerequisite.tree?.id);
    expect(prerequisite.workspace.activeTreeId).toBe(prerequisite.tree?.id);
  });

  it('clears the unread focus exemption when the focused pane is closed', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => {
      await result.current.store.createProject('test', undefined);
    });
    let rootId = '';
    await act(async () => {
      rootId = await result.current.store.createThread() ?? '';
      result.current.store.setFocusedNodeId(rootId);
    });
    expect(result.current.store.focusedNodeId).toBe(rootId);

    act(() => result.current.store.closePane(rootId));

    expect(result.current.store.focusedPane).toBeNull();
    expect(result.current.store.focusedNodeId).toBeNull();
  });

  it('sendMessage on a streaming node does NOT call streamMessage (guard fires)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });

    await act(async () => {
      await result.current.store.createProject('test', undefined);
    });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());
    // Workspaces start empty; create the first thread explicitly so we have
    // a node to send messages to. Mirrors what Home composer's submit does.
    let rootId: string = '';
    await act(async () => {
      rootId = (await result.current.store.createThread()) ?? '';
    });

    // First send: idle → streaming. streamMessage is called once.
    await act(async () => {
      result.current.store.sendMessage(rootId, 'hello');
    });
    await waitFor(() => expect(result.current.nodes[rootId].status).toBe('streaming'));
    expect(mockStreamMessage).toHaveBeenCalledTimes(1);
    mockStreamMessage.mockClear();

    // Second send to the still-streaming node: guard fires, no call.
    await act(async () => {
      result.current.store.sendMessage(rootId, 'second message');
    });
    expect(mockStreamMessage).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('sendMessage called on streaming node'),
    );

    warnSpy.mockRestore();
  });

  it.each([
    ['resolve', 'setup'],
    ['reject', 'setup'],
    ['resolve', 'streaming'],
    ['reject', 'streaming'],
  ] as const)('isolates a cancelled ensure that later %ss while the new send is %s', async (outcome, newerPhase) => {
    type Ensured = Awaited<ReturnType<typeof api.ensureSession>>;
    let resolveOld!: (value: Ensured) => void;
    let rejectOld!: (error: Error) => void;
    let resolveNew!: (value: Ensured) => void;
    const oldEnsure = new Promise<Ensured>((resolve, reject) => {
      resolveOld = resolve;
      rejectOld = reject;
    });
    const newEnsure = new Promise<Ensured>((resolve) => { resolveNew = resolve; });
    // Ignore abort deliberately: a late transport completion must remain harmless.
    mockEnsureSession.mockImplementationOnce(() => oldEnsure).mockImplementationOnce(() => newEnsure);
    const cancelOutput = vi.fn();
    mockStreamMessage.mockImplementation((_nodeId, _text, handlers: api.StreamHandlers) => () => {
      cancelOutput();
      handlers.onAborted?.();
    });
    const { result, rerender } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    let nodeId = '';
    await act(async () => { nodeId = result.current.store.createThread() ?? ''; });

    act(() => { result.current.store.sendMessage(nodeId, 'cancelled prompt'); });
    expect(result.current.nodes[nodeId].status).toBe('streaming');
    const oldSignal = mockEnsureSession.mock.calls[0][0].signal as AbortSignal;
    expect(oldSignal.aborted).toBe(false);
    const oldAssistantId = result.current.nodes[nodeId].messages.at(-1)!.id;
    act(() => { result.current.store.cancelStream(nodeId); });
    expect(oldSignal.aborted).toBe(true);
    expect(result.current.nodes[nodeId].status).toBe('idle');
    expect(result.current.nodes[nodeId].messages.at(-1)?.streaming).toBe(false);
    expect(mockStreamMessage).not.toHaveBeenCalled();
    expect(api.cancelChatAndObserve).not.toHaveBeenCalled();

    act(() => { result.current.store.sendMessage(nodeId, 'new prompt'); });
    expect(mockEnsureSession).toHaveBeenCalledTimes(2);
    const newSignal = mockEnsureSession.mock.calls[1][0].signal as AbortSignal;
    const newAssistantId = result.current.nodes[nodeId].messages.at(-1)!.id;
    expect(newSignal).not.toBe(oldSignal);
    expect(newSignal.aborted).toBe(false);
    expect(newAssistantId).not.toBe(oldAssistantId);
    const openNew = async () => {
      await act(async () => {
        resolveNew({ chatId: nodeId, currentModeId: 'new-mode', resumeStrategy: 'fresh', runtimeId: 'claude', modelId: 'new-model' });
      });
      const handlers = mockStreamMessage.mock.calls[0][2] as api.StreamHandlers;
      act(() => { handlers.onRetryStart?.({ detail: 'Restoring new turn' }); });
      rerender();
    };
    if (newerPhase === 'streaming') await openNew();

    await act(async () => {
      if (outcome === 'resolve') {
        resolveOld({ chatId: nodeId, currentModeId: 'old-mode', resumeStrategy: 'fresh', runtimeId: 'codex', modelId: 'old-model' });
      } else {
        rejectOld(new Error('late failure from cancelled setup'));
      }
    });
    rerender();
    expect(result.current.nodes[nodeId].status).toBe('streaming');
    expect(result.current.nodes[nodeId].error).toBeUndefined();
    expect(result.current.nodes[nodeId].messages.at(-1)?.id).toBe(newAssistantId);
    expect(newSignal.aborted).toBe(false);
    expect(cancelOutput).not.toHaveBeenCalled();
    if (newerPhase === 'setup') {
      expect(result.current.nodes[nodeId].chatId).toBeNull();
      expect(mockStreamMessage).not.toHaveBeenCalled();
      await openNew();
    }
    expect(mockStreamMessage).toHaveBeenCalledTimes(1);
    expect(mockStreamMessage.mock.calls[0][1]).toBe('new prompt');
    expect(result.current.nodes[nodeId]).toMatchObject({
      status: 'streaming', runtimeId: 'claude', modelId: 'new-model',
      currentModeId: 'new-mode', runtimeActivity: 'Restoring new turn',
    });
    act(() => { result.current.store.cancelStream(nodeId); });
    expect(cancelOutput).toHaveBeenCalledTimes(1);
    expect(result.current.nodes[nodeId].status).toBe('idle');
  });

  function hydratedCancellationNode(status: 'idle' | 'streaming') {
    vi.mocked(api.fetchAllWorkspacesMeta).mockResolvedValue([{
      workspace: { id: 'cancel-ws', name: 'Cancellation', created_at: 1, active_tree_id: 'cancel-tree' },
      trees: [{ id: 'cancel-tree', root_node_id: 'cancel-node', created_at: 1, last_active_at: 1 }],
      nodes: [{
        id: 'cancel-node', status, acp_session_id: 'native-session', runtime_id: 'claude',
        last_applied_turn_id: 'old-foreground', last_applied_seq: 1,
      }],
      messages: [
        { id: 'old-user', node_id: 'cancel-node', role: 'user', content: 'earlier prompt', seq: 0 },
        { id: 'old-a', node_id: 'cancel-node', role: 'assistant', content: 'partial', seq: 1 },
      ],
    }]);
    return renderHook(() => ({ store: useChatStore(), node: useChatNode('cancel-node') }), { wrapper });
  }

  function backgroundForCancellationNode() {
    const handlersForChat = vi.mocked(api.subscribeBackground).mock.calls.at(-1)![0];
    return handlersForChat('cancel-node', 'cancel-node');
  }

  it('fallback Stop targets the active background turn after a completed foreground turn', async () => {
    const { result } = hydratedCancellationNode('idle');
    await waitFor(() => expect(result.current.node?.status).toBe('idle'));
    await act(async () => { result.current.store.openPane('cancel-node'); });
    await waitFor(() => expect(api.claimPane).toHaveBeenCalled());
    await waitFor(() => expect(api.subscribeBackground).toHaveBeenCalledTimes(1));
    await act(async () => { result.current.store.sendMessage('cancel-node', 'foreground'); });
    const foreground = mockStreamMessage.mock.calls[0][2] as api.StreamHandlers;
    act(() => {
      dispatchChatStreamEvent({ event: 'turn_start', data: {
        nodeId: 'cancel-node', turnId: 'foreground-turn', assistantId: 'foreground-a', seq: 0, userText: 'foreground',
      } }, foreground);
    });
    expect(result.current.node?.activeTurnId).toBe('foreground-turn');
    act(() => { foreground.onDone?.('end_turn', 'foreground-a', 'foreground-turn', true); });
    expect(result.current.node?.activeTurnId).toBeUndefined();

    const background = backgroundForCancellationNode();
    act(() => {
      dispatchChatStreamEvent({ event: 'turn_start', data: {
        nodeId: 'cancel-node', turnId: 'background-turn', assistantId: 'background-a', seq: 0, userText: '', selfInitiated: true,
      } }, background);
    });
    expect(result.current.node).toMatchObject({
      status: 'streaming', activeTurnId: 'background-turn', lastAppliedTurnId: 'foreground-turn',
    });
    act(() => { result.current.store.cancelStream('cancel-node'); });
    expect(api.cancelChatAndObserve).toHaveBeenCalledExactlyOnceWith(
      'cancel-node', expect.any(String), 'background-turn', expect.any(Function),
    );
    expect(result.current.node?.status).toBe('idle');
    expect(result.current.node?.messages.at(-1)?.streaming).toBe(false);
    expect(api.subscribeBackground).toHaveBeenCalledTimes(1);
  });

  it('recovered Stop finalizes the captured assistant and delivers cleanup status through useChatNode', async () => {
    const detach = vi.fn();
    vi.mocked(api.subscribeChat).mockImplementation(() => detach);
    const { result } = hydratedCancellationNode('streaming');
    await waitFor(() => expect(api.subscribeChat).toHaveBeenCalledTimes(1));
    expect(result.current.node?.activeTurnId).toBe('old-foreground');
    const replay = vi.mocked(api.subscribeChat).mock.calls[0][1];
    act(() => {
      dispatchChatStreamEvent({ event: 'chunk', data: {
        turnId: 'old-foreground', assistantId: 'old-a', seq: 2, text: ' still streaming',
      } }, replay);
    });
    await waitFor(() => expect(result.current.node?.messages.at(-1)?.blocks?.some((block) =>
      block.kind === 'answer' && block.streaming,
    )).toBe(true));
    act(() => { result.current.store.cancelStream('cancel-node'); });
    expect(detach).toHaveBeenCalledTimes(1);
    expect(result.current.node?.status).toBe('idle');
    expect(result.current.node?.activeTurnId).toBeUndefined();
    expect(result.current.node?.messages.at(-1)?.streaming).toBe(false);
    expect(result.current.node?.messages.at(-1)?.blocks?.some((block) =>
      (block.kind === 'answer' || block.kind === 'thinking') && block.streaming,
    )).toBe(false);
    expect(api.cancelChatAndObserve).toHaveBeenCalledExactlyOnceWith(
      'cancel-node', expect.any(String), 'old-foreground', expect.any(Function),
    );
    const onStatus = vi.mocked(api.cancelChatAndObserve).mock.calls[0][3];
    act(() => { onStatus({ state: 'pending', detail: 'Waiting for cleanup' }); });
    expect(result.current.node?.runtimeActivity).toBe('Waiting for cleanup');
    act(() => { onStatus({ state: 'settled' }); });
    expect(result.current.node?.runtimeActivity).toBeUndefined();
    expect(result.current.node?.status).toBe('idle');
    expect(api.subscribeBackground).toHaveBeenCalledTimes(1);

    await act(async () => { result.current.store.sendMessage('cancel-node', 'new foreground'); });
    const newAssistant = result.current.node?.messages.at(-1)?.id;
    act(() => { onStatus({ state: 'error', detail: 'late old cleanup error' }); });
    expect(result.current.node?.status).toBe('streaming');
    expect(result.current.node?.error).toBeUndefined();
    expect(result.current.node?.messages.at(-1)?.id).toBe(newAssistant);
    act(() => { (mockStreamMessage.mock.calls[0][2] as api.StreamHandlers).onDone?.(); });
  });

  it('recovered replay 410 drops the stale Stop callback while background retains the live node', async () => {
    const detach = vi.fn();
    vi.mocked(api.subscribeChat).mockImplementation(() => detach);
    const { result } = hydratedCancellationNode('streaming');
    await waitFor(() => expect(api.subscribeChat).toHaveBeenCalledTimes(1));
    await act(async () => { result.current.store.openPane('cancel-node'); });
    await waitFor(() => expect(api.claimPane).toHaveBeenCalled());
    await waitFor(() => expect(api.subscribeBackground).toHaveBeenCalledTimes(1));
    const disconnect = vi.mocked(api.subscribeChat).mock.calls[0][3]!.onDisconnect!;
    act(() => { disconnect({ retryable: false, error: new Error('subscribe failed: 410') }); });
    expect(result.current.node?.status).toBe('streaming');
    const background = backgroundForCancellationNode();
    act(() => {
      dispatchChatStreamEvent({ event: 'turn_start', data: {
        nodeId: 'cancel-node', turnId: 'background-turn', assistantId: 'background-a', seq: 0, userText: '', selfInitiated: true,
      } }, background);
      result.current.store.cancelStream('cancel-node');
    });
    expect(api.cancelChatAndObserve).toHaveBeenCalledExactlyOnceWith(
      'cancel-node', expect.any(String), 'background-turn', expect.any(Function),
    );
    expect(result.current.node?.status).toBe('idle');
    expect(detach).not.toHaveBeenCalled();
  });

  it('createChildChat from a streaming parent starts an independent new stream', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });

    await act(async () => {
      await result.current.store.createProject('test', undefined);
    });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());
    // Workspaces start empty; create the first thread explicitly so we have
    // a node to send messages to. Mirrors what Home composer's submit does.
    let rootId: string = '';
    await act(async () => {
      rootId = (await result.current.store.createThread()) ?? '';
    });

    await act(async () => {
      result.current.store.sendMessage(rootId, 'parent turn');
    });
    await waitFor(() => expect(result.current.nodes[rootId].status).toBe('streaming'));
    mockStreamMessage.mockClear();
    mockEnsureSession.mockClear();

    let childId: string | undefined;
    await act(async () => {
      childId = await result.current.store.createChildChat(rootId, 'branch off');
    });

    expect(childId).toBeDefined();
    expect(result.current.nodes[childId!]).toBeDefined();
    expect(result.current.nodes[childId!].parentNodeId).toBe(rootId);
    expect(mockEnsureSession).toHaveBeenCalled();
    expect(mockStreamMessage).toHaveBeenCalledTimes(1);
    // Parent node remains streaming; child gets its own turn.
    expect(result.current.nodes[rootId].status).toBe('streaming');
  });

  it.each(['mode', 'primary'] as const)('starts a digest follow-up with its selected %s Agent and source context', async (selection) => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    let rootId = '';
    await act(async () => { rootId = result.current.store.createThread()!; });
    const projectId = result.current.store.activeProject!.id;
    const treeId = result.current.store.activeProject!.activeTreeId;
    let digestId = '';
    await act(async () => { digestId = await result.current.store.createDigest(projectId, [rootId]); });
    await waitFor(() => expect(result.current.nodes[digestId].digest?.status).toBe('idle'));

    let childId = '';
    await act(async () => {
      childId = await result.current.store.createChildChat(digestId, 'Explain the decisions', {
        runtimeId: 'codex', modelId: 'test-model', reasoning: 'high',
      }, selection === 'mode' ? { modeId: 'build' } : {
        primaryAgent: { backendConnectionId: 'local', definitionId: 'implementer' },
      });
    });

    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledOnce());
    expect(result.current.nodes[childId].parentNodeId).toBe(rootId);
    expect(result.current.store.activeProject!.activeTreeId).toBe(treeId);
    expect(result.current.store.focusedPane).toBe(childId);
    expect(mockEnsureSession).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: childId,
      workspaceId: projectId,
      modeId: selection === 'mode' ? 'build' : undefined,
      runtimeId: 'codex', modelId: 'test-model', reasoning: 'high',
      mergeContexts: [expect.stringContaining('Keep the source thread context.')],
      graphPrerequisite: expect.objectContaining({
        node: expect.objectContaining({ id: childId, treeId }),
      }),
    }));
    if (selection === 'primary') {
      expect(api.bindPendingPrimaryAgent).toHaveBeenCalledWith(childId, {
        workspaceId: projectId, backendConnectionId: 'local', definitionId: 'implementer',
      });
      expect(vi.mocked(api.bindPendingPrimaryAgent).mock.invocationCallOrder[0])
        .toBeLessThan(mockEnsureSession.mock.invocationCallOrder[0]);
    }
  });

  it('still notifies when an unfocused pane finishes while the window is focused', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });

    await act(async () => {
      await result.current.store.createProject('test', undefined);
    });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());
    let firstRootId = '';
    let secondRootId = '';
    await act(async () => {
      firstRootId = (await result.current.store.createThread()) ?? '';
    });
    await act(async () => {
      secondRootId = (await result.current.store.createThread()) ?? '';
    });
    await waitFor(() => expect(result.current.store.focusedPane).toBe(secondRootId));

    await act(async () => {
      result.current.store.sendMessage(firstRootId, 'background work');
    });
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));

    const handlers = mockStreamMessage.mock.calls[0][2] as { onDone?: () => void };
    act(() => {
      handlers.onDone?.();
    });

    // The notification fires (intent of this test) and now carries the
    // thread's derived title instead of the generic 'Branch complete' fallback
    // — the first turn's title is derived from the first user message ('background
    // work') at turn-end, so node.title is set by the time the notification builds.
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      title: 'background work',
      body: 'Streaming finished',
    }));
  });

  it('notifies about an Ask User request in a background pane while the window is focused', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });

    await act(async () => {
      await result.current.store.createProject('test', undefined);
    });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());
    let askingId = '';
    await act(async () => {
      askingId = (await result.current.store.createThread()) ?? '';
      // A second thread takes pane focus, so the asking pane is in the background.
      await result.current.store.createThread();
    });

    await act(async () => {
      result.current.store.sendMessage(askingId, 'background work');
    });
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
    mockNotify.mockClear();

    const handlers = mockStreamMessage.mock.calls[0][2] as {
      onUserInputRequest?: (data: unknown) => void;
    };
    act(() => {
      handlers.onUserInputRequest?.({
        requestId: 3,
        questions: [{ question: 'Which database?', options: [], multiSelect: false }],
      });
    });

    // Pre-fix this was gated on `!document.hasFocus()`, so an ask landing in a
    // background pane of a focused window was silent.
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Agent needs your input',
      body: 'Which database?',
    }));
    expect(result.current.nodes[askingId].pendingUserInput?.requestId).toBe(3);
  });

  it('does not let a stale RAF commit roll streaming text backward', async () => {
    const originalWindowRaf = window.requestAnimationFrame;
    const originalGlobalRaf = globalThis.requestAnimationFrame;
    const rafCallbacks: FrameRequestCallback[] = [];
    const fakeRaf = ((cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    }) as typeof requestAnimationFrame;
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: fakeRaf,
    });
    (globalThis as any).requestAnimationFrame = fakeRaf;

    try {
      const { result, rerender } = renderHook(() => useStoreAndNodes(), { wrapper });

      await act(async () => {
        await result.current.store.createProject('test', undefined);
      });
      await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());

      let rootId = '';
      await act(async () => {
        rootId = (await result.current.store.createThread()) ?? '';
      });

      await act(async () => {
        result.current.store.sendMessage(rootId, 'hello');
      });
      await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));

      const handlers = mockStreamMessage.mock.calls[0][2] as {
        onChunk?: (text: string) => void;
      };

      await act(async () => {
        handlers.onChunk?.('a');
        expect(rafCallbacks).toHaveLength(1);
        rafCallbacks.shift()?.(performance.now());
        handlers.onChunk?.('b');
      });

      // Let the React commit from the first RAF run its effect. The committed
      // state only contains "a"; nodesRef has already advanced to "ab".
      await act(async () => {});

      act(() => {
        handlers.onChunk?.('c');
      });

      await act(async () => {
        while (rafCallbacks.length > 0) {
          rafCallbacks.shift()?.(performance.now());
        }
      });

      rerender();
      expect(assistantAnswerRaw(result.current.nodes[rootId])).toBe('abc');
    } finally {
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        writable: true,
        value: originalWindowRaf,
      });
      (globalThis as any).requestAnimationFrame = originalGlobalRaf;
    }
  });

  it('does not let a pending draft RAF resurrect a draft cleared before commit', async () => {
    const originalWindowRaf = window.requestAnimationFrame;
    const originalGlobalRaf = globalThis.requestAnimationFrame;
    const rafCallbacks: FrameRequestCallback[] = [];
    const fakeRaf = ((cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    }) as typeof requestAnimationFrame;
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: fakeRaf,
    });
    (globalThis as any).requestAnimationFrame = fakeRaf;

    try {
      const { result, rerender } = renderHook(() => useStoreAndNodes(), { wrapper });
      await act(async () => {
        await result.current.store.createProject('test', undefined);
      });
      await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());

      let rootId = '';
      await act(async () => {
        rootId = await result.current.store.createThread() ?? '';
      });

      act(() => {
        result.current.store.setComposerDraft(rootId, {
          value: 'do not resurrect',
          mentions: [],
          quotedText: 'selected passage',
        });
        result.current.store.setComposerDraft(rootId, null);
      });
      expect(rafCallbacks).toHaveLength(1);

      await act(async () => {
        while (rafCallbacks.length > 0) {
          rafCallbacks.shift()?.(performance.now());
        }
      });
      rerender();

      expect(result.current.nodes[rootId].composerDraft).toBeUndefined();
    } finally {
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        writable: true,
        value: originalWindowRaf,
      });
      (globalThis as any).requestAnimationFrame = originalGlobalRaf;
    }
  });

  it('updates the absolute folder bound to an existing workspace', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });

    await act(async () => {
      await result.current.store.createProject('test', '/tmp/original');
    });
    await waitFor(() => expect(result.current.store.activeProject?.cwd).toBe('/tmp/original'));

    act(() => {
      result.current.store.setProjectCwd(result.current.store.activeProject!.id, '/tmp/relinked');
    });

    expect(result.current.store.activeProject?.cwd).toBe('/tmp/relinked');
  });
});
