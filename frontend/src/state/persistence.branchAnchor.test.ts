import { describe, it, expect } from 'vitest';
import { serializeWorkspaceForSync } from './workspacePersistence';
import { hydrateBackendWorkspaces } from './chatHydration';
import type { ChatNodeState, Project } from './chatTypes';

// ---------------------------------------------------------------------------
// Minimal fixture builders
// ---------------------------------------------------------------------------

function makeNode(nodeId: string, projectId: string, extras: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId,
    kind: 'chat',
    chatId: null,
    projectId,
    messages: [],
    followUps: [],
    status: 'idle',
    ...extras,
  } as unknown as ChatNodeState;
}

function makeProject(id: string, nodeIds: string[], extras: Partial<Project> = {}): Project {
  return {
    id,
    name: 'Test',
    chatIds: nodeIds,
    edges: [],
    createdAt: 1_716_800_000_000,
    trees: [{ id: 't1', rootNodeId: nodeIds[0] ?? 'n1', createdAt: 1_716_800_000_000, lastActiveAt: 1_716_800_000_000 }],
    activeTreeId: 't1',
    artifacts: [],
    ...extras,
  } as Project;
}

// ---------------------------------------------------------------------------
// Hydration tests (inbound from backend rows)
// ---------------------------------------------------------------------------

/** Build a minimal BackendFullWorkspace shape that hydrateBackendWorkspaces accepts */
function makeBackendWorkspace(overrides: {
  nodeRows?: Record<string, unknown>[];
  edgeRows?: Record<string, unknown>[];
} = {}) {
  return {
    workspace: { id: 'ws1', name: 'Test', created_at: 1_716_800_000_000 },
    trees: [{ id: 't1', root_node_id: 'n1', created_at: 1_716_800_000_000, last_active_at: 1_716_800_000_000 }],
    nodes: overrides.nodeRows ?? [{ id: 'n1', created_at: 1_716_800_000_000, kind: 'chat' }],
    edges: overrides.edgeRows ?? [],
    messages: [],
    artifacts: [],
  };
}

describe('hydrateBackendWorkspaces — node fields', () => {
  it('hydrates branchOverview from backend node row', () => {
    const ws = makeBackendWorkspace({
      nodeRows: [{
        id: 'n1',
        created_at: 1_716_800_000_000,
        kind: 'chat',
        branch_overview: 'A durable branch summary.',
      }],
    });

    const state = hydrateBackendWorkspaces([ws]);
    expect(state.nodes['n1'].branchOverview).toBe('A durable branch summary.');
  });
});

// ---------------------------------------------------------------------------
// Full round-trip: serialize → wire shape → re-hydrate from wire-shaped row
// ---------------------------------------------------------------------------

describe('full round-trip (serialize wire shape → hydrate)', () => {
  it('preserves anchorMessageId + createdAt across serialize → hydrate', () => {
    const project = makeProject('ws1', ['n1'], {
      edges: [{ source: 'n1', target: 'n2', kind: 'branch', anchorMessageId: 'm1', createdAt: 1_716_800_000_000 }],
    });
    const nodes = { n1: makeNode('n1', 'ws1') };

    const wire = serializeWorkspaceForSync(project, nodes);
    // Build a BackendFullWorkspace from the wire edge row
    const backendWs = {
      workspace: { id: 'ws1', name: 'Test', created_at: 1_716_800_000_000 },
      trees: [{ id: 't1', root_node_id: 'n1', created_at: 1_716_800_000_000, last_active_at: 1_716_800_000_000 }],
      nodes: [{ id: 'n1', created_at: 1_716_800_000_000, kind: 'chat' }],
      edges: wire.edges.map((e) => ({
        source_node_id: e.source_node_id,
        target_node_id: e.target_node_id,
        kind: e.kind,
        anchor_message_id: e.anchor_message_id,
        created_at: e.created_at,
      })),
      messages: [],
      artifacts: [],
    };

    const state = hydrateBackendWorkspaces([backendWs]);
    const edge = state.projects[0].edges[0];
    expect(edge.anchorMessageId).toBe('m1');
    expect(edge.createdAt).toBe(1_716_800_000_000);
  });
});
