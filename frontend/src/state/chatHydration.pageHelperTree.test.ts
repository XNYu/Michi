import { describe, expect, it } from 'vitest';
import { hydrateBackendWorkspaces } from './chatHydration';

function workspace(activeTreeId: string | null) {
  return {
    workspace: { id: 'ws1', name: 'Test', created_at: 1, active_tree_id: activeTreeId },
    trees: [
      { id: 't-chat', root_node_id: 'n-chat', created_at: 1, last_active_at: 10 },
      // Created after the chat, so it is the most recently active tree.
      { id: 't-helper', root_node_id: 'n-helper', created_at: 2, last_active_at: 20 },
    ],
    nodes: [
      { id: 'n-chat', created_at: 1, kind: 'chat' },
      { id: 'n-helper', created_at: 2, kind: 'chat', page_id: 'pg-1' },
    ],
    edges: [],
    messages: [],
    artifacts: [],
  };
}

describe('hydrateBackendWorkspaces — page helper trees', () => {
  it('does not land on a newer page helper tree when no tree is requested', () => {
    const state = hydrateBackendWorkspaces([workspace(null)]);
    expect(state.projects[0].activeTreeId).toBe('t-chat');
  });

  it('does not keep a page helper tree as the requested active tree', () => {
    const state = hydrateBackendWorkspaces([workspace('t-helper')]);
    expect(state.projects[0].activeTreeId).toBe('t-chat');
  });

  it('keeps a requested ordinary tree', () => {
    const state = hydrateBackendWorkspaces([workspace('t-chat')]);
    expect(state.projects[0].activeTreeId).toBe('t-chat');
  });
});

describe('hydrateBackendWorkspaces — maintenance trees', () => {
  const withRun = (activeTreeId: string | null) => ({
    ...workspace(activeTreeId),
    trees: [
      { id: 't-chat', root_node_id: 'n-chat', created_at: 1, last_active_at: 10 },
      { id: 't-run', root_node_id: 'n-run', created_at: 3, last_active_at: 30 },
    ],
    nodes: [
      { id: 'n-chat', created_at: 1, kind: 'chat' },
      { id: 'n-run', created_at: 3, kind: 'chat', maintenance_job_id: 'job-maint', message_count: 2 },
    ],
  });

  it('keeps the newer maintenance run in state without landing on it', () => {
    for (const requested of [null, 't-run']) {
      const state = hydrateBackendWorkspaces([withRun(requested)]);
      expect(state.projects[0].activeTreeId).toBe('t-chat');
      expect(state.projects[0].chatIds).toContain('n-run');
      expect(state.nodes['n-run']?.maintenanceJobId).toBe('job-maint');
    }
  });
});
