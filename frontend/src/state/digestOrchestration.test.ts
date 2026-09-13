import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDigestOrchestration } from './digestOrchestration';
import { reduceNodes } from './chatReducers';
import type { ChatAction, ChatNodeState, Project } from './chatTypes';
import type { StreamCallbacks } from '../services/digestApi';

const streamDigest = vi.hoisted(() => vi.fn());
vi.mock('../services/digestApi', () => ({ streamDigest }));

function setup() {
  const project: Project = {
    id: 'p1', name: 'Test', chatIds: ['s1', 'd1'], edges: [],
    trees: [{ id: 't1', rootNodeId: 's1', createdAt: 1, lastActiveAt: 1 }],
    activeTreeId: 't1', artifacts: [], createdAt: 1,
  };
  const nodesRef = { current: {
    s1: { nodeId: 's1', kind: 'chat', chatId: null, projectId: 'p1', status: 'idle', followUps: [], messages: [] },
    d1: {
      nodeId: 'd1', kind: 'digest', chatId: null, projectId: 'p1', status: 'idle', followUps: [], messages: [],
      digest: { sources: ['s1'], content: '# Previous result', customPrompt: 'Original prompt', status: 'idle', sourceFingerprints: {}, generatedAt: 1, viewedAt: 1 },
    },
  } as Record<string, ChatNodeState> };
  const dispatch = vi.fn((action: ChatAction) => { nodesRef.current = reduceNodes(nodesRef.current, action); });
  const hook = renderHook(() => useDigestOrchestration({
    projects: [project], nodesRef, dispatch, setProjects: vi.fn(), setNodes: vi.fn(), sameTree: () => true, newNodeId: () => 'new-digest',
  }));
  return { ...hook, nodesRef, dispatch };
}

beforeEach(() => { streamDigest.mockReset(); });

describe('digest orchestration', () => {
  it('snapshots the previous result and prompt, streams thoughts, and preserves edits for the next rebuild', async () => {
    let callbacks!: StreamCallbacks;
    let finish!: (text: string) => void;
    streamDigest.mockImplementation((_payload, cb) => {
      callbacks = cb;
      return new Promise<string>((resolve) => { finish = resolve; });
    });
    const { result, nodesRef } = setup();
    let request!: Promise<void>;
    act(() => { request = result.current.refreshDigest('d1'); });
    await waitFor(() => expect(streamDigest).toHaveBeenCalledOnce());
    expect(streamDigest.mock.calls[0][0]).toMatchObject({ previousContent: '# Previous result', customPrompt: 'Original prompt' });
    act(() => {
      callbacks.onStatus?.('Reading sources');
      callbacks.onThought?.('Comparing notes');
      callbacks.onChunk('# Partial');
      result.current.setDigestPrompt('d1', 'New prompt');
    });
    expect(nodesRef.current.d1.digest?.generation?.thought).toBe('Comparing notes');
    await act(async () => { finish('# Final'); await request; });
    expect(nodesRef.current.d1.digest).toMatchObject({ content: '# Final', status: 'idle', customPrompt: 'New prompt' });
    expect(nodesRef.current.d1.digest?.generation).toBeUndefined();

    streamDigest.mockResolvedValueOnce('# Updated');
    await act(async () => { await result.current.refreshDigest('d1'); });
    expect(streamDigest.mock.calls[1][0]).toMatchObject({ previousContent: '# Final', customPrompt: 'New prompt' });
  });

  it('does not let a superseded stream overwrite a new generation', async () => {
    const pending: Array<{ callbacks: StreamCallbacks; finish: (text: string) => void }> = [];
    streamDigest.mockImplementation((_payload, callbacks) => new Promise<string>(finish => pending.push({ callbacks, finish })));
    const { result, nodesRef } = setup();
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => { first = result.current.refreshDigest('d1'); });
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => { second = result.current.refreshDigest('d1'); });
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0].callbacks.signal?.aborted).toBe(true);
    act(() => {
      pending[0].callbacks.onThought?.('Stale thoughts');
      pending[0].callbacks.onStatus?.('Stale status');
      pending[1].callbacks.onThought?.('New thoughts');
    });
    expect(nodesRef.current.d1.digest?.generation?.thought).toBe('New thoughts');
    await act(async () => { pending[0].finish('# Old result'); await first; });
    expect(nodesRef.current.d1.digest?.status).toBe('streaming');
    await act(async () => { pending[1].finish('# New result'); await second; });
    expect(nodesRef.current.d1.digest?.content).toBe('# New result');
  });
});
