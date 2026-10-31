import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAction, ChatNodeState, Project } from './chatTypes';
import { reduceNodes } from './chatReducers';
import { visibleMessageText } from './assistantBlocks';
import { markBackendConnectionReady, markBackendConnectionUnavailable } from '../config/backendConnectionState';

const api = vi.hoisted(() => ({ fetchTreeMessages: vi.fn(), fetchTreeMessagePage: vi.fn() }));
vi.mock('../services/api/persistence', () => api);
import { useMessageHistory } from './useMessageHistory';

const project: Project = { id: 'ws', name: 'Remote', chatIds: ['n'], createdAt: 1, artifacts: [], edges: [],
  trees: [{ id: 'tree', rootNodeId: 'n', createdAt: 1, lastActiveAt: 1 }], activeTreeId: 'tree', backendConnectionId: 'remote-1' };
const row = (seq: number, content = `text ${seq}`) => ({ id: `m${seq}`, node_id: 'n', seq, role: 'assistant', content, created_at: 1 });
function fixture() {
  const nodesRef = { current: { n: { nodeId: 'n', projectId: 'ws', kind: 'chat', chatId: 'n',
    messages: [{ id: 'm50', role: 'assistant', text: 'live', toolCalls: [], createdAt: 1 }],
    messagesLoaded: false, historyBefore: { id: 'm50', seq: 50 }, messageCount: 51,
    followUps: [], status: 'idle', lastAppliedTurnId: 'turn', lastAppliedSeq: 8,
  } } as Record<string, ChatNodeState> };
  const projectsRef = { current: [project] };
  const dispatch = vi.fn((action: ChatAction) => { nodesRef.current = reduceNodes(nodesRef.current, action); });
  return { nodesRef, projectsRef, dispatch };
}

describe('paged history transitions', () => {
  beforeEach(() => { api.fetchTreeMessages.mockReset(); api.fetchTreeMessagePage.mockReset(); });

  it('shares concurrent older reads and keeps live chunks received during the request', async () => {
    const f = fixture();
    let resolve!: (value: unknown) => void;
    api.fetchTreeMessagePage.mockReturnValue(new Promise(done => { resolve = done; }));
    const { result } = renderHook(() => useMessageHistory(f.nodesRef, f.projectsRef, f.dispatch));
    const first = result.current.loadOlderMessages('n');
    const second = result.current.loadOlderMessages('n');
    f.nodesRef.current.n = { ...f.nodesRef.current.n, messages: [{ ...f.nodesRef.current.n.messages[0], text: 'advanced' }], lastAppliedSeq: 9 };
    await act(async () => { resolve({ messages: [row(49), row(50, 'stale')], pages: [{ nodeId: 'n', total: 51, before: { seq: 49, id: 'm49' } }] }); await Promise.all([first, second]); });
    expect(api.fetchTreeMessagePage).toHaveBeenCalledTimes(1);
    expect(f.nodesRef.current.n.messages.map(visibleMessageText)).toEqual(['text 49', 'advanced']);
    expect(f.nodesRef.current.n.lastAppliedSeq).toBe(9);
  });

  it('fills older context before a full-history consumer and preserves its newer tail', async () => {
    const f = fixture();
    api.fetchTreeMessages.mockResolvedValue([row(0), row(49), row(50, 'stale')]);
    const { result } = renderHook(() => useMessageHistory(f.nodesRef, f.projectsRef, f.dispatch));
    const complete = await result.current.ensureCompleteHistory(['n']);
    expect(complete.n.messages.map(visibleMessageText)).toEqual(['text 0', 'text 49', 'live']);
    expect(complete.n.messagesLoaded).toBe(true);
    expect(complete.n.historyBefore).toBeUndefined();
    expect(api.fetchTreeMessages).toHaveBeenCalledWith('ws', 'tree', 'remote-1', expect.any(AbortSignal));
  });

  it('a failed read never installs an empty history and unmount cancels in-flight reads', async () => {
    const f = fixture();
    api.fetchTreeMessagePage.mockRejectedValueOnce(new TypeError('offline'));
    const { result, unmount } = renderHook(() => useMessageHistory(f.nodesRef, f.projectsRef, f.dispatch));
    await expect(result.current.loadOlderMessages('n')).rejects.toThrow('offline');
    expect(f.dispatch).not.toHaveBeenCalled();
    api.fetchTreeMessagePage.mockImplementation((_ws, _tree, _connection, signal: AbortSignal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const pending = result.current.loadOlderMessages('n');
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    unmount(); await cancelled;
    expect(f.nodesRef.current.n.messages[0].text).toBe('live');
  });

  it('drops an older page when the saved connection changes, even with identical message IDs', async () => {
    const f = fixture();
    markBackendConnectionReady('remote-1');
    let resolve!: (value: unknown) => void;
    api.fetchTreeMessagePage.mockReturnValue(new Promise(done => { resolve = done; }));
    const { result } = renderHook(() => useMessageHistory(f.nodesRef, f.projectsRef, f.dispatch));
    const pending = result.current.loadOlderMessages('n');
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    markBackendConnectionUnavailable('remote-1', true);
    await act(async () => { resolve({ messages: [row(49)], pages: [{ nodeId: 'n', total: 51, before: null }] }); await rejected; });
    expect(f.dispatch).not.toHaveBeenCalled();
    markBackendConnectionReady('remote-1');
  });
});
