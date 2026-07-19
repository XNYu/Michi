import { describe, expect, it } from 'vitest';
import type { Project } from '../../../state/chatTypes';
import { visibleMapNodeIds } from './mapVisibility';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Workspace',
    chatIds: ['live-root', 'live-child', 'archived-root', 'archived-child', 'digest', 'deleted'],
    edges: [
      { source: 'live-root', target: 'live-child' },
      { source: 'archived-root', target: 'archived-child' },
    ],
    createdAt: 0,
    trees: [
      { id: 'live-tree', rootNodeId: 'live-root', createdAt: 0, lastActiveAt: 0 },
      { id: 'archived-tree', rootNodeId: 'archived-root', createdAt: 0, lastActiveAt: 0, archivedAt: 10 },
    ],
    activeTreeId: 'live-tree',
    ...overrides,
  };
}

describe('visibleMapNodeIds', () => {
  it('keeps only the active thread even when another thread is live', () => {
    expect(
      visibleMapNodeIds(project({
        trees: [
          { id: 'live-tree', rootNodeId: 'live-root', createdAt: 0, lastActiveAt: 0 },
          { id: 'archived-tree', rootNodeId: 'archived-root', createdAt: 0, lastActiveAt: 0 },
        ],
      }), {
        'live-root': {},
        'live-child': {},
        'archived-root': {},
        'archived-child': {},
        digest: { kind: 'digest' },
        deleted: { deletedAt: 1 },
      }),
    ).toEqual(['live-root', 'live-child']);
  });

  it('returns no nodes when there is no active thread', () => {
    expect(visibleMapNodeIds(project({ activeTreeId: null }), { 'live-root': {} })).toEqual([]);
  });

  it('hides a whole tree when its root is deleted', () => {
    expect(
      visibleMapNodeIds(
        project({
          chatIds: ['deleted-root', 'deleted-child'],
          edges: [{ source: 'deleted-root', target: 'deleted-child' }],
          trees: [{ id: 'deleted-tree', rootNodeId: 'deleted-root', createdAt: 0, lastActiveAt: 0 }],
          activeTreeId: 'deleted-tree',
        }),
        {
          'deleted-root': { deletedAt: 1 },
          'deleted-child': {},
        },
      ),
    ).toEqual([]);
  });

  it('builds the branch parent index only once for the whole workspace', () => {
    let edgeIterations = 0;
    const rawEdges = [
      { source: 'root', target: 'a' },
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ];
    const edges = new Proxy(rawEdges, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          return function* iterate() {
            edgeIterations += 1;
            yield* target;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(
      visibleMapNodeIds(
        project({
          chatIds: ['root', 'a', 'b', 'c'],
          edges,
          trees: [{ id: 'tree', rootNodeId: 'root', createdAt: 0, lastActiveAt: 0 }],
          activeTreeId: 'tree',
        }),
        { root: {}, a: {}, b: {}, c: {} },
      ),
    ).toEqual(['root', 'a', 'b', 'c']);
    expect(edgeIterations).toBe(1);
  });

  it('ignores non-branch parents and excludes orphaned or cyclic nodes', () => {
    expect(
      visibleMapNodeIds(
        project({
          chatIds: ['root', 'child', 'linked', 'merged', 'orphan', 'cycle-a', 'cycle-b'],
          edges: [
            { source: 'root', target: 'child', kind: 'branch' },
            { source: 'root', target: 'linked', kind: 'link' },
            { source: 'root', target: 'merged', kind: 'merge' },
            { source: 'cycle-a', target: 'cycle-b', kind: 'branch' },
            { source: 'cycle-b', target: 'cycle-a', kind: 'branch' },
          ],
          trees: [{ id: 'tree', rootNodeId: 'root', createdAt: 0, lastActiveAt: 0 }],
          activeTreeId: 'tree',
        }),
        {
          root: {}, child: {}, linked: {}, merged: {}, orphan: {}, 'cycle-a': {}, 'cycle-b': {},
        },
      ),
    ).toEqual(['root', 'child']);
  });
});
