import { describe, expect, it } from 'vitest';
import type { Project } from '../chatTypes';
import { hydrateBackendWorkspaces } from '../chatHydration';
import { serializeWorkspaceRow } from '../workspacePersistence';
import { sortLiveProjects } from '../sidebarSelectors';
import { durableNodePrerequisite } from '../chatStore';
import { isSystemWorkspace, parseSystemWorkspace, systemWorkspaceIds, withoutSystemWorkspaces } from './systemWorkspace';

function project(id: string, extra: Partial<Project> = {}): Project {
  return { id, name: id, chatIds: [], edges: [], createdAt: 1, trees: [], activeTreeId: null, ...extra };
}

function rawWorkspace(id: string, settings: unknown) {
  return {
    workspace: { id, name: id, created_at: 1, settings: settings === null ? null : JSON.stringify(settings) },
    trees: [{ id: `t-${id}`, root_node_id: `n-${id}`, last_active_at: 1 }],
    nodes: [{ id: `n-${id}`, created_at: 1 }],
    edges: [],
    messages: [],
  };
}

describe('system workspaces', () => {
  it('reads the flag from settings', () => {
    expect(parseSystemWorkspace({ system: 'assistant' })).toBe('assistant');
    expect(parseSystemWorkspace({ system: '' })).toBeUndefined();
    expect(parseSystemWorkspace({ system: true })).toBeUndefined();
    expect(parseSystemWorkspace(null)).toBeUndefined();
  });

  it('filters lists and returns the same array when there is none', () => {
    const user = [project('a'), project('b')];
    expect(withoutSystemWorkspaces(user)).toBe(user);
    const mixed = [project('a'), project('s', { system: 'assistant' })];
    expect(withoutSystemWorkspaces(mixed).map((p) => p.id)).toEqual(['a']);
    expect([...systemWorkspaceIds(mixed)]).toEqual(['s']);
    expect(isSystemWorkspace(mixed[1])).toBe(true);
  });

  it('hydrates the flag and never opens the system workspace on load', () => {
    const state = hydrateBackendWorkspaces([rawWorkspace('s', { system: 'assistant' }), rawWorkspace('a', null)]);
    expect(state.projects.find((p) => p.id === 's')?.system).toBe('assistant');
    expect(state.projects.find((p) => p.id === 'a')?.system).toBeUndefined();
    expect(state.activeProjectId).toBe('a');
    expect(hydrateBackendWorkspaces([rawWorkspace('s', { system: 'assistant' })], 's').activeProjectId).toBeNull();
  });

  it('keeps the flag when the workspace row is written back', () => {
    const row = serializeWorkspaceRow(project('s', { system: 'assistant', instructions: 'x' }));
    expect(JSON.parse(row.settings!)).toEqual({ instructions: 'x', system: 'assistant' });
    expect(serializeWorkspaceRow(project('a')).settings).toBeNull();
    const prerequisite = durableNodePrerequisite(
      project('s', { system: 'assistant', chatIds: ['n'] }),
      { nodeId: 'n', projectId: 's', messages: [] } as never,
    );
    expect((prerequisite.workspace as { settings: unknown }).settings).toEqual({ system: 'assistant' });
  });

  it('is not listed in the sidebar', () => {
    const projects = [project('a'), project('s', { system: 'assistant', createdAt: 9 })];
    expect(sortLiveProjects(projects, []).map((p) => p.id)).toEqual(['a']);
  });
});
