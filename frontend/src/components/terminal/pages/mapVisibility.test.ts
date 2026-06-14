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
  it('excludes archived tree nodes while keeping live tree nodes', () => {
    expect(
      visibleMapNodeIds(project(), {
        'live-root': {},
        'live-child': {},
        'archived-root': {},
        'archived-child': {},
        digest: { kind: 'digest' },
        deleted: { deletedAt: 1 },
      }),
    ).toEqual(['live-root', 'live-child']);
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
});
