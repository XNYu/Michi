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
    delta.messageNodeIds.add('n1');
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
});
