import { vi } from 'vitest';
import { buildThreadRowContextMenu } from './threadRowContextMenu';

function baseArgs(overrides: Partial<Parameters<typeof buildThreadRowContextMenu>[0]> = {}) {
  const actions = {
    activateTree: vi.fn(),
    archiveTree: vi.fn(),
    unarchiveTree: vi.fn(),
    renameTree: vi.fn(),
    deleteTree: vi.fn(),
    exportTree: vi.fn(),
  };
  return {
    treeId: 't1',
    tree: { id: 't1', rootNodeId: 'r1', createdAt: 0, lastActiveAt: 0 },
    actions,
    ...overrides,
  };
}

describe('buildThreadRowContextMenu', () => {
  it('offers Archive when tree is live', () => {
    const args = baseArgs();
    const sections = buildThreadRowContextMenu(args);
    const labels = sections.flatMap((s) => s.items.map((i) => i.label));
    expect(labels).toContain('Archive');
    expect(labels).not.toContain('Unarchive');
  });

  it('offers transcript export and no longer offers AI summary', () => {
    const args = baseArgs();
    const sections = buildThreadRowContextMenu(args);
    const items = sections.flatMap((s) => s.items);
    items.find((i) => i.label === 'Export this thread…')!.onSelect();
    expect(args.actions.exportTree).toHaveBeenCalledWith('t1');
    expect(items.find((i) => i.label === 'Summarize this thread…')).toBeUndefined();
  });

  it('offers Unarchive when tree is archived', () => {
    const args = baseArgs({
      tree: { id: 't1', rootNodeId: 'r1', createdAt: 0, lastActiveAt: 0, archivedAt: 1 },
    });
    const sections = buildThreadRowContextMenu(args);
    const labels = sections.flatMap((s) => s.items.map((i) => i.label));
    expect(labels).toContain('Unarchive');
    expect(labels).not.toContain('Archive');
  });

  it('wires the Rename action to actions.renameTree via inline prompt', () => {
    const args = baseArgs();
    const sections = buildThreadRowContextMenu(args);
    const rename = sections.flatMap((s) => s.items).find((i) => i.label === 'Rename…')!;
    rename.onSelect();
    expect(args.actions.renameTree).toHaveBeenCalledTimes(0); // onSelect opens inline editor, does not call renameTree directly
  });

  it('wires Delete to actions.deleteTree after confirm', () => {
    const args = baseArgs();
    const sections = buildThreadRowContextMenu(args);
    const del = sections.flatMap((s) => s.items).find((i) => i.label === 'Delete thread…')!;
    // Stub confirm so the test is deterministic.
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    del.onSelect();
    expect(args.actions.deleteTree).toHaveBeenCalledWith('t1');
    spy.mockRestore();
  });

  it('omits the Move-to-workspace item when no targets are provided', () => {
    const sections = buildThreadRowContextMenu(baseArgs());
    const labels = sections.flatMap((s) => s.items.map((i) => i.label));
    expect(labels).not.toContain('Move to workspace…');
  });

  it('omits the Move-to-workspace item when targets are empty', () => {
    const sections = buildThreadRowContextMenu(
      baseArgs({
        moveTargets: [],
        actions: {
          activateTree: vi.fn(),
          archiveTree: vi.fn(),
          unarchiveTree: vi.fn(),
          renameTree: vi.fn(),
          deleteTree: vi.fn(),
          exportTree: vi.fn(),
                openMoveDialog: vi.fn(),
        },
      }),
    );
    const labels = sections.flatMap((s) => s.items.map((i) => i.label));
    expect(labels).not.toContain('Move to workspace…');
  });

  it('omits the Move-to-workspace item when openMoveDialog is not wired', () => {
    const sections = buildThreadRowContextMenu(
      baseArgs({
        moveTargets: [{ id: 'ws-a', name: 'Alpha' }],
      }),
    );
    const labels = sections.flatMap((s) => s.items.map((i) => i.label));
    expect(labels).not.toContain('Move to workspace…');
  });

  it('omits Pin/Unpin when actions.pinTree is not provided', () => {
    const sections = buildThreadRowContextMenu(baseArgs());
    const labels = sections.flatMap((s) => s.items.map((i) => i.label));
    expect(labels).not.toContain('Pin');
    expect(labels).not.toContain('Unpin');
  });

  it('shows Pin and wires to pinTree when tree is unpinned', () => {
    const pinTree = vi.fn();
    const unpinTree = vi.fn();
    const sections = buildThreadRowContextMenu(
      baseArgs({
        actions: {
          activateTree: vi.fn(),
          archiveTree: vi.fn(),
          unarchiveTree: vi.fn(),
          pinTree,
          unpinTree,
          renameTree: vi.fn(),
          deleteTree: vi.fn(),
          exportTree: vi.fn(),
              },
      }),
    );
    const item = sections.flatMap((s) => s.items).find((i) => i.label === 'Pin')!;
    expect(item).toBeDefined();
    item.onSelect();
    expect(pinTree).toHaveBeenCalledWith('t1');
    expect(unpinTree).not.toHaveBeenCalled();
  });

  it('shows Unpin and wires to unpinTree when tree is pinned', () => {
    const pinTree = vi.fn();
    const unpinTree = vi.fn();
    const sections = buildThreadRowContextMenu(
      baseArgs({
        tree: { id: 't1', rootNodeId: 'r1', createdAt: 0, lastActiveAt: 0, pinnedAt: 42 },
        actions: {
          activateTree: vi.fn(),
          archiveTree: vi.fn(),
          unarchiveTree: vi.fn(),
          pinTree,
          unpinTree,
          renameTree: vi.fn(),
          deleteTree: vi.fn(),
          exportTree: vi.fn(),
              },
      }),
    );
    const item = sections.flatMap((s) => s.items).find((i) => i.label === 'Unpin')!;
    expect(item).toBeDefined();
    item.onSelect();
    expect(unpinTree).toHaveBeenCalledWith('t1');
    expect(pinTree).not.toHaveBeenCalled();
  });

  it('exposes a single Move-to-workspace item that opens the picker dialog', () => {
    const openMoveDialog = vi.fn();
    const sections = buildThreadRowContextMenu(
      baseArgs({
        moveTargets: [
          { id: 'ws-a', name: 'Alpha' },
          { id: 'ws-b', name: 'Beta' },
        ],
        actions: {
          activateTree: vi.fn(),
          archiveTree: vi.fn(),
          unarchiveTree: vi.fn(),
          renameTree: vi.fn(),
          deleteTree: vi.fn(),
          exportTree: vi.fn(),
                openMoveDialog,
        },
      }),
    );
    const item = sections.flatMap((s) => s.items).find((i) => i.label === 'Move to workspace…')!;
    expect(item).toBeDefined();
    item.onSelect();
    expect(openMoveDialog).toHaveBeenCalledTimes(1);
  });
});
