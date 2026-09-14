import { describe, it, expect, vi } from 'vitest';
import { buildTreeContextMenu, type TreeMenuActions } from './treeContextMenu';
import type { ChatNodeState, Project } from '../state/chatTypes';

// treeContextMenu → chatStore → services/api. Only pure menu-building is
// exercised here, so the API surface can be an empty module (same trick as
// chatReducers.structural.test.ts).
vi.mock('../services/api', () => ({}));

function makeProject(): Project {
  return {
    id: 'p1',
    name: 'WS',
    chatIds: ['r1', 'b1'],
    edges: [{ source: 'r1', target: 'b1' }],
    createdAt: 0,
    trees: [{ id: 't1', rootNodeId: 'r1', createdAt: 0, lastActiveAt: 0 }],
    activeTreeId: 't1',
  };
}

function makeNode(nodeId: string, over: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId,
    kind: 'chat',
    chatId: null,
    projectId: 'p1',
    messages: [],
    followUps: [],
    status: 'idle',
    ...over,
  };
}

function makeActions(over: Partial<TreeMenuActions> = {}): TreeMenuActions {
  return {
    openPane: vi.fn(),
    createBlankChild: vi.fn(),
    toggleSelection: vi.fn(),
    clearSelection: vi.fn(),
    deleteNode: vi.fn(),
    trimNode: vi.fn(),
    archiveNode: vi.fn(),
    createMergedChat: vi.fn(async () => 'm1'),
    createDigest: vi.fn(async () => 'd1'),
    openExportPanel: vi.fn(),
    archiveTree: vi.fn(),
    focusOrOpen: vi.fn(),
    ...over,
  };
}

const itemIds = (sections: ReturnType<typeof buildTreeContextMenu>) =>
  sections.flatMap((s) => s.items.map((i) => i.id));

describe('buildTreeContextMenu — node pin', () => {
  it('offers Pin on an unpinned branch node and dispatches pinNode', () => {
    const pinNode = vi.fn();
    const sections = buildTreeContextMenu({
      targetId: 'b1',
      project: makeProject(),
      nodes: { r1: makeNode('r1'), b1: makeNode('b1') },
      selection: new Set(),
      actions: makeActions({ pinNode, unpinNode: vi.fn() }),
    });
    const ids = itemIds(sections);
    expect(ids).toContain('pin');
    expect(ids).not.toContain('unpin');
    // Sits right after Rename, mirroring the thread-row menu.
    expect(ids.indexOf('pin')).toBe(ids.indexOf('rename') + 1);
    sections[0].items.find((i) => i.id === 'pin')!.run();
    expect(pinNode).toHaveBeenCalledWith('b1');
  });

  it('offers Unpin on a pinned branch node and dispatches unpinNode', () => {
    const unpinNode = vi.fn();
    const sections = buildTreeContextMenu({
      targetId: 'b1',
      project: makeProject(),
      nodes: { r1: makeNode('r1'), b1: makeNode('b1', { pinnedAt: 123 }) },
      selection: new Set(),
      actions: makeActions({ pinNode: vi.fn(), unpinNode }),
    });
    const ids = itemIds(sections);
    expect(ids).toContain('unpin');
    expect(ids).not.toContain('pin');
    sections[0].items.find((i) => i.id === 'unpin')!.run();
    expect(unpinNode).toHaveBeenCalledWith('b1');
  });

  it('never offers Pin/Unpin on the tree root (thread-level pin owns that)', () => {
    const sections = buildTreeContextMenu({
      targetId: 'r1',
      project: makeProject(),
      nodes: { r1: makeNode('r1', { pinnedAt: 5 }), b1: makeNode('b1') },
      selection: new Set(),
      actions: makeActions({ pinNode: vi.fn(), unpinNode: vi.fn() }),
    });
    const ids = itemIds(sections);
    expect(ids).not.toContain('pin');
    expect(ids).not.toContain('unpin');
  });

  it('omits the item when the caller does not wire pin actions', () => {
    const sections = buildTreeContextMenu({
      targetId: 'b1',
      project: makeProject(),
      nodes: { r1: makeNode('r1'), b1: makeNode('b1') },
      selection: new Set(),
      actions: makeActions(),
    });
    const ids = itemIds(sections);
    expect(ids).not.toContain('pin');
    expect(ids).not.toContain('unpin');
  });

  it('does not add pin items to the multi-select menu', () => {
    const sections = buildTreeContextMenu({
      targetId: 'b1',
      project: makeProject(),
      nodes: { r1: makeNode('r1'), b1: makeNode('b1'), b2: makeNode('b2') },
      selection: new Set(['b1', 'b2']),
      actions: makeActions({ pinNode: vi.fn(), unpinNode: vi.fn() }),
    });
    const ids = itemIds(sections);
    expect(ids).not.toContain('pin');
    expect(ids).not.toContain('unpin');
  });
});
