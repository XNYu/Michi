import { describe, expect, it } from 'vitest';
import {
  accumulateWorkspaceDirtyDelta,
  buildExplicitWorkspaceCommands,
  emptyWorkspaceDirtyDelta,
} from './workspacePersistence';
import type { ChatNodeState, Project } from './chatTypes';

function fixture() {
  const project: Project = {
    id: 'ws-1', name: 'Workspace', chatIds: ['n1'], edges: [], createdAt: 1,
    trees: [{ id: 't1', rootNodeId: 'n1', createdAt: 1, lastActiveAt: 1 }],
    activeTreeId: 't1', artifacts: [],
  };
  const node: ChatNodeState = {
    nodeId: 'n1', kind: 'chat', chatId: null, projectId: 'ws-1', messages: [],
    followUps: [], status: 'idle',
  };
  return { project, nodes: { n1: node } };
}

describe('explicit workspace command projection', () => {
  it.each(['add', 'rename', 'remove'] as const)('persists a folder-only %s through workspace.upsert', (change) => {
    const { project, nodes } = fixture();
    const root = { id: 'root', path: '/workspace', addedAt: 1 };
    const extra = { id: 'extra', path: '/reference', label: 'Reference', addedAt: 2 };
    const prev: Project = { ...project, cwd: root.path, folders: change === 'add' ? [root] : [root, extra] };
    const folders = change === 'add' ? [root, extra]
      : change === 'rename' ? [root, { ...extra, label: 'Renamed reference' }]
        : [root];
    const cur: Project = { ...prev, folders };
    const delta = accumulateWorkspaceDirtyDelta(prev, cur, nodes, nodes, emptyWorkspaceDirtyDelta());

    const batch = buildExplicitWorkspaceCommands(cur, nodes, delta, new Map());

    expect(batch.commands.map((command) => command.type)).toEqual(['workspace.upsert']);
    expect(JSON.parse(String(batch.commands[0].payload.folders))).toEqual(folders);
    expect(batch.commands[0].payload.cwd).toBe(root.path);
  });

  it('scopes composer draft writes to the current window', () => {
    const { project, nodes } = fixture();
    nodes.n1.composerDraft = { value: 'unsent draft', mentions: [] };
    const delta = emptyWorkspaceDirtyDelta();
    delta.nodeIds.add('n1');
    const batch = buildExplicitWorkspaceCommands(project, nodes, delta, new Map(), 'window-a');
    for (const command of batch.commands) {
      expect(command.payload.composer_draft_window_id).toBe('window-a');
      expect(JSON.parse(String(command.payload.composer_draft)).value).toBe('unsent draft');
    }
  });
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

  it('indexes dirty edges and artifacts once instead of calling Array.find per id', () => {
    const { project, nodes } = fixture();
    let edgeFindCalls = 0;
    let contextFindCalls = 0;
    const edges = Array.from({ length: 8 }, (_, index) => ({
      source: 'n1',
      target: `n${index + 2}`,
      kind: 'branch' as const,
    }));
    const artifacts = Array.from({ length: 8 }, (_, index) => ({
      id: `c${index}`,
      name: `context-${index}`,
      filePath: `.artifacts/context-${index}.md`,
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
    project.artifacts = new Proxy(artifacts, {
      get(target, prop, receiver) {
        if (prop === 'find') contextFindCalls += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    const delta = emptyWorkspaceDirtyDelta();
    for (const edge of edges) delta.edgeUpsertIds.add(`${edge.kind}-${edge.source}-${edge.target}`);
    for (const context of artifacts) delta.contextUpsertIds.add(context.id);

    const result = buildExplicitWorkspaceCommands(project, nodes, delta, new Map());

    expect(edgeFindCalls).toBe(0);
    expect(contextFindCalls).toBe(0);
    expect(result.commands.filter((command) => command.type === 'edge.upsert')).toHaveLength(edges.length);
    expect(result.commands.filter((command) => command.type === 'context.upsert')).toHaveLength(artifacts.length);
  });

  it('writes a newer view mark as a patch of its own, after the upsert that creates the node', () => {
    const { project, nodes } = fixture();
    const reply = { id: 'a1', role: 'assistant' as const, text: 'Done', toolCalls: [] };
    const viewed = { n1: { ...nodes.n1, messages: [reply], viewedAt: 500 } };
    const delta = emptyWorkspaceDirtyDelta();
    delta.nodeIds.add('n1');
    const created = buildExplicitWorkspaceCommands(project, viewed, delta, new Map(), undefined, new Map());
    expect(created.commands.map((command) => command.type)).toEqual(['node.upsert', 'node.patch', 'node.patch']);
    expect(created.commands[2].payload).toEqual({ id: 'n1', viewed_at: 500 });
    expect(created.commands[0].payload).not.toHaveProperty('viewed_at');
    expect([...created.viewedAtUpdates]).toEqual([['n1', 500]]);

    const known = new Map(created.nodeProjectionUpdates);
    const again = buildExplicitWorkspaceCommands(project, viewed, delta, known, undefined, new Map([['n1', 500]]));
    expect(again.commands).toEqual([]);
    const later = buildExplicitWorkspaceCommands(project, { n1: { ...viewed.n1, viewedAt: 900 } }, delta, known, undefined, new Map([['n1', 500]]));
    expect(later.commands).toEqual([{ type: 'node.patch', payload: { id: 'n1', viewed_at: 900 } }]);
    const older = buildExplicitWorkspaceCommands(project, { n1: { ...viewed.n1, viewedAt: 400 } }, delta, known, undefined, new Map([['n1', 500]]));
    expect(older.commands).toEqual([]);
    expect(buildExplicitWorkspaceCommands(project, viewed, delta, known).commands).toEqual([]);
    const unanswered = { n1: { ...viewed.n1, messages: [], viewedAt: 900 } };
    expect(buildExplicitWorkspaceCommands(project, unanswered, delta, known, undefined, new Map([['n1', 500]])).commands).toEqual([]);
    const placeholder = { n1: { ...unanswered.n1, messagesLoaded: false, messageCount: 2 } };
    expect(buildExplicitWorkspaceCommands(project, placeholder, delta, known, undefined, new Map([['n1', 500]])).commands)
      .toEqual([{ type: 'node.patch', payload: { id: 'n1', viewed_at: 900 } }]);
  });
});
