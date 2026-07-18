/**
 * Message lazy-load: the invariant that keeps it safe is that a placeholder
 * node (messagesLoaded:false, empty messages) is NEVER treated as authoritative
 * — not for write-back, not for hydration, not for digest staleness.
 */
import { describe, expect, it } from 'vitest';
import {
  accumulateWorkspaceDirtyDelta,
  emptyWorkspaceDirtyDelta,
} from './workspacePersistence';
import {
  hydrateBackendWorkspaces,
  applyTreeMessages,
  buildMessagesByNode,
} from './chatHydration';
import { reduceNodes } from './chatReducers';
import { staleSources } from './digest';
import type { ChatNodeState, Project } from './chatTypes';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'ws-1', name: 'WS', chatIds: ['n1'], edges: [], createdAt: 1,
    trees: [{ id: 't1', rootNodeId: 'n1', createdAt: 1, lastActiveAt: 1 }],
    activeTreeId: 't1', contexts: [], ...overrides,
  };
}
function placeholderNode(overrides: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId: 'n1', projectId: 'ws-1', kind: 'chat', chatId: null,
    messages: [], messagesLoaded: false, messageCount: 5,
    followUps: [], status: 'idle', ...overrides,
  };
}

describe('lazy-load write-back safety', () => {
  it('placeholder nodes only enter the message-free node delta', () => {
    const p = project();
    const nodes = { n1: placeholderNode() };
    const delta = accumulateWorkspaceDirtyDelta(undefined, p, {}, nodes, emptyWorkspaceDirtyDelta());
    expect(delta.nodeIds.has('n1')).toBe(true);
    expect('messageNodeIds' in delta).toBe(false);
  });

  it('a loaded node uses the same message-free node delta', () => {
    const p = project();
    const loaded: ChatNodeState = placeholderNode({
      messagesLoaded: true,
      messages: [{ id: 'm1', role: 'user', text: 'hi', toolCalls: [] }],
    });
    const nodes = { n1: loaded };
    const delta = accumulateWorkspaceDirtyDelta(undefined, p, {}, nodes, emptyWorkspaceDirtyDelta());
    expect(delta.nodeIds.has('n1')).toBe(true);
    expect('messageNodeIds' in delta).toBe(false);
  });

  it('a node changing while still a placeholder remains message-free', () => {
    const p = project();
    const prevNodes = { n1: placeholderNode({ title: 'old' }) };
    const curNodes = { n1: placeholderNode({ title: 'new' }) }; // title edit, still unloaded
    const delta = accumulateWorkspaceDirtyDelta(p, p, prevNodes, curNodes, emptyWorkspaceDirtyDelta());
    expect(delta.nodeIds.has('n1')).toBe(true);
    expect('messageNodeIds' in delta).toBe(false);
  });
});

describe('meta hydration', () => {
  const metaRow = {
    workspace: { id: 'ws-1', name: 'WS', created_at: 1, active_tree_id: 't1' },
    trees: [{ id: 't1', workspace_id: 'ws-1', root_node_id: 'n1', last_active_at: 1, created_at: 1 }],
    nodes: [
      { id: 'n1', tree_id: 't1', created_at: 1, message_count: 7 },
      { id: 'n2', tree_id: 't1', parent_node_id: 'n1', created_at: 2, message_count: 0 },
    ],
    edges: [{ source_node_id: 'n1', target_node_id: 'n2', kind: 'branch' }],
    messages: [],
    contexts: [],
  };

  it('builds placeholder nodes with counts and no bodies', () => {
    const { projects, nodes } = hydrateBackendWorkspaces([metaRow], null);
    expect(projects).toHaveLength(1);
    expect(nodes.n1.messagesLoaded).toBe(false);
    expect(nodes.n1.messageCount).toBe(7);
    expect(nodes.n1.messages).toEqual([]);
    // A meta node with count 0 is still a placeholder (unknown until loaded).
    expect(nodes.n2.messagesLoaded).toBe(false);
    expect(nodes.n2.messageCount).toBe(0);
  });

  it('a full payload (bodies present) yields loaded nodes', () => {
    const fullRow = {
      ...metaRow,
      nodes: [{ id: 'n1', tree_id: 't1', created_at: 1 }], // no message_count → full mode
      messages: [{ id: 'm1', node_id: 'n1', role: 'user', content: 'hi', seq: 0, created_at: 1 }],
    };
    const { nodes } = hydrateBackendWorkspaces([fullRow], null);
    expect(nodes.n1.messagesLoaded).toBe(true);
    expect(nodes.n1.messages.map((m) => m.id)).toEqual(['m1']);
  });
});

describe('messages-loaded install', () => {
  it('flips placeholders to loaded and installs bodies via the reducer', () => {
    const nodes = { n1: placeholderNode() };
    const byNode = buildMessagesByNode([
      { id: 'm1', node_id: 'n1', role: 'user', content: 'hello', seq: 0, created_at: 1 },
      { id: 'm2', node_id: 'n1', role: 'assistant', content: 'hi', seq: 1, created_at: 2 },
    ]);
    const next = reduceNodes(nodes, { type: 'messages-loaded', nodeIds: ['n1'], messagesByNode: byNode });
    expect(next.n1.messagesLoaded).toBe(true);
    expect(next.n1.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(next.n1.messageCount).toBe(2);
  });

  it('applyTreeMessages leaves untouched nodes by reference', () => {
    const other = placeholderNode({ nodeId: 'n2' });
    const nodes = { n1: placeholderNode(), n2: other };
    const next = applyTreeMessages(nodes, { n1: [] });
    expect(next.n1.messagesLoaded).toBe(true);   // n1 flipped (empty but loaded)
    expect(next.n2).toBe(other);                  // n2 identity preserved
  });

  it('a genuinely-empty node after load is distinguishable from a placeholder', () => {
    const nodes = { n1: placeholderNode() };
    const next = applyTreeMessages(nodes, { n1: [] });
    expect(next.n1.messagesLoaded).toBe(true);
    expect(next.n1.messages).toEqual([]);
  });
});

describe('digest staleness respects lazy load', () => {
  it('does not mark an unloaded source stale (would be a false positive)', () => {
    const digest = {
      sources: ['n1'], sourceFingerprints: { n1: 'realhash' },
      content: 'x', generatedAt: 1, viewedAt: 0, status: 'idle' as const,
    };
    // Placeholder source: empty trail would hash to something != 'realhash',
    // but the guard must skip it rather than report a false stale.
    const nodes = { n1: placeholderNode() };
    expect(staleSources(digest, nodes)).toEqual([]);
  });

  it('still marks a loaded source stale when its fingerprint changed', () => {
    const digest = {
      sources: ['n1'], sourceFingerprints: { n1: 'stalehash' },
      content: 'x', generatedAt: 1, viewedAt: 0, status: 'idle' as const,
    };
    const nodes = {
      n1: placeholderNode({
        messagesLoaded: true,
        messages: [{ id: 'm1', role: 'assistant', text: 'new content', toolCalls: [] }],
      }),
    };
    expect(staleSources(digest, nodes)).toEqual(['n1']);
  });
});
