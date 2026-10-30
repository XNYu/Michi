import { describe, it, expect, vi } from 'vitest';
import { buildWorkspaceRowContextMenu } from './workspaceRowContextMenu';
import type { Project } from '../state/chatTypes';

const mkProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'p1',
  chatIds: [],
  edges: [],
  createdAt: 0,
  trees: [],
  activeTreeId: null,
  artifacts: [],
  ...overrides,
});

const mkActions = () => ({
  archiveProject: vi.fn(),
  unarchiveProject: vi.fn(),
  pinProject: vi.fn(),
  unpinProject: vi.fn(),
  deleteProject: vi.fn(),
  beginInlineRename: vi.fn(),
  openManageWorkspace: vi.fn(),
});

describe('buildWorkspaceRowContextMenu — item ids and delete confirmation', () => {
  it('names each action, following the workspace’s pinned and archived state', () => {
    const ids = (project: Project) => buildWorkspaceRowContextMenu({ project, actions: mkActions() })
      .flatMap((s) => s.items.map((i) => i.id));
    expect(ids(mkProject())).toEqual(['manage', 'rename', 'pin', 'archive', 'delete']);
    expect(ids(mkProject({ pinnedAt: 1, archivedAt: 2 }))).toEqual(['manage', 'rename', 'unpin', 'unarchive', 'delete']);
  });

  it('lets the caller confirm deletion in its own UI', () => {
    const requestDelete = vi.fn();
    const actions = { ...mkActions(), requestDelete };
    const del = buildWorkspaceRowContextMenu({ project: mkProject(), actions })
      .flatMap((s) => s.items)
      .find((i) => i.id === 'delete')!;
    del.onSelect();
    expect(requestDelete).toHaveBeenCalledWith('p1');
    expect(actions.deleteProject).not.toHaveBeenCalled();
  });
});

describe('buildWorkspaceRowContextMenu — Manage workspace item', () => {
  it('exposes a Manage workspace item that calls openManageWorkspace with the project id', () => {
    const actions = mkActions();
    const sections = buildWorkspaceRowContextMenu({ project: mkProject(), actions });
    const flat = sections.flatMap((s) => s.items);
    const manage = flat.find((i) => i.label.toLowerCase().includes('manage'));
    expect(manage).toBeDefined();
    manage!.onSelect();
    expect(actions.openManageWorkspace).toHaveBeenCalledWith('p1');
  });

  it('offers Link/Change folder when the caller provides the desktop action', () => {
    const changeFolder = vi.fn();
    const actions = { ...mkActions(), changeFolder };
    const unlinked = buildWorkspaceRowContextMenu({ project: mkProject(), actions });
    const link = unlinked.flatMap((s) => s.items).find((i) => i.label === 'Link folder…');
    expect(link).toBeDefined();
    link!.onSelect();
    expect(changeFolder).toHaveBeenCalledWith('p1');

    const linked = buildWorkspaceRowContextMenu({
      project: mkProject({ cwd: '/tmp/project' }),
      actions,
    });
    expect(linked.flatMap((s) => s.items).some((i) => i.label === 'Change folder…')).toBe(true);
  });
});
