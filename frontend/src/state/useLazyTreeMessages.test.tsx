import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MutableRefObject } from 'react';
import type { ChatAction, ChatNodeState, Project } from './chatTypes';

const apiMocks = vi.hoisted(() => ({
  fetchTreeMessages: vi.fn(),
}));

vi.mock('../services/api', () => ({
  fetchTreeMessages: apiMocks.fetchTreeMessages,
}));

import { useLazyTreeMessages } from './useLazyTreeMessages';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function project(lastActiveAt: number): Project {
  return {
    id: 'ws-1', name: 'Workspace', chatIds: ['n1'], edges: [], artifacts: [], createdAt: 1,
    trees: [{ id: 'tree-1', rootNodeId: 'n1', createdAt: 1, lastActiveAt }],
    activeTreeId: 'tree-1',
  };
}

function node(overrides: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId: 'n1', projectId: 'ws-1', kind: 'chat', chatId: 'chat-1',
    messages: [], messagesLoaded: false, messageCount: 2,
    followUps: [], status: 'idle', ...overrides,
  };
}

describe('useLazyTreeMessages live-turn races', () => {
  it('does not install an old snapshot over a live turn and retries after cancellation', async () => {
    const first = deferred<unknown[]>();
    const second = deferred<unknown[]>();
    apiMocks.fetchTreeMessages.mockReset();
    apiMocks.fetchTreeMessages
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const nodesRef = { current: { n1: node() } } as MutableRefObject<Record<string, ChatNodeState>>;
    const dispatch = vi.fn<(action: ChatAction) => void>();

    const { rerender } = renderHook(
      ({ activeProject }: { activeProject: Project }) => useLazyTreeMessages({
        hydrated: true,
        activeProjectId: activeProject.id,
        projects: [activeProject],
        nodesRef,
        dispatch,
      }),
      { initialProps: { activeProject: project(1) } },
    );
    await vi.waitFor(() => expect(apiMocks.fetchTreeMessages).toHaveBeenCalledTimes(1));

    // A real live foreground turn carries its user + assistant messages (from
    // user-send), so it must be protected from a stale snapshot. An empty
    // streaming node, by contrast, is a reconnect target that SHOULD load.
    nodesRef.current = { n1: node({ status: 'streaming', messages: [
      { id: 'live', role: 'assistant', text: 'live', toolCalls: [], createdAt: 1 },
    ] }) };
    rerender({ activeProject: project(2) });
    first.resolve([{ id: 'old', node_id: 'n1', role: 'assistant', content: 'stale', seq: 0, created_at: 1 }]);
    await first.promise;
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();

    nodesRef.current = { n1: node({ status: 'idle' }) };
    rerender({ activeProject: project(3) });
    await vi.waitFor(() => expect(apiMocks.fetchTreeMessages).toHaveBeenCalledTimes(2));
    second.resolve([{ id: 'fresh', node_id: 'n1', role: 'assistant', content: 'fresh', seq: 0, created_at: 2 }]);
    await second.promise;
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'messages-loaded', nodeIds: ['n1'],
    })));
  });

  it('loads the checkpoint body for a streaming placeholder reconnect target and asks to reattach', async () => {
    // A node hydrated as `streaming` with EMPTY messages is not a live turn —
    // it's a reconnect target the backend marked streaming at turn-start. Its
    // checkpoint body must load so the pane shows progress and recover() can
    // reattach the SSE. (The prior behavior skipped all streaming nodes, so a
    // non-active-tree streaming node stayed a skeleton forever.)
    apiMocks.fetchTreeMessages.mockReset();
    apiMocks.fetchTreeMessages.mockResolvedValue([
      { id: 'u', node_id: 'n1', role: 'user', content: 'q', seq: 0, created_at: 1 },
      { id: 'a', node_id: 'n1', role: 'assistant', content: 'partial', seq: 1, created_at: 2 },
    ]);
    const nodesRef = {
      current: { n1: node({ status: 'streaming', messages: [] }) },
    } as MutableRefObject<Record<string, ChatNodeState>>;
    const dispatch = vi.fn<(action: ChatAction) => void>();
    const reconnectStreamingRef = { current: vi.fn<(nodeId: string) => void>() };

    renderHook(() => useLazyTreeMessages({
      hydrated: true,
      activeProjectId: 'ws-1',
      projects: [project(1)],
      nodesRef,
      dispatch,
      reconnectStreamingRef,
    }));

    await vi.waitFor(() => expect(apiMocks.fetchTreeMessages).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'messages-loaded', nodeIds: ['n1'],
    })));
    await vi.waitFor(() => expect(reconnectStreamingRef.current).toHaveBeenCalledWith('n1'));
  });
});
