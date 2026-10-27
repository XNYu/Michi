import { vi } from 'vitest';
import { buildCommands, CommandContext } from './commands';

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    activePage: 'dashboard',
    selection: new Set<string>(),
    allChats: [],
    hasActiveProject: false,
    setPage: vi.fn(),
    fanoutFromSelection: vi.fn(),
    digestFromSelection: vi.fn(),
    exportSelection: vi.fn(),
    clearSelection: vi.fn(),
    openChat: vi.fn(),
    switchProject: vi.fn(),
    workspaces: [],
    switchWorkspace: vi.fn(),
    createThread: vi.fn(),
    activateTree: vi.fn(),
    archiveTree: vi.fn(),
    unarchiveTree: vi.fn(),
    activeTreeId: null,
    liveTrees: [],
    archivedTrees: [],
    customAgentsEnabled: true,
    ...overrides,
  };
}

const baseCtx: CommandContext = makeCtx({ hasActiveProject: true });

describe('buildCommands', () => {
  it('offers Go to all tasks right after Pages, when the shell can open it', () => {
    const openAllTasks = vi.fn();
    const cmds = buildCommands(makeCtx({ hasActiveProject: true, openAllTasks }));
    const navIds = cmds.filter((c) => c.group === 'nav').map((c) => c.id);
    expect(navIds[navIds.indexOf('nav.spaces') + 1]).toBe('nav.all-tasks');
    const allTasks = cmds.find((c) => c.id === 'nav.all-tasks')!;
    expect(allTasks.label).toBe('Go to all tasks');
    allTasks.run();
    expect(openAllTasks).toHaveBeenCalledOnce();
    expect(buildCommands(makeCtx({ hasActiveProject: true })).some((c) => c.id === 'nav.all-tasks')).toBe(false);
  });

  it('does not offer the removed All threads page', () => {
    const cmds = buildCommands(makeCtx({ hasActiveProject: true }));
    expect(cmds.some(c => c.id === 'nav.threads')).toBe(false);
    expect(cmds.find(c => c.group === 'nav')?.id).toBe('nav.home');
  });

  it('adds weave/digest/export/clear when selection has ≥2 items', () => {
    const cmds = buildCommands(makeCtx({ hasActiveProject: true, selection: new Set(['n1', 'n2']) }));
    const actionIds = cmds.filter((c) => c.group === 'action').map((c) => c.id);
    expect(actionIds).toEqual(expect.arrayContaining([
      'action.weave', 'action.digest', 'action.export', 'action.clear',
    ]));
    expect(actionIds).not.toContain('action.summary');
    expect(actionIds).not.toContain('action.synthesize');
  });
});

describe('thread commands', () => {
  const base = makeCtx({
    hasActiveProject: true,
    activeTreeId: 't1',
    liveTrees: [{ id: 't1', name: 'Research' }, { id: 't2', name: 'Planning' }],
    archivedTrees: [{ id: 't3', name: 'Old' }],
  });

  it('includes archived switches that do not unarchive', () => {
    const cmds = buildCommands(base);
    const archived = cmds.find((c) => c.label === 'Switch to archived thread ▸ Old')!;
    archived.run();
    expect(base.activateTree).toHaveBeenCalledWith('t3');
    expect(base.unarchiveTree).not.toHaveBeenCalled();
  });
});
