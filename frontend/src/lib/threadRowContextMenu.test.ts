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

  describe('multi-select', () => {
    it('batch Archive calls archiveTree for each selected tree and clears selection', () => {
      const clearTreeSelection = vi.fn();
      const args = baseArgs({
        treeId: 't1',
        treeSelection: new Set(['t1', 't2']),
        clearTreeSelection,
      });
      const sections = buildThreadRowContextMenu(args);
      const archive = sections.flatMap((s) => s.items).find((i) => i.label === 'Archive 2 threads')!;
      archive.onSelect();
      expect(args.actions.archiveTree).toHaveBeenCalledWith('t1');
      expect(args.actions.archiveTree).toHaveBeenCalledWith('t2');
      expect(clearTreeSelection).toHaveBeenCalled();
    });

    it('batch Delete calls deleteTree for each selected tree after confirm', () => {
      const clearTreeSelection = vi.fn();
      const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const args = baseArgs({
        treeId: 't1',
        treeSelection: new Set(['t1', 't2']),
        clearTreeSelection,
      });
      const sections = buildThreadRowContextMenu(args);
      const del = sections.flatMap((s) => s.items).find((i) => i.label === 'Delete 2 threads…')!;
      del.onSelect();
      expect(args.actions.deleteTree).toHaveBeenCalledWith('t1');
      expect(args.actions.deleteTree).toHaveBeenCalledWith('t2');
      expect(clearTreeSelection).toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
