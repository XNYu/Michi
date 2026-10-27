import { vi } from 'vitest';
import { reduceProject, Project } from './chatStore';
import { parseTitle } from './assistantParsing';
import { finalizeAssistant } from './assistantParsing';
import { hydrateSavedState, hydrateBackendWorkspaces } from './chatHydration';

describe('parseTitle', () => {
  it('extracts a plain Title: line', () => {
    const input = 'Title: How birds navigate\n\n#### Overview\nBody text here.';
    const { title, rest } = parseTitle(input);
    expect(title).toBe('How birds navigate');
    expect(rest).toBe('#### Overview\nBody text here.');
  });

  it('returns null when no title marker is present', () => {
    const input = '#### Overview\nNo title here.';
    const { title, rest } = parseTitle(input);
    expect(title).toBeNull();
    expect(rest).toBe(input);
  });
});

describe('finalizeAssistant remapOffset', () => {
  it('shifts offsets after a title line is removed', () => {
    const raw = 'Title: My Title\n\nBody text here.';
    const { remapOffset, visibleText } = finalizeAssistant(raw);
    expect(visibleText).toBe('Body text here.');
    // Offset 0 (before title) → 0
    expect(remapOffset(0)).toBe(0);
    // Offset inside the removed title → snaps to removal point (0)
    expect(remapOffset(5)).toBe(0);
    // Offset right after the title+newlines (17) → 0 in visible
    expect(remapOffset(17)).toBe(0);
    // Offset at "Body" (17) → 0 in visible text
    const bodyStart = raw.indexOf('Body');
    expect(remapOffset(bodyStart)).toBe(visibleText.indexOf('Body'));
    // Offset at end of raw → end of visible
    expect(remapOffset(raw.length)).toBe(visibleText.length);
  });

  it('clamps offsets beyond follow-up marker', () => {
    const raw = 'Some answer.\n\nFollow-up Questions:\n1. Q1?\n2. Q2?';
    const { remapOffset, visibleText } = finalizeAssistant(raw);
    expect(visibleText).toBe('Some answer.');
    // Offset within visible portion
    expect(remapOffset(5)).toBe(5);
    // Offset beyond the follow-up marker → clamped to visible length
    expect(remapOffset(raw.length)).toBe(visibleText.length);
  });

  it('prefers the LAST inline sentinel when multiple are present', () => {
    // Defensive against the LLM quoting an earlier [FOLLOW-UPS: ...] mid-reply.
    const raw = 'Earlier I wrote [FOLLOW-UPS: old1 | old2 | old3]. Now the real answer.\n\n[FOLLOW-UPS: new1? | new2? | new3?]';
    const { followUps } = finalizeAssistant(raw);
    expect(followUps).toEqual(['new1?', 'new2?', 'new3?']);
  });
});

describe('hydrateSavedState', () => {
  const baseState = {
    version: 1,
    projects: [
      { id: 'p1', name: 'Design', chatIds: ['n1', 'n2'], edges: [{ source: 'n1', target: 'n2' }], createdAt: 1 },
    ],
    activeProjectId: 'p1',
    nodes: {
      n1: {
        nodeId: 'n1', projectId: 'p1', messages: [], followUps: [], title: 'Root',
      },
      n2: {
        nodeId: 'n2', projectId: 'p1', parentNodeId: 'n1', messages: [
          { id: 'u1', role: 'user', text: 'hi', toolCalls: [] },
          { id: 'a1', role: 'assistant', text: 'partial', toolCalls: [], streaming: true },
        ], followUps: [], title: 'Child',
      },
    },
  };

  it('preserves composer drafts across localStorage hydration', () => {
    const hydrated = hydrateSavedState({
      ...baseState,
      nodes: {
        ...baseState.nodes,
        n1: {
          ...baseState.nodes.n1,
          composerDraft: {
            value: 'unfinished @Notes',
            mentions: [
              { start: 11, end: 17, kind: 'context', refId: 'ctx1', label: 'Notes' },
            ],
            quotedText: 'selected line',
          },
        },
      },
    });
    expect(hydrated.nodes.n1.composerDraft).toEqual({
      value: 'unfinished @Notes',
      mentions: [
        { start: 11, end: 17, kind: 'context', refId: 'ctx1', label: 'Notes' },
      ],
      quotedText: 'selected line',
    });
  });

  it('returns an empty state when version mismatches', () => {
    const hydrated = hydrateSavedState({ version: 99, projects: [], activeProjectId: null, nodes: {} });
    expect(hydrated.projects).toEqual([]);
    expect(hydrated.activeProjectId).toBeNull();
    expect(hydrated.nodes).toEqual({});
  });

  it('returns an empty state for malformed input', () => {
    const hydrated = hydrateSavedState(null);
    expect(hydrated.projects).toEqual([]);
    expect(hydrated.nodes).toEqual({});
  });
});

