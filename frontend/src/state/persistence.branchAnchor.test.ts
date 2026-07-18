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
    contexts: [],
    ...extras,
  } as Project;
}

// ---------------------------------------------------------------------------
// Serialization tests (outbound wire shape)
// ---------------------------------------------------------------------------

describe('serializeWorkspaceForSync — edge fields', () => {
  it('includes anchor_message_id and created_at when set on a branch edge', () => {
    const project = makeProject('ws1', ['n1'], {
      edges: [{ source: 'n1', target: 'n2', kind: 'branch', anchorMessageId: 'm-anchor', createdAt: 1_716_800_000_000 }],
    });
    const nodes = { n1: makeNode('n1', 'ws1') };

    const wire = serializeWorkspaceForSync(project, nodes);
    expect(wire.edges).toHaveLength(1);
    expect(wire.edges[0].anchor_message_id).toBe('m-anchor');
    expect(wire.edges[0].created_at).toBe(1_716_800_000_000);
  });

  it('emits null for anchor_message_id and created_at when absent (historical edge)', () => {
    const project = makeProject('ws1', ['n1'], {
      edges: [{ source: 'n1', target: 'n2', kind: 'branch' }],
    });
    const nodes = { n1: makeNode('n1', 'ws1') };

    const wire = serializeWorkspaceForSync(project, nodes);
    expect(wire.edges[0].anchor_message_id).toBeNull();
    expect(wire.edges[0].created_at).toBeNull();
  });
});

describe('serializeWorkspaceForSync — node fields', () => {
  it('includes branch_overview when set on a node', () => {
    const project = makeProject('ws1', ['n1']);
    const entries = [{ at: 1000, text: 'Current branch state.' }];
    const nodes = { n1: makeNode('n1', 'ws1', { branchOverview: 'Current branch state.', branchOverviewEntries: entries }) };

    const wire = serializeWorkspaceForSync(project, nodes);
    expect(wire.nodes[0]!.branch_overview).toBe(JSON.stringify(entries));
  });

  it('emits null branch_overview when absent', () => {
    const project = makeProject('ws1', ['n1']);
    const nodes = { n1: makeNode('n1', 'ws1') };

    const wire = serializeWorkspaceForSync(project, nodes);
    expect(wire.nodes[0]!.branch_overview).toBeNull();
  });

  it('includes follow_ups_source_message_id when set on a node', () => {
    const project = makeProject('ws1', ['n1']);
    const nodes = { n1: makeNode('n1', 'ws1', { followUpsSourceMessageId: 'm-src' }) };

    const wire = serializeWorkspaceForSync(project, nodes);
    expect(wire.nodes).toHaveLength(1);
    expect(wire.nodes[0]!.follow_ups_source_message_id).toBe('m-src');
  });

  it('emits null for follow_ups_source_message_id when absent', () => {
    const project = makeProject('ws1', ['n1']);
    const nodes = { n1: makeNode('n1', 'ws1') };

    const wire = serializeWorkspaceForSync(project, nodes);
    expect(wire.nodes[0]!.follow_ups_source_message_id).toBeNull();
  });
});

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
    contexts: [],
  };
}

describe('hydrateBackendWorkspaces — edge fields', () => {
  it('hydrates anchorMessageId and createdAt from backend edge row', () => {
    const ws = makeBackendWorkspace({
      edgeRows: [{
        source_node_id: 'n1',
        target_node_id: 'n2',
        kind: 'branch',
        anchor_message_id: 'm-anchor',
        created_at: 1_716_800_000_000,
      }],
    });

    const state = hydrateBackendWorkspaces([ws]);
    const edge = state.projects[0].edges[0];
    expect(edge.anchorMessageId).toBe('m-anchor');
    expect(edge.createdAt).toBe(1_716_800_000_000);
  });

  it('leaves anchorMessageId and createdAt undefined when backend columns are null', () => {
    const ws = makeBackendWorkspace({
      edgeRows: [{
        source_node_id: 'n1',
        target_node_id: 'n2',
        kind: 'branch',
        anchor_message_id: null,
        created_at: null,
      }],
    });

    const state = hydrateBackendWorkspaces([ws]);
    const edge = state.projects[0].edges[0];
    expect(edge.anchorMessageId).toBeUndefined();
    expect(edge.createdAt).toBeUndefined();
  });
});

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

  it('hydrates followUpsSourceMessageId from backend node row', () => {
    const ws = makeBackendWorkspace({
      nodeRows: [{
        id: 'n1',
        created_at: 1_716_800_000_000,
        kind: 'chat',
        follow_ups_source_message_id: 'm-src',
      }],
    });

    const state = hydrateBackendWorkspaces([ws]);
    expect(state.nodes['n1'].followUpsSourceMessageId).toBe('m-src');
  });

  it('leaves followUpsSourceMessageId undefined when backend column is null', () => {
    const ws = makeBackendWorkspace({
      nodeRows: [{
        id: 'n1',
        created_at: 1_716_800_000_000,
        kind: 'chat',
        follow_ups_source_message_id: null,
      }],
    });

    const state = hydrateBackendWorkspaces([ws]);
    expect(state.nodes['n1'].followUpsSourceMessageId).toBeUndefined();
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
      contexts: [],
    };

    const state = hydrateBackendWorkspaces([backendWs]);
    const edge = state.projects[0].edges[0];
    expect(edge.anchorMessageId).toBe('m1');
    expect(edge.createdAt).toBe(1_716_800_000_000);
  });

  it('preserves followUpsSourceMessageId across serialize → hydrate', () => {
    const project = makeProject('ws1', ['n1']);
    const nodes = { n1: makeNode('n1', 'ws1', { followUpsSourceMessageId: 'm-src' }) };

    const wire = serializeWorkspaceForSync(project, nodes);
    const wireNode = wire.nodes[0]!;

    const backendWs = {
      workspace: { id: 'ws1', name: 'Test', created_at: 1_716_800_000_000 },
      trees: [{ id: 't1', root_node_id: 'n1', created_at: 1_716_800_000_000, last_active_at: 1_716_800_000_000 }],
      nodes: [{
        id: wireNode.id,
        created_at: wireNode.created_at,
        kind: wireNode.kind,
        follow_ups_source_message_id: wireNode.follow_ups_source_message_id,
      }],
      edges: [],
      messages: [],
      contexts: [],
    };

    const state = hydrateBackendWorkspaces([backendWs]);
    expect(state.nodes['n1'].followUpsSourceMessageId).toBe('m-src');
  });

  it('preserves undefined anchor across round-trip (historical edge)', () => {
    const project = makeProject('ws1', ['n1'], {
      edges: [{ source: 'n1', target: 'n2', kind: 'branch' }],
    });
    const nodes = { n1: makeNode('n1', 'ws1') };

    const wire = serializeWorkspaceForSync(project, nodes);
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
      contexts: [],
    };

    const state = hydrateBackendWorkspaces([backendWs]);
    const edge = state.projects[0].edges[0];
    expect(edge.anchorMessageId).toBeUndefined();
    expect(edge.createdAt).toBeUndefined();
  });
});
