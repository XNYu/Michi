/**
 * The assistant's hidden workspace inside the real chat store: a thread
 * started while it is active lands in the user's workspace, and
 * notifications about its conversation respect the ⌘J panel.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  allocateNodeIdsLocal: (() => { let i = 0; return (count = 1) => Array.from({ length: count }, () => `n-aw-${++i}`); })(),
  listAgentModes: () => Promise.resolve({ availableModes: [], defaultModeId: null }),
  fetchAgentStatus: () => Promise.resolve(null),
  fetchPrefs: () => Promise.resolve(null),
  savePrefs: () => Promise.resolve(),
  warmCwd: () => Promise.resolve({ ok: true }),
  subscribeChat: vi.fn(() => () => {}),
  subscribeChats: vi.fn(() => () => {}),
  subscribeBackground: vi.fn(() => () => {}),
  cancelChatAndObserve: vi.fn(() => () => {}),
  fetchAllWorkspacesMeta: vi.fn(async () => []),
  fetchTreeMessages: vi.fn(async () => []),
  listBackendConnections: async () => [],
  ensureSession: vi.fn(() => Promise.resolve({ chatId: 'fake-chat', currentModeId: null, resumeStrategy: 'fresh' })),
  streamMessage: vi.fn(() => () => {}),
}));
vi.mock('../../services/notifications', () => ({ notify: vi.fn() }));

import * as api from '../../services/api';
import { streamMessage as actualStreamMessage } from '../../services/api/stream';
import { configureStreamTransport } from '../../services/api/streamTransport';
import { backendApiBase } from '../../config/backendConnections';
import { createBackgroundTurnBinding } from '../observeChatStream';
import { dispatchChatStreamEvent } from '../../services/chatStreamEvents';
import { encodeChatStreamEvent } from 'michi-shared';
import { notify } from '../../services/notifications';
import { ChatProvider, useChatActions, useChatNodesSnapshot, useChatStore } from '../chatStore';
import { PrefsProvider } from '../prefs';
import { getAssistantSnapshot, resetAssistantStoreForTests } from './assistantStore';
import { resetUserWorkspaceForTests } from './userWorkspace';
import { navigateToNode } from '../navigateToNode';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

const mockStream = api.streamMessage as unknown as ReturnType<typeof vi.fn>;
const mockNotify = notify as unknown as ReturnType<typeof vi.fn>;

const SYSTEM = {
  workspace: { id: 'sys', name: 'Assistant', created_at: 1, settings: JSON.stringify({ system: 'assistant' }) },
  trees: [{ id: 't-sys', root_node_id: 'n-sys', last_active_at: 1 }],
  nodes: [{ id: 'n-sys', created_at: 1 }],
  edges: [],
  messages: [],
};
const INFO = {
  nodeId: 'n-sys', workspaceId: 'sys', treeId: 't-sys',
  settings: { runtimeId: 'claude' as const, modelId: null, reasoning: null }, supportedRuntimes: ['claude' as const],
};

function useHarness() {
  return { store: useChatStore(), actions: useChatActions(), nodes: useChatNodesSnapshot() };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <PrefsProvider><ChatProvider>{children}</ChatProvider></PrefsProvider>;
}

async function mountWithAssistant() {
  const view = renderHook(() => useHarness(), { wrapper });
  await waitFor(() => expect(view.result.current.store.hydrated).toBe(true));
  let userId = '';
  await act(async () => { userId = await view.result.current.store.createProject('Work', '/work'); });
  let threadId = '';
  act(() => { threadId = view.result.current.store.createThread()!; });
  act(() => { view.result.current.actions.installWorkspaceSnapshot(SYSTEM); });
  await waitFor(() => expect(view.result.current.nodes['n-sys']).toBeTruthy());
  return { ...view, userId, threadId };
}

beforeEach(() => {
  localStorage.clear();
  mockNotify.mockReset();
  mockStream.mockClear();
  resetUserWorkspaceForTests();
  resetAssistantStoreForTests();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(window, 'focus').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => resetAssistantStoreForTests());
});

describe('the assistant workspace in the chat store', () => {
  it('starts a new thread in the user workspace while the assistant one is active', async () => {
    const { result, userId } = await mountWithAssistant();
    act(() => { result.current.store.selectProject('sys'); });
    await waitFor(() => expect(result.current.store.activeProject?.id).toBe('sys'));
    let nodeId: string | null = null;
    act(() => { nodeId = result.current.store.createThread(); });
    await waitFor(() => expect(result.current.store.activeProject?.id).toBe(userId));
    expect(result.current.nodes[nodeId!].projectId).toBe(userId);
    expect(result.current.store.projects.find((p) => p.id === 'sys')!.chatIds).toEqual(['n-sys']);
    expect(result.current.store.focusedPane).toBe(nodeId);
  });

  it('scopes a thread started from the assistant to the remote workspace it returns to', async () => {
    const { result } = renderHook(() => useHarness(), { wrapper });
    await waitFor(() => expect(result.current.store.hydrated).toBe(true));
    let remoteId = '';
    await act(async () => { remoteId = await result.current.store.createProject('Remote', '/srv/work', undefined, 'remote-x'); });
    expect(remoteId.startsWith('remote:remote-x:')).toBe(true);
    await waitFor(() => expect(result.current.store.activeProject?.id).toBe(remoteId));
    act(() => { result.current.actions.installWorkspaceSnapshot(SYSTEM); });
    await waitFor(() => expect(result.current.nodes['n-sys']).toBeTruthy());
    act(() => { result.current.store.selectProject('sys'); });
    await waitFor(() => expect(result.current.store.activeProject?.id).toBe('sys'));
    let nodeId: string | null = null;
    act(() => { nodeId = result.current.store.createThread(); });
    await waitFor(() => expect(result.current.store.activeProject?.id).toBe(remoteId));
    // Node and tree ids carry the remote connection, not the assistant's local scope.
    expect(nodeId!.startsWith('remote:remote-x:')).toBe(true);
    const remote = result.current.store.projects.find((p) => p.id === remoteId)!;
    expect(remote.chatIds).toContain(nodeId);
    expect(remote.trees.find((t) => t.rootNodeId === nodeId)!.id.startsWith('remote:remote-x:')).toBe(true);
  });

  it('keeps quiet about an ask the open panel shows, and reveals one in the panel', async () => {
    const { result, userId } = await mountWithAssistant();
    act(() => { resetAssistantStoreForTests({ open: true, status: 'ready', info: INFO }); });
    act(() => { result.current.store.sendMessage('n-sys', 'Archive the chat-only threads'); });
    await waitFor(() => expect(mockStream).toHaveBeenCalledTimes(1));
    mockNotify.mockClear();
    const handlers = mockStream.mock.calls[0][2] as { onUserInputRequest: (data: unknown) => void };
    const ask = (requestId: number) => act(() => {
      handlers.onUserInputRequest({ requestId, questions: [{ question: 'Send it to S7?', options: [], multiSelect: false }] });
    });

    ask(1);
    expect(mockNotify).not.toHaveBeenCalled();

    act(() => { resetAssistantStoreForTests({ open: false, status: 'ready', info: INFO }); });
    ask(2);
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Agent needs your input' }));
    act(() => { (mockNotify.mock.calls[0][0] as { onClick: () => void }).onClick(); });
    expect(getAssistantSnapshot().open).toBe(true);
    expect(result.current.store.activeProject?.id).toBe(userId);
  });

  it('flushes queued sends with every quote framed by its source, leaving the draft alone', async () => {
    const { result } = await mountWithAssistant();
    act(() => { result.current.store.sendMessage('n-sys', 'first'); });
    await waitFor(() => expect(mockStream).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.store.queueMessage('n-sys', {
        id: 'q1', value: 'Archive them', mentions: [], attachments: [], queuedAt: 1,
        quotedText: 'Attached block', quoteSource: { type: 'attached' },
      });
      result.current.store.queueMessage('n-sys', {
        id: 'q2', value: 'and this?', mentions: [], attachments: [], queuedAt: 2, quotedText: 'the third one',
      });
      result.current.store.setComposerDraft('n-sys', { value: 'still typing', mentions: [] });
    });
    const handlers = mockStream.mock.calls[0][2] as { onDone: () => void };
    act(() => { handlers.onDone(); });
    await waitFor(() => expect(mockStream).toHaveBeenCalledTimes(2));
    const wire = mockStream.mock.calls[1][1] as string;
    expect(wire).toContain('The user attached the material below in Michi');
    expect(wire).toContain('Attached context:\n> Attached block');
    expect(wire).toContain('previous assistant reply');
    expect(wire).toContain('Selected assistant passage:\n> the third one');
    expect(result.current.nodes['n-sys'].composerDraft?.value).toBe('still typing');
  });

  it('frames a retried quote by its recorded source, guessing only in the assistant workspace', async () => {
    const { result, threadId } = await mountWithAssistant();
    // Messages as read back after a reload: a quote, no recorded source.
    const stored = (nodeId: string) => act(() => {
      result.current.actions.dispatch({
        type: 'messages-loaded', nodeIds: [nodeId],
        messagesByNode: {
          [nodeId]: [{ id: `u-${nodeId}`, role: 'user', text: 'what now?', quotedText: 'On screen: Home', toolCalls: [], createdAt: 1 }],
        },
      });
    });
    stored('n-sys');
    stored(threadId);
    act(() => { result.current.store.retryLastTurn('n-sys'); });
    await waitFor(() => expect(mockStream).toHaveBeenCalledTimes(1));
    expect(mockStream.mock.calls[0][1] as string).toContain('The user attached the material below in Michi');
    act(() => { result.current.store.retryLastTurn(threadId); });
    await waitFor(() => expect(mockStream).toHaveBeenCalledTimes(2));
    expect(mockStream.mock.calls[1][1] as string).toContain('previous assistant reply');
  });

  it('checks an uncertain original turn without executing again, and preserves output on explicit rerun', async () => {
    const { result } = await mountWithAssistant();
    act(() => { result.current.store.sendMessage('n-sys', 'perform the side effect'); });
    await waitFor(() => expect(mockStream).toHaveBeenCalledTimes(1));
    const handlers = mockStream.mock.calls[0][2] as import('../../services/api').StreamHandlers;
    act(() => {
      handlers.onChunk?.('Side effect completed.');
      handlers.onErrorPayload?.({ message: 'commit failed', code: 'turn_persistence_failed', turnId: 'failed-original', recoverable: true });
    });
    const original = result.current.nodes['n-sys'].messages;
    expect(result.current.nodes['n-sys'].errorTurnId).toBe('failed-original');
    act(() => { result.current.store.retryLastTurn('n-sys'); });
    expect(mockStream).toHaveBeenCalledTimes(1);
    expect(result.current.nodes['n-sys'].messages).toEqual(original);
    expect(result.current.nodes['n-sys'].errorRecovery).toBe('checking');
    // Explicitly requesting a rerun cancels only the read subscription and
    // appends a new attempt; the original answer remains available.
    act(() => { result.current.store.rerunLastTurn('n-sys'); });
    await waitFor(() => expect(mockStream).toHaveBeenCalledTimes(2));
    expect(result.current.nodes['n-sys'].messages.slice(0, original.length)).toEqual(original);
    expect(mockStream.mock.calls[1][1]).toContain('perform the side effect');
  });

  it('keeps a real GET 410 turn_replay_unavailable outcome on the inspect path without a second POST', async () => {
    const { result } = await mountWithAssistant();
    // This exercises HTTP replay. The shared boot fixture advertises WebSocket
    // transport, whose ticket handshake is outside this isolated SSE fixture.
    configureStreamTransport(backendApiBase(), Promise.resolve(false));
    const enc = new TextEncoder();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(encodeChatStreamEvent({ event: 'turn_start', data: {
          turnId: 'original-410', assistantId: 'original-assistant', nodeId: 'n-sys', userText: 'side effect', seq: 0,
        } })));
        controller.enqueue(enc.encode(encodeChatStreamEvent({ event: 'chunk', data: {
          turnId: 'original-410', text: 'Side effect completed', seq: 1,
        } })));
        controller.close();
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/message')) return Promise.resolve(response);
      if (url.includes('/stream?')) return Promise.resolve(new Response(JSON.stringify({
        error: 'Original turn replay is unavailable', code: 'turn_replay_unavailable',
      }), { status: 410, headers: { 'Content-Type': 'application/json' } }));
      return Promise.resolve(new Response(JSON.stringify({ ready: true }), { headers: { 'Content-Type': 'application/json' } }));
    });
    act(() => { result.current.store.sendMessage('n-sys', 'side effect'); });
    await waitFor(() => expect(mockStream).toHaveBeenCalledTimes(1));
    vi.stubGlobal('fetch', fetchMock);
    try {
      act(() => { actualStreamMessage('n-sys', 'side effect', mockStream.mock.calls[0][2], { turnId: 'original-410' }); });
      await waitFor(() => expect(result.current.nodes['n-sys'].errorKind).toBe('turn_replay_unavailable'));
      expect(result.current.nodes['n-sys'].errorTurnId).toBe('original-410');
      const streamCalls = fetchMock.mock.calls.filter(([url]) => url.includes('/message') || url.includes('/stream?'));
      expect(streamCalls).toHaveLength(2);
      expect(streamCalls[1][0]).toContain('fromTurnId=original-410');
      const original = result.current.nodes['n-sys'].messages;
      act(() => { result.current.store.retryLastTurn('n-sys'); });
      expect(result.current.nodes['n-sys'].errorRecovery).toBe('checking');
      expect(result.current.nodes['n-sys'].messages).toEqual(original);
      expect(mockStream).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls.filter(([url]) => url.includes('/message'))).toHaveLength(1);
      expect(vi.mocked(api.subscribeChat)).toHaveBeenLastCalledWith(
        'n-sys', expect.any(Object), { turnId: 'original-410', seq: 0 }, expect.any(Object),
      );
    } finally { vi.unstubAllGlobals(); }
  });

  it('keeps a hydrated error unknown: default retry does not post and explicit rerun preserves its messages', async () => {
    const { result } = await mountWithAssistant();
    act(() => { result.current.actions.installWorkspaceSnapshot({
      ...SYSTEM,
      workspace: { ...SYSTEM.workspace, id: 'sys-hydrated' },
      trees: [{ id: 'tree-hydrated', root_node_id: 'n-hydrated', last_active_at: 1 }],
      nodes: [{ id: 'n-hydrated', created_at: 1, status: 'error', last_applied_turn_id: 'older-success' }],
      messages: [
        { id: 'original-user', node_id: 'n-hydrated', role: 'user', content: 'perform side effect', seq: 0 },
        { id: 'original-assistant', node_id: 'n-hydrated', role: 'assistant', content: 'Already produced', seq: 1 },
      ],
    }); });
    expect(result.current.nodes['n-hydrated'].errorKind).toBe('turn_outcome_unknown');
    expect(result.current.nodes['n-hydrated'].errorTurnId).toBeUndefined();
    const original = result.current.nodes['n-hydrated'].messages;
    const subscriptions = vi.mocked(api.subscribeChat).mock.calls.length;
    act(() => { result.current.store.retryLastTurn('n-hydrated'); });
    expect(mockStream).not.toHaveBeenCalled();
    expect(vi.mocked(api.subscribeChat).mock.calls.length).toBe(subscriptions);
    expect(result.current.nodes['n-hydrated'].errorRecovery).toBe('unavailable');
    expect(result.current.nodes['n-hydrated'].messages).toEqual(original);
    act(() => { result.current.store.rerunLastTurn('n-hydrated'); });
    await waitFor(() => expect(mockStream).toHaveBeenCalledTimes(1));
    expect(result.current.nodes['n-hydrated'].messages.slice(0, original.length)).toEqual(original);
  });

  it('does not guess an original identity or resend when it is unavailable', async () => {
    const { result } = await mountWithAssistant();
    act(() => { result.current.actions.dispatch({ type: 'apply-seq', nodeId: 'n-sys', turnId: 'older-success', seq: 8 }); });
    act(() => { result.current.store.sendMessage('n-sys', 'perform side effect'); });
    await waitFor(() => expect(mockStream).toHaveBeenCalledTimes(1));
    const handlers = mockStream.mock.calls[0][2] as import('../../services/api').StreamHandlers;
    act(() => { handlers.onErrorPayload?.({ message: 'commit failed', code: 'turn_persistence_failed' }); });
    expect(result.current.nodes['n-sys'].lastAppliedTurnId).toBe('older-success');
    expect(result.current.nodes['n-sys'].errorTurnId).toBeUndefined();
    const reads = vi.mocked(api.subscribeChat).mock.calls.length;
    act(() => { result.current.store.retryLastTurn('n-sys'); });
    expect(result.current.nodes['n-sys'].errorRecovery).toBe('unavailable');
    expect(vi.mocked(api.subscribeChat).mock.calls.length).toBe(reads);
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'Part'])('restores the complete original result without duplicating partial output (%s)', async (partial) => {
    const { result } = await mountWithAssistant();
    act(() => { result.current.store.sendMessage('n-sys', 'perform side effect'); });
    await waitFor(() => expect(mockStream).toHaveBeenCalledTimes(1));
    const handlers = mockStream.mock.calls[0][2] as import('../../services/api').StreamHandlers;
    act(() => {
      if (partial) handlers.onChunk?.(partial);
      handlers.onErrorPayload?.({ message: 'lost response', code: 'turn_outcome_unknown', turnId: 'original' });
      result.current.store.retryLastTurn('n-sys');
    });
    const calls = vi.mocked(api.subscribeChat).mock.calls;
    const [, replayHandlers, , opts] = calls[calls.length - 1];
    act(() => {
      opts?.onEvent?.({ event: 'turn_start', data: { turnId: 'original', nodeId: 'n-sys', assistantId: 'canonical', userText: 'perform side effect', seq: 0 } });
      opts?.onEvent?.({ event: 'chunk', data: { turnId: 'original', text: 'Partial and complete result', seq: 1 } });
      opts?.onEvent?.({ event: 'done', data: { turnId: 'original', stopReason: 'end_turn', persisted: true, seq: 2 } });
      replayHandlers.onDone?.('end_turn', 'canonical', 'original', true);
    });
    expect(mockStream).toHaveBeenCalledTimes(1);
    expect(result.current.nodes['n-sys'].status).toBe('idle');
    const answer = result.current.nodes['n-sys'].messages.find((m) => m.id === 'canonical')!;
    expect(answer.blocks?.filter((b) => b.kind === 'answer').map((b) => b.kind === 'answer' ? b.rawText : '').join('')).toBe('Partial and complete result');
    expect(result.current.nodes['n-sys'].lastAppliedTurnId).toBe('original');
    expect(result.current.nodes['n-sys'].lastAppliedSeq).toBe(2);
    const lateReplay = createBackgroundTurnBinding({
      chatId: 'n-sys', nodeId: 'n-sys', cursor: 'foreground',
      dispatch: (action) => result.current.actions.dispatch(action),
      lastTurnRef: { get current() { return result.current.nodes['n-sys'].lastAppliedTurnId ?? ''; }, set current(_value: string) {} },
      lastSeqRef: { get current() { return result.current.nodes['n-sys'].lastAppliedSeq ?? -1; }, set current(_value: number) {} },
    }).createHandlers();
    act(() => { dispatchChatStreamEvent({ event: 'chunk', data: { turnId: 'original', assistantId: 'canonical', seq: 1, text: 'Partial and complete result' } }, lateReplay); });
    expect(result.current.nodes['n-sys'].messages.find((m) => m.id === 'canonical')).toEqual(answer);

  });

  it.each([false, true])('closing the assistant\'s pane goes back to the user workspace (single-page mode: %s)', async (singlePageMode) => {
    // Single-page mode swaps chats within a slot; the assistant's hidden
    // workspace has its own slot, so the user's open chat waits there.
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ singlePageMode }));
    const { result, userId, threadId } = await mountWithAssistant();
    act(() => {
      const store = result.current.store;
      navigateToNode({
        projects: store.projects, activeProjectId: store.activeProjectId,
        selectProject: store.selectProject, openPane: store.openPane, openPaneInTree: store.openPaneInTree,
        activateTree: store.activateTree, setFocusedNodeId: store.setFocusedNodeId,
      }, 'n-sys', 'sys');
    });
    await waitFor(() => expect(result.current.store.activeProject?.id).toBe('sys'));
    expect(result.current.store.openPanes).toEqual(['n-sys']);

    act(() => { result.current.store.closePane('n-sys'); });
    await waitFor(() => expect(result.current.store.activeProject?.id).toBe(userId));
    expect(result.current.store.openPanes).toEqual([threadId]);
  });

  it('does not toast a finished answer the open panel shows', async () => {
    const { result } = await mountWithAssistant();
    act(() => { resetAssistantStoreForTests({ open: true, status: 'ready', info: INFO }); });
    act(() => { result.current.store.sendMessage('n-sys', 'What is stalled?'); });
    await waitFor(() => expect(mockStream).toHaveBeenCalledTimes(1));
    mockNotify.mockClear();
    const handlers = mockStream.mock.calls[0][2] as { onDone: () => void };
    act(() => { handlers.onDone(); });
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