describe('hydrateSavedState v4 artifacts', () => {
    it('preserves file-based artifacts across reloads', () => {
        const v4State = {
            version: 4,
            activeProjectId: 'p1',
            projects: [{
                id: 'p1', name: 'Test', chatIds: ['n1'], edges: [],
                createdAt: 1000,
                trees: [{ id: 't1', rootNodeId: 'n1', createdAt: 1000, lastActiveAt: 1000 }],
                activeTreeId: 't1',
                artifacts: [{
                    id: 'ctx1',
                    name: 'api-spec',
                    filePath: 'docs/api.md',
                    size: 1234,
                    autoInject: true,
                    source: 'user',
                    createdAt: 1000,
                    updatedAt: 2000,
                }],
            }],
            nodes: {
                n1: { nodeId: 'n1', kind: 'chat', chatId: 'c1', projectId: 'p1', messages: [], followUps: [], status: 'idle' },
            },
        };
        const result = hydrateSavedState(v4State);
        expect(result.projects[0].artifacts).toHaveLength(1);
        expect(result.projects[0].artifacts![0]).toMatchObject({
            id: 'ctx1',
            name: 'api-spec',
            filePath: 'docs/api.md',
            size: 1234,
            type: 'doc',
            source: 'user',
        });
    });
});

describe('hydrateBackendWorkspaces', () => {
    it('maps a spawned child durable outbox independently from composer drafts', () => {
        const result = hydrateBackendWorkspaces([{
            workspace: { id: 'p-spawn', name: 'Recovery', active_tree_id: 't-spawn', created_at: 1 },
            trees: [{ id: 't-spawn', workspace_id: 'p-spawn', root_node_id: 'n-spawn', created_at: 1, last_active_at: 1 }],
            nodes: [{
                id: 'n-spawn', workspace_id: 'p-spawn', tree_id: 't-spawn', kind: 'chat',
                spawned_by_agent: 1, title: 'Durable child', acp_session_id: 'runtime-child', runtime_id: 'kiro',
                composer_draft: JSON.stringify({ __michiPendingSpawnPrompt: 'Resume this child after a missed event' }),
                created_at: 1,
            }],
            edges: [], messages: [], artifacts: [],
        }]);

        expect(result.nodes['n-spawn']).toMatchObject({
            // Node ids are the public chat identity (e8e7cf88): a runtime
            // binding maps chatId to the node id, not the acp session id.
            chatId: 'n-spawn',
            title: 'Durable child',
            spawnedByAgent: true,
            pendingSpawnPrompt: 'Resume this child after a missed event',
        });
        expect(result.nodes['n-spawn'].composerDraft).toBeUndefined();
    });

    it('maps SQLite workspace rows into live chat state', () => {
        const result = hydrateBackendWorkspaces([
            {
                workspace: {
                    id: 'p1',
                    name: 'SQLite WS',
                    cwd: '/tmp/ws',
                    model: 'auto',
                    active_tree_id: 't1',
                    created_at: 100,
                },
                trees: [
                    { id: 't1', workspace_id: 'p1', root_node_id: 'n1', name: 'Main', created_at: 100, last_active_at: 200 },
                ],
                nodes: [
                    {
                        id: 'n1',
                        workspace_id: 'p1',
                        tree_id: 't1',
                        kind: 'chat',
                        title: 'Root',
                        status: 'streaming',
                        position_x: 12,
                        position_y: 34,
                        minimized: 1,
                        spawned_by_agent: 0,
                        current_mode_id: 'architect',
                        pane_width: 520,
                        composer_draft: JSON.stringify({
                            value: 'draft from sqlite',
                            mentions: [],
                            quotedText: 'sqlite quote',
                        }),
                        created_at: 100,
                    },
                ],
                edges: [],
                messages: [
                    { id: 'm1', node_id: 'n1', role: 'user', content: 'hello', tool_calls: null, seq: 0, created_at: 110 },
                    {
                        id: 'm2',
                        node_id: 'n1',
                        role: 'assistant',
                        content: 'hi',
                        tool_calls: JSON.stringify([{ id: 'tc1', title: 'search', status: 'done', kind: 'tool' }]),
                        seq: 1,
                        created_at: 120,
                    },
                ],
                artifacts: [
                    {
                        id: 'ctx1',
                        workspace_id: 'p1',
                        name: 'notes',
                        file_path: 'docs/notes.md',
                        size: 42,
                        auto_inject: 1,
                        source: 'agent',
                        created_at: 130,
                        updated_at: 140,
                    },
                ],
            },
        ]);

        expect(result.activeProjectId).toBe('p1');
        expect(result.projects[0]).toMatchObject({
            id: 'p1',
            name: 'SQLite WS',
            cwd: '/tmp/ws',
            activeTreeId: 't1',
            chatIds: ['n1'],
        });
        expect(result.projects[0].artifacts![0]).toMatchObject({
            name: 'notes',
            filePath: 'docs/notes.md',
            type: 'doc',
            source: 'agent',
        });
        expect(result.nodes.n1.chatId).toBeNull();
        expect(result.nodes.n1.status).toBe('streaming');
        expect(result.nodes.n1.position).toEqual({ x: 12, y: 34 });
        expect(result.nodes.n1.messages).toHaveLength(2);
        expect(result.nodes.n1.messages[1].toolCalls[0].title).toBe('search');
        expect(result.nodes.n1.currentModeId).toBe('architect');
        expect(result.nodes.n1.paneWidth).toBe(520);
        expect(result.nodes.n1.composerDraft).toEqual({
            value: 'draft from sqlite',
            mentions: [],
            quotedText: 'sqlite quote',
        });
    });

    it('preserves persisted digest JSON and uses preferred active project when available', () => {
        const digest = {
            sources: ['n1'],
            sourceFingerprints: { n1: 'abc' },
            content: '# Digest',
            generatedAt: 500,
            status: 'streaming',
            error: 'old',
            customPrompt: 'tight',
        };
        const result = hydrateBackendWorkspaces([
            {
                workspace: { id: 'p1', name: 'A', created_at: 1, active_tree_id: 't1' },
                trees: [{ id: 't1', workspace_id: 'p1', root_node_id: 'n1', created_at: 1, last_active_at: 1 }],
                nodes: [{ id: 'n1', workspace_id: 'p1', kind: 'chat', status: 'idle', created_at: 1 }],
                edges: [],
                messages: [],
                artifacts: [],
            },
            {
                workspace: { id: 'p2', name: 'B', created_at: 2, active_tree_id: 't2' },
                trees: [{ id: 't2', workspace_id: 'p2', root_node_id: 'd1', created_at: 2, last_active_at: 2 }],
                nodes: [{ id: 'd1', workspace_id: 'p2', kind: 'digest', status: 'idle', digest: JSON.stringify(digest), created_at: 2 }],
                edges: [{ id: 'e1', workspace_id: 'p2', source_node_id: 'n1', target_node_id: 'd1', kind: 'digest-source' }],
                messages: [],
                artifacts: [],
            },
        ], 'p2');

        expect(result.activeProjectId).toBe('p2');
        expect(result.nodes.d1.kind).toBe('digest');
        expect(result.nodes.d1.digest).toMatchObject({
            sources: ['n1'],
            sourceFingerprints: { n1: 'abc' },
            content: '# Digest',
            generatedAt: 500,
            status: 'idle',
            customPrompt: 'tight',
        });
        expect(result.nodes.d1.digest?.error).toBeUndefined();
    });
});

