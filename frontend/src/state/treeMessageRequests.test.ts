import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatNodeState, Project } from './chatTypes';
const api = vi.hoisted(() => ({ fetchTreeMessages: vi.fn() }));
vi.mock('../services/api', () => api);
import { TREE_PREFETCH_CONCURRENCY, TREE_PREFETCH_LIMIT, TREE_PREFETCH_TTL_MS, TreeMessageRequests } from './treeMessageRequests';

const projects: Project[] = Array.from({ length: 8 }, (_, i) => ({
  id: `ws-${i}`, name: 'Workspace', chatIds: [`n${i}`], edges: [], artifacts: [], createdAt: 1,
  trees: [{ id: `t${i}`, rootNodeId: `n${i}`, createdAt: 1, lastActiveAt: 1 }], activeTreeId: `t${i}`,
}));
function makeNodes(): Record<string, ChatNodeState> {
  return Object.fromEntries(projects.map((p, i) => [`n${i}`, {
    nodeId: `n${i}`, projectId: p.id, kind: 'chat', chatId: null, messages: [], messagesLoaded: false,
    messageCount: 1, followUps: [], status: 'idle',
  }]));
}

describe('provider-scoped tree reads', () => {
  let requests: TreeMessageRequests;
  let nodes: Record<string, ChatNodeState>;
  beforeEach(() => {
    vi.useFakeTimers();
    api.fetchTreeMessages.mockReset().mockResolvedValue([]);
    requests = new TreeMessageRequests();
    nodes = makeNodes();
  });
  afterEach(() => { requests.clear(); vi.useRealTimers(); });
  const signal = () => new AbortController().signal;

  it('caps speculative concurrency but never blocks a foreground read', async () => {
    api.fetchTreeMessages.mockImplementation(() => new Promise(() => {}));
    projects.forEach((p, i) => requests.prefetch(p, `t${i}`, nodes));
    expect(api.fetchTreeMessages).toHaveBeenCalledTimes(TREE_PREFETCH_CONCURRENCY);
    requests.acquire(projects[7], 't7', nodes, signal());
    expect(api.fetchTreeMessages).toHaveBeenCalledTimes(TREE_PREFETCH_CONCURRENCY + 1);
  });

  it('evicts old speculative entries at the cache limit', async () => {
    for (let i = 0; i <= TREE_PREFETCH_LIMIT; i++) {
      requests.prefetch(projects[i], `t${i}`, nodes);
      await Promise.resolve();
    }
    requests.acquire(projects[0], 't0', nodes, signal());
    expect(api.fetchTreeMessages).toHaveBeenCalledTimes(TREE_PREFETCH_LIMIT + 2);
  });

  it('expires speculative results and invalidates changed message state', async () => {
    requests.prefetch(projects[0], 't0', nodes);
    await vi.advanceTimersByTimeAsync(TREE_PREFETCH_TTL_MS + 1);
    requests.prefetch(projects[0], 't0', nodes);
    await Promise.resolve();
    nodes.n0 = { ...nodes.n0, lastAppliedBackgroundSeq: 9 };
    requests.acquire(projects[0], 't0', nodes, signal());
    expect(api.fetchTreeMessages).toHaveBeenCalledTimes(3);
  });

  it('skips loaded, deleted, unknown and streaming speculative targets', () => {
    nodes.n0 = { ...nodes.n0, messagesLoaded: true };
    nodes.n1 = { ...nodes.n1, deletedAt: 1 };
    nodes.n2 = { ...nodes.n2, status: 'streaming' };
    requests.prefetch(projects[0], 't0', nodes);
    requests.prefetch(projects[1], 't1', nodes);
    requests.prefetch(projects[2], 't2', nodes);
    requests.prefetch(projects[3], 'missing', nodes);
    expect(api.fetchTreeMessages).not.toHaveBeenCalled();
    requests.acquire(projects[2], 't2', nodes, signal());
    expect(api.fetchTreeMessages).toHaveBeenCalledTimes(1);
  });
});
