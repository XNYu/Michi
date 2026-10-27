import { describe, it, expect, vi } from 'vitest';
import {
  deriveHeaderCounts,
  deriveTreeRows,
  deriveArchivedTreeRows,
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
});

describe('Meta agent maintenance runs and page helpers', () => {
  const project = mkProject({
    trees: [
      { id: 't-user', rootNodeId: 'u', createdAt: 0, lastActiveAt: 10 },
      { id: 't-run', rootNodeId: 'run', createdAt: 0, lastActiveAt: 50 },
      { id: 't-helper', rootNodeId: 'helper', createdAt: 0, lastActiveAt: 40 },
      { id: 't-old-run', rootNodeId: 'old-run', createdAt: 0, lastActiveAt: 60, archivedAt: 70 },
    ],
    chatIds: ['u', 'u-branch', 'run', 'run-branch', 'helper', 'old-run'],
    edges: [
      { source: 'u', target: 'u-branch', kind: 'branch' },
      { source: 'run', target: 'run-branch', kind: 'branch' },
    ],
  });
  const nodes: Record<string, ChatNodeState> = {
    u: mkNode({ nodeId: 'u', title: 'Mine' }),
    'u-branch': mkNode({ nodeId: 'u-branch', title: 'My branch' }),
    run: mkNode({ nodeId: 'run', title: 'Space maintenance', maintenanceJobId: 'job-1' }),
    'run-branch': mkNode({ nodeId: 'run-branch', title: 'Space maintenance branch', maintenanceJobId: 'job-1' }),
    helper: mkNode({ nodeId: 'helper', title: 'Page helper', pageId: 'pg-1' }),
    'old-run': mkNode({ nodeId: 'old-run', title: 'Archived run', maintenanceJobId: 'job-1' }),
  };

  it('are left out of the header counts', () => {
    expect(deriveHeaderCounts(project, nodes)).toMatchObject({ chats: 2, branches: 1, lastActiveAt: 10 });
  });

  it('are left out of the thread list and the archived list', () => {
    const rows = deriveTreeRows(project, nodes, '');
    expect(rows.filter((r) => r.kind !== 'label').map((r) => ('nodeId' in r ? r.nodeId : r.kind))).toEqual(['u', 'u-branch']);
    expect(deriveTreeRows(project, nodes, 'maintenance')).toEqual([]);
    expect(deriveArchivedTreeRows(project, nodes, '')).toEqual([]);
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
});