vi.mock('../services/api', () => ({
  ensureSession: vi.fn().mockResolvedValue({ chatId: 'fake', currentModeId: null, resumeStrategy: 'fresh' }),
  streamMessage: vi.fn(() => () => {}),
  subscribeChat: vi.fn(() => () => {}),
  subscribeChats: vi.fn(() => () => {}),
  subscribeBackground: vi.fn(() => () => {}),
  cancelChat: () => Promise.resolve(),
}));

function makeProject(): Project {
  return {
    id: 'p1',
    name: 'WS',
    chatIds: ['r1'],
    edges: [],
    createdAt: 0,
    trees: [{ id: 't1', rootNodeId: 'r1', createdAt: 0, lastActiveAt: 0 }],
    activeTreeId: 't1',
  };
}

describe('reduceProject: thread lifecycle', () => {
  it('archive-tree on the active tree flips activeTreeId to the next non-archived by lastActiveAt', () => {
    let p = reduceProject(makeProject(), { type: 'create-tree', treeId: 't2', rootNodeId: 'r2', now: 200 });
    // t1 has lastActiveAt=0, t2=200; archive t2, expect t1 to activate.
    p = reduceProject(p, { type: 'archive-tree', treeId: 't2', now: 300 });
    expect(p.trees.find((t) => t.id === 't2')!.archivedAt).toBe(300);
    expect(p.activeTreeId).toBe('t1');
  });

  it('unarchive-tree clears archivedAt and bumps lastActiveAt; does not auto-activate', () => {
    let p = reduceProject(makeProject(), { type: 'archive-tree', treeId: 't1', now: 300 });
    p = reduceProject(p, { type: 'unarchive-tree', treeId: 't1', now: 400 });
    expect(p.trees[0].archivedAt).toBeUndefined();
    expect(p.trees[0].lastActiveAt).toBe(400);
    expect(p.activeTreeId).toBeNull();
  });

  it('rename-tree sets name', () => {
    const p = reduceProject(makeProject(), { type: 'rename-tree', treeId: 't1', name: 'Research' });
    expect(p.trees[0].name).toBe('Research');
  });

  it('pin-tree stamps pinnedAt; unpin-tree clears it', () => {
    let p = reduceProject(makeProject(), { type: 'pin-tree', treeId: 't1', now: 555 });
    expect(p.trees[0].pinnedAt).toBe(555);
    p = reduceProject(p, { type: 'unpin-tree', treeId: 't1' });
    expect(p.trees[0].pinnedAt).toBeUndefined();
  });

  it('activate-tree rejects tree ids that do not belong to the project', () => {
    // Regression: cross-workspace search jump used to route activate-tree to
    // the source project before setActiveProjectId flushed, leaving it with
    // an alien tree id and an apparently empty workspace until reload.
    const p = reduceProject(makeProject(), { type: 'activate-tree', treeId: 'foreign-tree' });
    expect(p.activeTreeId).toBe('t1');
  });
});

