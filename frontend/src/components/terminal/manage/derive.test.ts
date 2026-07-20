import { describe, it, expect, vi } from 'vitest';
import {
  deriveHeaderCounts,
  deriveTreeRows,
  deriveDigests,
  firstUserSnippet,
} from './derive';
import type { Project, ChatNodeState } from '../../../state/chatTypes';

function mkProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'p1',
    chatIds: [],
    edges: [],
    createdAt: 0,
    trees: [],
    activeTreeId: null,
    artifacts: [],
    ...overrides,
  };
}

function mkNode(overrides: Partial<ChatNodeState> & { nodeId: string }): ChatNodeState {
  return {
    projectId: 'p1',
    kind: 'chat',
    title: '',
    status: 'idle',
    messages: [],
    chatId: null,
    followUps: [],
    ...overrides,
  } as any as ChatNodeState;
}

describe('deriveHeaderCounts', () => {
  it('returns zeroed shape for empty project', () => {
    expect(deriveHeaderCounts(mkProject(), {})).toEqual({
      chats: 0,
      artifacts: 0,
      branches: 0,
      lastActiveAt: 0,
    });
  });

  it('counts non-deleted chats and excludes digests', () => {
    const project = mkProject({
      chatIds: ['a', 'b', 'c'],
    });
    const nodes: Record<string, ChatNodeState> = {
      a: mkNode({ nodeId: 'a' }),
      b: mkNode({ nodeId: 'b', kind: 'digest' }),
      c: mkNode({ nodeId: 'c', deletedAt: 1 }),
    };
    expect(deriveHeaderCounts(project, nodes).chats).toBe(1);
  });

  it('counts artifacts and branch edges', () => {
    const project = mkProject({
      artifacts: [
        { id: 'ctx1', name: 'a.md', filePath: 'a.md', source: 'user', createdAt: 0, updatedAt: 0 },
        { id: 'ctx2', name: 'b.md', filePath: 'b.md', source: 'user', createdAt: 0, updatedAt: 0 },
      ],
      edges: [
        { source: 'a', target: 'b', kind: 'branch' },
        { source: 'a', target: 'c', kind: 'merge' },
      ],
    });
    const r = deriveHeaderCounts(project, {});
    expect(r.artifacts).toBe(2);
    expect(r.branches).toBe(1);
  });

  it('lastActiveAt is the max across trees', () => {
    const project = mkProject({
      trees: [
        { id: 't1', rootNodeId: 'a', createdAt: 0, lastActiveAt: 100 },
        { id: 't2', rootNodeId: 'b', createdAt: 0, lastActiveAt: 200 },
      ],
    });
    expect(deriveHeaderCounts(project, {}).lastActiveAt).toBe(200);
  });
});

