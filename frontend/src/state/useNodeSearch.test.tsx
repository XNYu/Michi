import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { setActiveBackendConnectionId } from '../config/backendConnections';
import { readNodeSearchAnswer, useNodeSearch } from './useNodeSearch';

const api = vi.hoisted(() => ({ searchNodesGrouped: vi.fn() }));
vi.mock('../services/api', () => api);

const HIT = {
  nodeId: 'n1',
  nodeTitle: 'Schema naming',
  workspaceId: 'w1',
  workspaceName: 'agent-desk',
  treeId: 't1',
  lastMessageAt: 5,
  totalMatches: 2,
  breadcrumb: ['Root', 'Schema naming'],
  snippets: [{ messageId: 'm1', role: 'user', snippet: 'the <mark>schema</mark>' }],
};

beforeEach(() => {
  api.searchNodesGrouped.mockReset();
});

describe('readNodeSearchAnswer', () => {
  it('keeps a well-formed answer as it is', () => {
    expect(readNodeSearchAnswer({ results: [HIT], totalNodes: 1 })).toEqual({ results: [HIT], totalNodes: 1 });
  });

  it('reads anything without a results list as no results', () => {
    for (const raw of [undefined, null, 'oops', 42, [], {}, { results: 'x' }, { error: 'boom' }, { results: { n1: HIT } }]) {
      expect(readNodeSearchAnswer(raw)).toEqual({ results: [], totalNodes: 0 });
    }
  });

  it('drops hits it cannot show and fills what a hit left out', () => {
    const answer = readNodeSearchAnswer({
      results: [
        null,
        'n2',
        { nodeTitle: 'no id' },
        { nodeId: 'n3', workspaceId: 'w1' },
        { ...HIT, nodeId: 'n4', breadcrumb: ['ok', 7, null], snippets: [null, { snippet: 3 }, { role: 'assistant', snippet: 'kept' }] },
      ],
    });
    expect(answer.results.map((r) => r.nodeId)).toEqual(['n3', 'n4']);
    expect(answer.results[0]).toEqual({
      nodeId: 'n3', nodeTitle: null, workspaceId: 'w1', workspaceName: '', treeId: null,
      lastMessageAt: 0, totalMatches: 0, breadcrumb: [], snippets: [],
    });
    expect(answer.results[1].breadcrumb).toEqual(['ok']);
    expect(answer.results[1].snippets).toEqual([{ messageId: '', role: 'assistant', snippet: 'kept' }]);
    // Without a count, the hits kept are the count.
    expect(answer.totalNodes).toBe(2);
  });
});

describe('useNodeSearch', () => {
  it('shows no results, instead of crashing, when the answer has no results list', async () => {
    api.searchNodesGrouped.mockResolvedValue({ error: 'search index rebuilding' });
    const { result } = renderHook(() => useNodeSearch('schema'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toEqual({ nodes: [], totalNodes: 0, loading: false });
  });

  it('shows the hits of a well-formed answer', async () => {
    api.searchNodesGrouped.mockResolvedValue({ results: [HIT], totalNodes: 1 });
    const { result } = renderHook(() => useNodeSearch('schema'));
    await waitFor(() => expect(result.current.nodes).toHaveLength(1));
    expect(result.current.totalNodes).toBe(1);
    expect(api.searchNodesGrouped).toHaveBeenCalledWith('schema', undefined, 30, { connectionId: 'local', signal: expect.any(AbortSignal) });
  });
});

it('reissues the same query when the active Backend changes and aborts the old scope', async () => {
  let resolveOld!: (answer: unknown) => void;
  api.searchNodesGrouped.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
    .mockResolvedValueOnce({ results: [{ ...HIT, nodeId: 'remote-search-result' }], totalNodes: 1 });
  const view = renderHook(() => useNodeSearch('schema'));
  const oldSignal = api.searchNodesGrouped.mock.calls[0][3].signal as AbortSignal;
  await act(async () => setActiveBackendConnectionId('search-b'));
  expect(oldSignal.aborted).toBe(true);
  await waitFor(() => expect(view.result.current.nodes[0]?.nodeId).toBe('remote-search-result'));
  await act(async () => { resolveOld({ results: [HIT], totalNodes: 1 }); });
  expect(view.result.current.nodes[0]?.nodeId).toBe('remote-search-result');
  expect(api.searchNodesGrouped.mock.calls[1][3].connectionId).toBe('search-b');
  view.unmount();
  setActiveBackendConnectionId('local');
});
