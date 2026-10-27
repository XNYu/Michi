import { describe, it, expect } from 'vitest';
import { sortLiveProjects, mergeReferences, selectProjectNodeStatuses } from './sidebarSelectors';
import type { Project, ChatNodeState } from './chatTypes';

const empty = { workspaces: {}, threads: {}, branches: {} };

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
  artifacts: [],
  deletedAt: opts.deletedAt,
  archivedAt: opts.archivedAt,
});

describe('sortLiveProjects', () => {
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
    artifacts: [],
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
});
