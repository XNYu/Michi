import { describe, it, expect } from 'vitest';
import {
  isWorkspaceExpanded,
  isThreadExpanded,
  isBranchExpanded,
  sortTrees,
  sortLiveProjects,
  mergeReferences,
  selectProjectNodeStatuses,
} from './sidebarSelectors';
import type { Tree, Project, ChatNodeState } from './chatTypes';

const empty = { workspaces: {}, threads: {}, branches: {} };

describe('isWorkspaceExpanded', () => {
  it('defaults the active workspace to expanded', () => {
    expect(isWorkspaceExpanded(empty, 'p1', 'p1')).toBe(true);
  });

  it('defaults non-active workspaces to collapsed', () => {
    expect(isWorkspaceExpanded(empty, 'p2', 'p1')).toBe(false);
  });

  it('respects explicit user toggles over defaults', () => {
    expect(
      isWorkspaceExpanded({ ...empty, workspaces: { p1: false } }, 'p1', 'p1'),
    ).toBe(false);
    expect(
      isWorkspaceExpanded({ ...empty, workspaces: { p2: true } }, 'p2', 'p1'),
    ).toBe(true);
  });
});

describe('selectProjectNodeStatuses', () => {
  it('collects only non-idle statuses from the requested workspace', () => {
    const nodes = {
      a: { nodeId: 'a', status: 'streaming' },
      b: { nodeId: 'b', status: 'idle' },
      foreign: { nodeId: 'foreign', status: 'error' },
    } satisfies Record<string, Pick<ChatNodeState, 'nodeId' | 'status'>>;

    expect(selectProjectNodeStatuses(['a', 'b', 'missing'], nodes)).toEqual({
      a: 'streaming',
    });
  });
});

describe('isThreadExpanded', () => {
  it('defaults the active thread to expanded', () => {
    expect(isThreadExpanded(empty, 't1', 't1')).toBe(true);
  });

  it('defaults inactive threads to collapsed', () => {
    expect(isThreadExpanded(empty, 't2', 't1')).toBe(false);
  });

  it('respects explicit toggles for inactive threads', () => {
    expect(
      isThreadExpanded({ ...empty, threads: { t2: true } }, 't2', 't1'),
    ).toBe(true);
  });

  it('lets users collapse the active thread', () => {
    expect(
      isThreadExpanded({ ...empty, threads: { t1: false } }, 't1', 't1'),
    ).toBe(false);
  });
});

describe('isBranchExpanded', () => {
  it('defaults to collapsed', () => {
    expect(isBranchExpanded(empty, 'n1')).toBe(false);
  });

  it('respects an explicit branch toggle', () => {
    expect(
      isBranchExpanded({ ...empty, branches: { n1: true } }, 'n1'),
    ).toBe(true);
  });
});

const proj = (
  id: string,
  createdAt: number,
  opts: { deletedAt?: number; archivedAt?: number } = {},
): Project => ({
  id,
  name: id,
  chatIds: [],
  edges: [],
  createdAt,
  trees: [],
  activeTreeId: null,
  contexts: [],
  deletedAt: opts.deletedAt,
  archivedAt: opts.archivedAt,
});

describe('sortLiveProjects', () => {
  it('with empty order, sorts by createdAt DESC', () => {
    const ps = [proj('a', 1), proj('b', 3), proj('c', 2)];
    expect(sortLiveProjects(ps, []).map((p) => p.id)).toEqual(['b', 'c', 'a']);
  });

  it('places projects not in workspaceOrder first (DESC), explicit list after in drag order', () => {
    const ps = [
      proj('a', 1),
      proj('b', 3), // unknown
      proj('c', 2), // unknown
      proj('d', 5),
    ];
    expect(sortLiveProjects(ps, ['a', 'd']).map((p) => p.id)).toEqual([
      'b',
      'c',
      'a',
      'd',
    ]);
  });

  it('skips stale IDs in workspaceOrder without throwing', () => {
    const ps = [proj('a', 1), proj('b', 2)];
    expect(
      sortLiveProjects(ps, ['ghost', 'a', 'also-gone', 'b']).map((p) => p.id),
    ).toEqual(['a', 'b']);
  });

  it('filters out deleted and archived projects', () => {
    const ps = [
      proj('live', 1),
      proj('trashed', 2, { deletedAt: 100 }),
      proj('archived', 3, { archivedAt: 100 }),
    ];
    expect(sortLiveProjects(ps, []).map((p) => p.id)).toEqual(['live']);
  });

  it('is stable when two unknown projects share createdAt', () => {
    const ps = [proj('a', 5), proj('b', 5), proj('c', 5)];
    expect(sortLiveProjects(ps, []).map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('sortTrees', () => {
  const tree = (
    id: string,
    createdAt: number,
    archivedAt?: number,
    lastActiveAt = createdAt,
  ): Tree => ({
    id,
    rootNodeId: `root-${id}`,
    createdAt,
    lastActiveAt,
    archivedAt,
  });

  it('sorts live trees by lastActiveAt DESC regardless of active tree', () => {
    const trees = [
      tree('a', 5, undefined, 50),
      tree('b', 10, undefined, 20),
      tree('c', 1, undefined, 80),
    ];
    expect(sortTrees(trees, 'b').map((t) => t.id)).toEqual(['c', 'a', 'b']);
    expect(sortTrees(trees, null).map((t) => t.id)).toEqual(['c', 'a', 'b']);
  });

  it('puts archived trees after live trees, archived also DESC', () => {
    const trees = [
      tree('a', 5),
      tree('b', 10, /*archivedAt*/ 100),
      tree('c', 1),
      tree('d', 20, /*archivedAt*/ 200),
    ];
    expect(sortTrees(trees, null).map((t) => t.id)).toEqual(['a', 'c', 'd', 'b']);
  });
});

describe('mergeReferences', () => {
  const mkProject = (
    chatIds: string[],
    edges: Project['edges'],
  ): Project => ({
    id: 'p',
    name: 'p',
    chatIds,
    edges,
    createdAt: 1,
    trees: [],
    activeTreeId: null,
    contexts: [],
  });

  const mkNodes = (entries: Record<string, string[] | undefined>): Record<string, ChatNodeState> =>
    Object.fromEntries(
      Object.entries(entries).map(([id, mergeSources]) => [
        id,
        { mergeSources } as unknown as ChatNodeState,
      ]),
    );

  it('returns one group per merge node, newest first by chatIds order', () => {
    const project = mkProject(
      ['A', 'B', 'C1', 'D', 'C2'],
      [
        { source: 'A', target: 'C1', kind: 'merge' },
        { source: 'B', target: 'C1', kind: 'merge' },
        { source: 'C1', target: 'C2', kind: 'merge' },
        { source: 'D', target: 'C2', kind: 'merge' },
      ],
    );
    const nodes = mkNodes({ A: undefined, B: undefined, C1: ['A', 'B'], D: undefined, C2: ['C1', 'D'] });
    const groups = mergeReferences(project, nodes);
    expect(groups.map((g) => g.mergeNodeId)).toEqual(['C2', 'C1']);
    expect(groups[0].sources).toEqual(['C1', 'D']);
    expect(groups[1].sources).toEqual(['A', 'B']);
  });

  it('ignores nodes without mergeSources', () => {
    const project = mkProject(['A', 'B'], []);
    const nodes = mkNodes({ A: undefined, B: undefined });
    expect(mergeReferences(project, nodes)).toEqual([]);
  });
});
