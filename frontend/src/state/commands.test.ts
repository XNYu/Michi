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
    createThread: vi.fn(),
    activateTree: vi.fn(),
    archiveTree: vi.fn(),
    unarchiveTree: vi.fn(),
    activeTreeId: null,
    liveTrees: [],
    archivedTrees: [],
    bypassPermissions: false,
    toggleBypassPermissions: vi.fn(),
    ...overrides,
  };
}

const baseCtx: CommandContext = makeCtx({ hasActiveProject: true });

describe('buildCommands', () => {
  it('always includes the nav commands when there is an active project', () => {
    const cmds = buildCommands(baseCtx);
    const navIds = cmds.filter((c) => c.group === 'nav').map((c) => c.id);
    expect(navIds).toEqual([
      'nav.home', 'nav.branches', 'nav.map', 'nav.digest', 'nav.workspaces', 'nav.trash', 'nav.archived', 'nav.settings',
    ]);
    expect(cmds.map((c) => c.label)).toContain('Open thread digest');
  });

  it('omits selection action commands when selection is empty', () => {
    const cmds = buildCommands(baseCtx);
    // Selection actions only. `action.bypass-permissions` is an always-present
    // global toggle that shares the `action.` prefix but is not selection-scoped.
    const selectionActions = cmds.filter(
      (c) => c.group === 'action' && c.id.startsWith('action.') && c.id !== 'action.bypass-permissions',
    );
    expect(selectionActions).toHaveLength(0);
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

  it('includes New thread and Switch to commands for live trees', () => {
    const cmds = buildCommands(base);
    const labels = cmds.map((c) => c.label);
    expect(labels).toContain('New thread');
    expect(labels).toContain('Switch to thread ▸ Research');
    expect(labels).toContain('Switch to thread ▸ Planning');
  });

  it('includes archived switches that do not unarchive', () => {
    const cmds = buildCommands(base);
    const archived = cmds.find((c) => c.label === 'Switch to archived thread ▸ Old')!;
    archived.run();
    expect(base.activateTree).toHaveBeenCalledWith('t3');
    expect(base.unarchiveTree).not.toHaveBeenCalled();
  });

  it('exposes Archive current thread only when there is an active tree', () => {
    const cmds = buildCommands(base);
    expect(cmds.map((c) => c.label)).toContain('Archive current thread');
    const none = buildCommands({ ...base, activeTreeId: null });
    expect(none.map((c) => c.label)).not.toContain('Archive current thread');
  });
});

describe('buildCommands cross-project chats', () => {
  it('emits chat commands with project name suffix', () => {
    const ctx = makeCtx({
      hasActiveProject: true,
      allChats: [
        { id: 'n1', title: 'Pricing', projectId: 'p1', projectName: 'Workspace A' },
        { id: 'n2', title: 'Onboarding', projectId: 'p2', projectName: 'Workspace B' },
      ],
    });
    const cmds = buildCommands(ctx);
    const labels = cmds.filter((c) => c.group === 'chat').map((c) => c.label);
    expect(labels).toContain('Pricing · Workspace A');
    expect(labels).toContain('Onboarding · Workspace B');
  });

  it('caps chat commands at 50 entries', () => {
    const allChats = Array.from({ length: 80 }, (_, i) => ({
      id: `n${i}`,
      title: `Chat ${i}`,
      projectId: 'p1',
      projectName: 'P1',
    }));
    const ctx = makeCtx({ hasActiveProject: true, allChats });
    const cmds = buildCommands(ctx);
    const chats = cmds.filter((c) => c.group === 'chat');
    expect(chats.length).toBe(50);
  });

  it('calls switchProject before openChat when running a chat command', () => {
    const switchProject = vi.fn();
    const openChat = vi.fn();
    const order: string[] = [];
    switchProject.mockImplementation(() => order.push('switch'));
    openChat.mockImplementation(() => order.push('open'));
    const ctx = makeCtx({
      hasActiveProject: true,
      switchProject,
      openChat,
      allChats: [{ id: 'n9', title: 'Other', projectId: 'p2', projectName: 'P2' }],
    });
    const cmds = buildCommands(ctx);
    const cmd = cmds.find((c) => c.id === 'chat.n9');
    expect(cmd).toBeDefined();
    cmd!.run();
    expect(switchProject).toHaveBeenCalledWith('p2');
    expect(openChat).toHaveBeenCalledWith('n9');
    expect(order).toEqual(['switch', 'open']);
  });
});
