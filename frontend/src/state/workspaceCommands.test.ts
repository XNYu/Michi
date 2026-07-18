import { describe, expect, it } from 'vitest';
import {
  buildExplicitWorkspaceCommands,
  emptyWorkspaceDirtyDelta,
} from './workspacePersistence';
import type { ChatNodeState, Project } from './chatTypes';

function fixture() {
  const project: Project = {
    id: 'ws-1', name: 'Workspace', chatIds: ['n1'], edges: [], createdAt: 1,
    trees: [{ id: 't1', rootNodeId: 'n1', createdAt: 1, lastActiveAt: 1 }],
    activeTreeId: 't1', contexts: [],
  };
  const node: ChatNodeState = {
    nodeId: 'n1', kind: 'chat', chatId: null, projectId: 'ws-1', messages: [],
    followUps: [], status: 'idle',
  };
  return { project, nodes: { n1: node } };
}

describe('explicit workspace command projection', () => {
  it('does not emit messages and suppresses repeated stream-only node changes', () => {
    const { project, nodes } = fixture();
    const delta = emptyWorkspaceDirtyDelta();
    delta.nodeIds.add('n1');
    expect('messageNodeIds' in delta).toBe(false);
    const first = buildExplicitWorkspaceCommands(project, nodes, delta, new Map());
    expect(first.commands.map((command) => command.type)).toEqual(['node.upsert', 'node.patch']);
    expect(first.commands.some((command) => 'messages' in command.payload)).toBe(false);

    const known = new Map(first.nodeProjectionUpdates);
    const streamedNodes = {
      n1: {
        ...nodes.n1,
        title: 'Canonical runtime title',
        status: 'streaming' as const,
        messages: [{ id: 'a1', role: 'assistant' as const, text: '', toolCalls: [], blocks: [], streaming: true }],
        followUps: ['Next?'],
        branchOverview: 'runtime-owned',
        lastAppliedTurnId: 'turn-1',
        lastAppliedSeq: 4,
      },
    };
    const second = buildExplicitWorkspaceCommands(project, streamedNodes, delta, known);
    expect(second.commands).toEqual([]);

    const manuallyRenamedNodes = {
      n1: {
        ...streamedNodes.n1,
        title: 'User rename',
        titleNeedsPersistence: true,
      },
    };
    const manual = buildExplicitWorkspaceCommands(project, manuallyRenamedNodes, delta, known);
    expect(manual.commands.map((command) => command.type)).toEqual(['node.upsert', 'node.patch']);
    expect(manual.commands[1].payload.title).toBe('User rename');
  });

  it('indexes dirty edges and contexts once instead of calling Array.find per id', () => {
    const { project, nodes } = fixture();
    let edgeFindCalls = 0;
    let contextFindCalls = 0;
    const edges = Array.from({ length: 8 }, (_, index) => ({
      source: 'n1',
      target: `n${index + 2}`,
      kind: 'branch' as const,
    }));
    const contexts = Array.from({ length: 8 }, (_, index) => ({
      id: `c${index}`,
      name: `context-${index}`,
      filePath: `.contexts/context-${index}.md`,
      type: 'doc' as const,
      source: 'user' as const,
      createdAt: index,
      updatedAt: index,
    }));
    project.edges = new Proxy(edges, {
      get(target, prop, receiver) {
        if (prop === 'find') edgeFindCalls += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    project.contexts = new Proxy(contexts, {
      get(target, prop, receiver) {
        if (prop === 'find') contextFindCalls += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    const delta = emptyWorkspaceDirtyDelta();
    for (const edge of edges) delta.edgeUpsertIds.add(`${edge.kind}-${edge.source}-${edge.target}`);
    for (const context of contexts) delta.contextUpsertIds.add(context.id);

    const result = buildExplicitWorkspaceCommands(project, nodes, delta, new Map());

    expect(edgeFindCalls).toBe(0);
    expect(contextFindCalls).toBe(0);
    expect(result.commands.filter((command) => command.type === 'edge.upsert')).toHaveLength(edges.length);
    expect(result.commands.filter((command) => command.type === 'context.upsert')).toHaveLength(contexts.length);
  });

  it('does not index edges or contexts for a node-only delta', () => {
    const { project, nodes } = fixture();
    const failOnScan = () => { throw new Error('unexpected collection scan'); };
    project.edges = new Proxy([], {
      get(target, prop, receiver) {
        if (prop === 'map' || prop === Symbol.iterator) return failOnScan;
        return Reflect.get(target, prop, receiver);
      },
    });
    project.contexts = new Proxy([], {
      get(target, prop, receiver) {
        if (prop === 'map' || prop === Symbol.iterator) return failOnScan;
        return Reflect.get(target, prop, receiver);
      },
    });
    const delta = emptyWorkspaceDirtyDelta();
    delta.nodeIds.add('n1');

    expect(() => buildExplicitWorkspaceCommands(project, nodes, delta, new Map())).not.toThrow();
  });
});