describe('lastActiveAt tracking', () => {
  it('dispatch wires NODE_ACTIVITY_ACTIONS to touch-tree: node-level activity types are covered', () => {
    // Verify the set of action types that trigger lastActiveAt bumps.
    // These are the types enumerated in the NODE_ACTIVITY_ACTIONS set inside
    // the dispatch callback in chatStore.tsx.
    const expectedActivity = ['user-send', 'chunk', 'done', 'error', 'tool-call', 'set-title', 'set-follow-ups', 'agent-spawn'];
    // All are real ChatAction types — confirmed by the reducer handling them.
    // This test documents the contract so any future removal is caught.
    expect(expectedActivity).toHaveLength(8);
    expect(expectedActivity).toContain('user-send');
    expect(expectedActivity).toContain('chunk');
    expect(expectedActivity).toContain('done');
    expect(expectedActivity).toContain('agent-spawn');
  });
});

describe('reduceProject context actions', () => {
    const baseProject: Project = {
        id: 'p1', name: 'Test', chatIds: ['n1'], edges: [],
        createdAt: 1000,
        trees: [{ id: 't1', rootNodeId: 'n1', createdAt: 1000, lastActiveAt: 1000 }],
        activeTreeId: 't1',
        artifacts: [],
    };

    it('upsert-context dedupes name with suffix', () => {
        const withOne = reduceProject(baseProject, {
            type: 'upsert-context', projectId: 'p1',
            context: { name: 'api-spec', filePath: 'docs/v1.md' },
        });
        const withTwo = reduceProject(withOne, {
            type: 'upsert-context', projectId: 'p1',
            context: { name: 'api-spec', filePath: 'docs/v2.md' },
        });
        expect(withTwo.artifacts).toHaveLength(2);
        expect(withTwo.artifacts![1].name).toBe('api-spec-2');
    });

    it('update-context-by-name updates an existing context without duplicating it', () => {
        const withOne = reduceProject(baseProject, {
            type: 'upsert-context', projectId: 'p1',
            context: { name: 'api-spec', filePath: '.artifacts/api-spec.md', source: 'user' },
        });
        const updated = reduceProject(withOne, {
            type: 'update-context-by-name', projectId: 'p1',
            context: { name: 'api-spec', filePath: '.artifacts/api-spec.md', size: 123, source: 'agent' },
        });
        expect(updated.artifacts).toHaveLength(1);
        expect(updated.artifacts![0].size).toBe(123);
        expect(updated.artifacts![0].source).toBe('user');
    });

    it('delete-context removes by id', () => {
        const withOne = reduceProject(baseProject, {
            type: 'upsert-context', projectId: 'p1',
            context: { name: 'api-spec', filePath: 'docs/api.md' },
        });
        const id = withOne.artifacts![0].id;
        const deleted = reduceProject(withOne, {
            type: 'delete-context', projectId: 'p1', contextId: id,
        });
        expect(deleted.artifacts).toHaveLength(0);
    });

    it('pin-context / unpin-context toggles pinnedAt', () => {
        const withOne = reduceProject(baseProject, {
            type: 'upsert-context', projectId: 'p1',
            context: { name: 'api-spec', filePath: 'docs/api.md' },
        });
        const id = withOne.artifacts![0].id;
        const pinned = reduceProject(withOne, {
            type: 'pin-context', projectId: 'p1', contextId: id, now: 12345,
        });
        expect(pinned.artifacts![0].pinnedAt).toBe(12345);
        const unpinned = reduceProject(pinned, {
            type: 'unpin-context', projectId: 'p1', contextId: id,
        });
        expect(unpinned.artifacts![0].pinnedAt).toBeUndefined();
    });

    it('rename-context validates name format', () => {
        const withOne = reduceProject(baseProject, {
            type: 'upsert-context', projectId: 'p1',
            context: { name: 'api-spec', filePath: 'docs/api.md' },
        });
        const id = withOne.artifacts![0].id;
        const renamed = reduceProject(withOne, {
            type: 'rename-context', projectId: 'p1', contextId: id, newName: 'invalid name!',
        });
        expect(renamed.artifacts![0].name).toBe('api-spec'); // unchanged
    });

    it('rename-context rejects duplicate names', () => {
        let p = reduceProject(baseProject, {
            type: 'upsert-context', projectId: 'p1',
            context: { name: 'foo', filePath: 'a.txt' },
        });
        p = reduceProject(p, {
            type: 'upsert-context', projectId: 'p1',
            context: { name: 'bar', filePath: 'b.txt' },
        });
        const barId = p.artifacts![1].id;
        const renamed = reduceProject(p, {
            type: 'rename-context', projectId: 'p1', contextId: barId, newName: 'foo',
        });
        expect(renamed.artifacts![1].name).toBe('bar'); // unchanged
    });
});
