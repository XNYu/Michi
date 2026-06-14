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
  contexts: [],
  ...overrides,
});

const mkActions = () => ({
  archiveProject: vi.fn(),
  unarchiveProject: vi.fn(),
  deleteProject: vi.fn(),
  beginInlineRename: vi.fn(),
  openManageWorkspace: vi.fn(),
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

  it('also includes the existing Rename, Archive, and Delete items', () => {
    const sections = buildWorkspaceRowContextMenu({ project: mkProject(), actions: mkActions() });
    const labels = sections.flatMap((s) => s.items.map((i) => i.label.toLowerCase()));
    expect(labels.some((l) => l.includes('rename'))).toBe(true);
    expect(labels.some((l) => l.includes('archive'))).toBe(true);
    expect(labels.some((l) => l.includes('delete'))).toBe(true);
  });
});