describe('deriveTreeRows', () => {
  it('returns empty for project with no trees', () => {
    expect(deriveTreeRows(mkProject(), {}, '')).toEqual([]);
  });

  it('emits label, root, and depth-1 branch rows', () => {
    const project = mkProject({
      trees: [{ id: 't1', rootNodeId: 'r', createdAt: 0, lastActiveAt: 100 }],
      chatIds: ['r', 'b1', 'b2'],
      edges: [
        { source: 'r', target: 'b1', kind: 'branch' },
        { source: 'r', target: 'b2', kind: 'branch' },
      ],
    });
    const nodes: Record<string, ChatNodeState> = {
      r: mkNode({ nodeId: 'r', title: 'root' }),
      b1: mkNode({ nodeId: 'b1', title: 'branch one' }),
      b2: mkNode({ nodeId: 'b2', title: 'branch two' }),
    };
    const rows = deriveTreeRows(project, nodes, '');
    expect(rows.map((r) => r.kind)).toEqual(['label', 'root', 'branch', 'branch']);
    expect(rows[2]).toMatchObject({ kind: 'branch', isLast: false });
    expect(rows[3]).toMatchObject({ kind: 'branch', isLast: true });
  });

  it('emits an overflow row when depth-2 branches exist and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const project = mkProject({
      trees: [{ id: 't1', rootNodeId: 'r', createdAt: 0, lastActiveAt: 0 }],
      chatIds: ['r', 'b1', 'g1'],
      edges: [
        { source: 'r', target: 'b1', kind: 'branch' },
        { source: 'b1', target: 'g1', kind: 'branch' },
      ],
    });
    const nodes: Record<string, ChatNodeState> = {
      r: mkNode({ nodeId: 'r' }),
      b1: mkNode({ nodeId: 'b1' }),
      g1: mkNode({ nodeId: 'g1' }),
    };
    const rows = deriveTreeRows(project, nodes, '');
    const overflow = rows.find((r) => r.kind === 'overflow');
    expect(overflow).toMatchObject({ kind: 'overflow', count: 1 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('hides trees that match neither root nor branch title', () => {
    const project = mkProject({
      trees: [
        { id: 't1', rootNodeId: 'r1', createdAt: 0, lastActiveAt: 0 },
        { id: 't2', rootNodeId: 'r2', createdAt: 0, lastActiveAt: 0 },
      ],
      chatIds: ['r1', 'r2'],
    });
    const nodes: Record<string, ChatNodeState> = {
      r1: mkNode({ nodeId: 'r1', title: 'apples' }),
      r2: mkNode({ nodeId: 'r2', title: 'bananas' }),
    };
    const rows = deriveTreeRows(project, nodes, 'app');
    const labels = rows.filter((r) => r.kind === 'label');
    expect(labels).toHaveLength(1);
  });

  it('emits pinned trees before unpinned and tags the root row', () => {
    const project = mkProject({
      chatIds: ['r1', 'r2'],
      trees: [
        { id: 't1', rootNodeId: 'r1', createdAt: 0, lastActiveAt: 200 },
        { id: 't2', rootNodeId: 'r2', createdAt: 1, lastActiveAt: 100, pinnedAt: 999 },
      ],
    });
    const nodes: Record<string, ChatNodeState> = {
      r1: mkNode({ nodeId: 'r1', title: 'unpinned' }),
      r2: mkNode({ nodeId: 'r2', title: 'pinned' }),
    };
    const rows = deriveTreeRows(project, nodes, '');
    const roots = rows.filter((r) => r.kind === 'root') as Extract<
      ReturnType<typeof deriveTreeRows>[number],
      { kind: 'root' }
    >[];
    expect(roots[0].treeId).toBe('t2');
    expect(roots[0].pinned).toBe(true);
    expect(roots[1].treeId).toBe('t1');
    expect(roots[1].pinned).toBe(false);
  });
});

describe('deriveDigests', () => {
  it('filters by project, kind, and not-deleted', () => {
    const project = mkProject({ chatIds: ['d1', 'd2', 'd3'] });
    const nodes: Record<string, ChatNodeState> = {
      d1: mkNode({ nodeId: 'd1', kind: 'digest', title: 'A', digest: { content: 'one two three', sourceCount: 2, generatedAt: 100 } as any }),
      d2: mkNode({ nodeId: 'd2', kind: 'chat', title: 'B' }),
      d3: mkNode({ nodeId: 'd3', kind: 'digest', deletedAt: 1, title: 'C' }),
    };
    const out = deriveDigests(project, nodes);
    expect(out).toHaveLength(1);
    expect(out[0].nodeId).toBe('d1');
    expect(out[0].excerpt.length).toBeGreaterThan(0);
  });
});

describe('firstUserSnippet', () => {
  it('returns first user message text trimmed and collapsed', () => {
    const node = mkNode({
      nodeId: 'x',
      messages: [
        { id: 'm1', role: 'user', text: '  Hello\n\n  world  ', toolCalls: [] } as any,
        { id: 'm2', role: 'assistant', text: 'reply', toolCalls: [] } as any,
      ],
    });
    expect(firstUserSnippet(node)).toBe('Hello world');
  });

  it('returns empty string when no user message exists', () => {
    expect(firstUserSnippet(mkNode({ nodeId: 'x', messages: [] }))).toBe('');
  });
});
