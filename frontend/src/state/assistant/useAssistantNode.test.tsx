import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssistantNode } from './useAssistantNode';
import type { AssistantInfo } from '../../services/api/assistant';

const mocks = vi.hoisted(() => ({
  workspace: vi.fn(), messages: vi.fn(), install: vi.fn(), dispatch: vi.fn(),
  node: undefined as { nodeId: string; projectId: string; messagesLoaded: boolean; messages: unknown[] } | undefined,
}));
vi.mock('../../services/api/persistence', () => ({ fetchWorkspace: mocks.workspace, fetchTreeMessages: mocks.messages }));
vi.mock('../chatStore', () => ({
  useChatNode: () => mocks.node,
  useChatProjects: () => ({ projects: [] }),
  useChatActions: () => ({ installWorkspaceSnapshot: mocks.install, dispatch: mocks.dispatch }),
}));
const info: AssistantInfo = {
  workspaceId: 'sys', nodeId: 'n1', treeId: 't1',
  settings: { runtimeId: 'kiro', modelId: null, reasoning: null }, supportedRuntimes: ['kiro'],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.node = undefined;
  mocks.workspace.mockImplementation(() => new Promise(() => {}));
  mocks.messages.mockImplementation(() => new Promise(() => {}));
});

describe('assistant loading during unrelated renders', () => {
  it('keeps a pending workspace read alive and cancels it when the conversation changes', () => {
    const view = renderHook(({ current }) => useAssistantNode(current), { initialProps: { current: info } });
    const signal = mocks.workspace.mock.calls[0][1] as AbortSignal;
    view.rerender({ current: { ...info } });
    view.rerender({ current: { ...info, settings: { ...info.settings, modelId: 'another-model' } } });
    expect(mocks.workspace).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
    view.rerender({ current: { ...info, nodeId: 'n2', treeId: 't2' } });
    expect(signal.aborted).toBe(true);
    expect(mocks.workspace).toHaveBeenCalledTimes(2);
  });

  it('lets a slow history read finish across renders', async () => {
    mocks.node = { nodeId: 'n1', projectId: 'sys', messagesLoaded: false, messages: [] };
    let finish!: (rows: unknown[]) => void;
    mocks.messages.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = renderHook(({ current }) => useAssistantNode(current), { initialProps: { current: info } });
    const signal = mocks.messages.mock.calls[0][3] as AbortSignal;
    view.rerender({ current: { ...info } });
    view.rerender({ current: { ...info } });
    expect(mocks.messages).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
    await act(async () => finish([]));
    await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'messages-loaded', nodeIds: ['n1'], messagesByNode: { n1: [] } }));
  });

  it('still retries a failed read explicitly', async () => {
    mocks.workspace.mockRejectedValueOnce(new Error('offline'));
    const view = renderHook(() => useAssistantNode(info));
    await waitFor(() => expect(view.result.current.state).toBe('failed'));
    act(() => view.result.current.retry());
    expect(mocks.workspace).toHaveBeenCalledTimes(2);
    expect(view.result.current.state).toBe('loading');
  });
});
