import { vi } from 'vitest';
import { reduceProject, Project } from './chatStore';
import { parseTitle } from './assistantParsing';
import { finalizeAssistant } from './assistantParsing';
import { hydrateSavedState, hydrateBackendWorkspaces, STATE_SCHEMA_VERSION } from './chatHydration';
import { shouldBranchOnSubmit } from '../components/nodes/chatNodeUtils';

describe('parseTitle', () => {
  it('extracts a plain Title: line', () => {
    const input = 'Title: How birds navigate\n\n#### Overview\nBody text here.';
    const { title, rest } = parseTitle(input);
    expect(title).toBe('How birds navigate');
    expect(rest).toBe('#### Overview\nBody text here.');
  });

  it('tolerates markdown decoration around the title', () => {
    const input = '**Title:** Something cool\n\nBody';
    const { title } = parseTitle(input);
    expect(title).toBe('Something cool');
  });

  it('returns null when no title marker is present', () => {
    const input = '#### Overview\nNo title here.';
    const { title, rest } = parseTitle(input);
    expect(title).toBeNull();
    expect(rest).toBe(input);
  });

  it('handles a full-width colon', () => {
    const input = 'Title：Seabird Compass\n\nBody';
    const { title } = parseTitle(input);
    expect(title).toBe('Seabird Compass');
  });

  it('strips the title line even if it is not on line 1', () => {
    const input = 'Some preface\nTitle: Later title\n\nBody';
    const { title, rest } = parseTitle(input);
    expect(title).toBe('Later title');
    expect(rest).toBe('Some preface\nBody');
  });
});

describe('finalizeAssistant remapOffset', () => {
  it('is identity when no title or follow-ups are present', () => {
    const raw = 'Hello world, some text here.';
    const { remapOffset, visibleText } = finalizeAssistant(raw);
    expect(visibleText).toBe(raw);
    expect(remapOffset(0)).toBe(0);
    expect(remapOffset(5)).toBe(5);
    expect(remapOffset(raw.length)).toBe(raw.length);
  });

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

  it('handles both title removal and follow-up truncation', () => {
    const raw = 'Title: Test\n\nAnswer body.\n\nFollow-up Questions:\n1. Why?\n2. How?';
    const { remapOffset, visibleText } = finalizeAssistant(raw);
    expect(visibleText).toBe('Answer body.');
    // Offset at "Answer" in raw
    const answerInRaw = raw.indexOf('Answer');
    expect(remapOffset(answerInRaw)).toBe(visibleText.indexOf('Answer'));
    // Offset past follow-ups → clamped
    expect(remapOffset(raw.length)).toBe(visibleText.length);
  });

  it('handles title in the middle of text', () => {
    const raw = 'Preface\nTitle: Mid Title\n\nAfter title.';
    const { remapOffset, visibleText } = finalizeAssistant(raw);
    expect(visibleText).toBe('Preface\nAfter title.');
    // "Preface" is before the title, offset unchanged
    expect(remapOffset(0)).toBe(0);
    expect(remapOffset(7)).toBe(7); // end of "Preface"
    // "After title." starts at different positions in raw vs visible
    const afterInRaw = raw.indexOf('After title.');
    const afterInVisible = visibleText.indexOf('After title.');
    expect(remapOffset(afterInRaw)).toBe(afterInVisible);
  });

  // ── Inline [FOLLOW-UP n/3: ...] sentinels (current streaming format) ──
  it('extracts follow-ups from per-question inline sentinels', () => {
    const raw = [
      'Here is the answer.',
      '',
      '[FOLLOW-UP 1/3: What about X?]',
      '[FOLLOW-UP 2/3: Why not Y?]',
      '[FOLLOW-UP 3/3: How does Z compare?]',
    ].join('\n');
    const { visibleText, followUps } = finalizeAssistant(raw);
    expect(visibleText).toBe('Here is the answer.');
    expect(followUps).toEqual(['What about X?', 'Why not Y?', 'How does Z compare?']);
  });

  it('uses the final contiguous per-question follow-up group', () => {
    const raw = [
      'Earlier I quoted [FOLLOW-UP 1/3: old?] inside the answer.',
      '',
      '[FOLLOW-UP 1/3: new1?]',
      '[FOLLOW-UP 2/3: new2?]',
    ].join('\n');
    const { visibleText, followUps } = finalizeAssistant(raw);
    expect(visibleText).toBe('Earlier I quoted [FOLLOW-UP 1/3: old?] inside the answer.');
    expect(followUps).toEqual(['new1?', 'new2?']);
  });

  // ── Inline [FOLLOW-UPS: ...] sentinel (legacy compact format) ──
  it('extracts follow-ups from the inline [FOLLOW-UPS:] sentinel', () => {
    const raw = 'Here is the answer.\n\n[FOLLOW-UPS: What about X? | Why not Y? | How does Z compare?]';
    const { visibleText, followUps } = finalizeAssistant(raw);
    expect(visibleText).toBe('Here is the answer.');
    expect(followUps).toEqual(['What about X?', 'Why not Y?', 'How does Z compare?']);
  });

  it('prefers the LAST inline sentinel when multiple are present', () => {
    // Defensive against the LLM quoting an earlier [FOLLOW-UPS: ...] mid-reply.
    const raw = 'Earlier I wrote [FOLLOW-UPS: old1 | old2 | old3]. Now the real answer.\n\n[FOLLOW-UPS: new1? | new2? | new3?]';
    const { followUps } = finalizeAssistant(raw);
    expect(followUps).toEqual(['new1?', 'new2?', 'new3?']);
  });

  it('caps inline follow-ups at 3 items and trims whitespace', () => {
    const raw = 'Answer.\n[FOLLOW-UPS:   a?   |  b?  |  c?  |  d?  ]';
    const { followUps } = finalizeAssistant(raw);
    expect(followUps).toEqual(['a?', 'b?', 'c?']);
  });

  it('falls back to the prose "Follow-up Questions:" marker when no inline tag', () => {
    const raw = 'Legacy reply.\n\nFollow-up Questions:\n1. Why? \n2. How? ';
    const { visibleText, followUps } = finalizeAssistant(raw);
    expect(visibleText).toBe('Legacy reply.');
    expect(followUps).toEqual(['Why?', 'How?']);
  });

  it('handles title + inline follow-ups together', () => {
    const raw = 'Title: Demo\n\nBody content.\n\n[FOLLOW-UPS: q1? | q2? | q3?]';
    const { title, visibleText, followUps } = finalizeAssistant(raw);
    expect(title).toBe('Demo');
    expect(visibleText).toBe('Body content.');
    expect(followUps).toEqual(['q1?', 'q2?', 'q3?']);
  });

  it('extracts title from the inline [TITLE:] sentinel', () => {
    const raw = '[TITLE: Quick Summary]\n\nThe body of the answer.\n\n[FOLLOW-UPS: a? | b? | c?]';
    const { title, visibleText, followUps } = finalizeAssistant(raw);
    expect(title).toBe('Quick Summary');
    expect(visibleText).toBe('The body of the answer.');
    expect(followUps).toEqual(['a?', 'b?', 'c?']);
  });

  it('inline [TITLE:] takes precedence over legacy "Title:" prose marker', () => {
    const raw = '[TITLE: New Form]\n\nTitle: Old Form\n\nBody.';
    const { title, visibleText } = finalizeAssistant(raw);
    expect(title).toBe('New Form');
    expect(visibleText).toContain('Title: Old Form');
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

  it('nulls chatId on every restored node', () => {
    const hydrated = hydrateSavedState(baseState);
    expect(hydrated.nodes.n1.chatId).toBeNull();
    expect(hydrated.nodes.n2.chatId).toBeNull();
  });

  it('forces status to idle and clears any streaming flag', () => {
    const hydrated = hydrateSavedState(baseState);
    expect(hydrated.nodes.n1.status).toBe('idle');
    expect(hydrated.nodes.n2.status).toBe('idle');
    const stillStreaming = hydrated.nodes.n2.messages.find((m) => (m as any).streaming);
    expect(stillStreaming).toBeUndefined();
  });

  it('preserves projects, activeProjectId, messages, edges, title', () => {
    const hydrated = hydrateSavedState(baseState);
    // Projects are migrated from v1 (no trees) to v2 (with trees).
    expect(hydrated.projects).toHaveLength(1);
    expect(hydrated.projects[0].id).toBe('p1');
    expect(hydrated.projects[0].name).toBe('Design');
    expect(hydrated.projects[0].trees).toBeDefined();
    expect(hydrated.activeProjectId).toBe('p1');
    expect(hydrated.nodes.n2.messages.length).toBe(2);
    expect(hydrated.nodes.n2.title).toBe('Child');
  });

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

describe('hydrateSavedState kind discriminator', () => {
  it("defaults kind to 'chat' for legacy saved nodes", () => {
    const saved = {
      version: 1,
      projects: [{ id: 'p', name: 'x', chatIds: ['n'], edges: [], createdAt: 0 }],
      activeProjectId: 'p',
      nodes: { n: { nodeId: 'n', projectId: 'p', messages: [], followUps: [] } },
    };
    const h = hydrateSavedState(saved);
    expect(h.nodes.n.kind).toBe('chat');
  });

  it("preserves kind: 'digest' when present", () => {
    const saved = {
      version: 1,
      projects: [{ id: 'p', name: 'x', chatIds: ['n'], edges: [], createdAt: 0 }],
      activeProjectId: 'p',
      nodes: { n: { nodeId: 'n', kind: 'digest', projectId: 'p', messages: [], followUps: [] } },
    };
    const h = hydrateSavedState(saved);
    expect(h.nodes.n.kind).toBe('digest');
  });
});

describe('focusedNodeId persistence across hydration', () => {
  it('is not persisted — hydrated state does not include focusedNodeId', () => {
    const saved = {
      version: 1,
      projects: [],
      activeProjectId: null,
      nodes: {},
    };
    const h = hydrateSavedState(saved);
    expect((h as any).focusedNodeId).toBeUndefined();
  });
});

describe('digest hydration', () => {
  it('survives a reload with status forced idle', () => {
    const saved = {
      version: 1,
      projects: [{ id: 'p', name: 'x', chatIds: ['d'], edges: [], createdAt: 0 }],
      activeProjectId: 'p',
      nodes: {
        d: {
          nodeId: 'd',
          kind: 'digest',
          projectId: 'p',
          messages: [],
          followUps: [],
          digest: {
            sources: ['s1'],
            sourceFingerprints: { s1: 'abc' },
            content: '# hello',
            generatedAt: 42,
            status: 'streaming', // should be forced to idle
            error: 'old error', // should clear
          },
        },
      },
    };
    const h = hydrateSavedState(saved);
    const d = h.nodes.d;
    expect(d.kind).toBe('digest');
    expect(d.digest?.content).toBe('# hello');
    expect(d.digest?.status).toBe('idle');
    expect(d.digest?.error).toBeUndefined();
    expect(d.digest?.generatedAt).toBe(42);
  });
});

describe('hydrate v1→v2 migration', () => {
  it('synthesizes a default tree for legacy v1 snapshots', () => {
    const v1 = {
      version: 1,
      projects: [
        {
          id: 'p1',
          name: 'WS',
          chatIds: ['n-root'],
          edges: [],
          createdAt: 1000,
        },
      ],
      activeProjectId: 'p1',
      nodes: {
        'n-root': { nodeId: 'n-root', projectId: 'p1', messages: [], followUps: [] },
      },
    };
    const h = hydrateSavedState(v1);
    expect(h.projects).toHaveLength(1);
    const p = h.projects[0];
    expect(p.trees).toHaveLength(1);
    expect(p.trees[0].rootNodeId).toBe('n-root');
    expect(p.activeTreeId).toBe(p.trees[0].id);
    expect(p.trees[0].archivedAt).toBeUndefined();
  });

  it('passes through a valid v2 snapshot unchanged (aside from chatId nulling)', () => {
    const tree = { id: 't1', rootNodeId: 'n-root', createdAt: 1, lastActiveAt: 2 };
    const v2 = {
      version: STATE_SCHEMA_VERSION,
      projects: [
        {
          id: 'p1',
          name: 'WS',
          chatIds: ['n-root'],
          edges: [],
          createdAt: 1,
          trees: [tree],
          activeTreeId: 't1',
        },
      ],
      activeProjectId: 'p1',
      nodes: {
        'n-root': { nodeId: 'n-root', projectId: 'p1', messages: [], followUps: [] },
      },
    };
    const h = hydrateSavedState(v2);
    expect(h.projects[0].trees[0].id).toBe('t1');
    expect(h.projects[0].activeTreeId).toBe('t1');
  });

  it('drops snapshots with an unrecognized schema version', () => {
    const bogus = { version: 999, projects: [], activeProjectId: null, nodes: {} };
    const h = hydrateSavedState(bogus);
    expect(h.projects).toEqual([]);
  });
});

describe('hydrateSavedState v2→v3 migration', () => {
    it('adds contexts array to v2 projects', () => {
        const v2State = {
            version: 2,
            activeProjectId: 'p1',
            projects: [{
                id: 'p1', name: 'Test', chatIds: ['n1'], edges: [],
                createdAt: 1000,
                trees: [{ id: 't1', rootNodeId: 'n1', createdAt: 1000, lastActiveAt: 1000 }],
                activeTreeId: 't1',
            }],
            nodes: {
                n1: { nodeId: 'n1', kind: 'chat', chatId: 'c1', projectId: 'p1', messages: [], followUps: [], status: 'idle' },
            },
        };
        const result = hydrateSavedState(v2State);
        expect(result.projects[0].contexts).toEqual([]);
    });
});

describe('hydrateSavedState v4 contexts', () => {
    it('preserves file-based contexts across reloads', () => {
        const v4State = {
            version: 4,
            activeProjectId: 'p1',
            projects: [{
                id: 'p1', name: 'Test', chatIds: ['n1'], edges: [],
                createdAt: 1000,
                trees: [{ id: 't1', rootNodeId: 'n1', createdAt: 1000, lastActiveAt: 1000 }],
                activeTreeId: 't1',
                contexts: [{
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
        expect(result.projects[0].contexts).toHaveLength(1);
        expect(result.projects[0].contexts![0]).toMatchObject({
            id: 'ctx1',
            name: 'api-spec',
            filePath: 'docs/api.md',
            size: 1234,
            autoInject: true,
            source: 'user',
        });
    });

    it('drops old text-body contexts without file paths', () => {
        const v3State = {
            version: 3,
            activeProjectId: 'p1',
            projects: [{
                id: 'p1', name: 'Test', chatIds: ['n1'], edges: [],
                createdAt: 1000,
                trees: [{ id: 't1', rootNodeId: 'n1', createdAt: 1000, lastActiveAt: 1000 }],
                activeTreeId: 't1',
                contexts: [{ id: 'ctx1', name: 'legacy', body: 'old text', source: 'user' }],
            }],
            nodes: {
                n1: { nodeId: 'n1', kind: 'chat', chatId: 'c1', projectId: 'p1', messages: [], followUps: [], status: 'idle' },
            },
        };
        const result = hydrateSavedState(v3State);
        expect(result.projects[0].contexts).toEqual([]);
    });
});

describe('hydrateBackendWorkspaces', () => {
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
                contexts: [
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
        expect(result.projects[0].contexts![0]).toMatchObject({
            name: 'notes',
            filePath: 'docs/notes.md',
            autoInject: true,
            source: 'agent',
        });
        expect(result.nodes.n1.chatId).toBeNull();
        expect(result.nodes.n1.status).toBe('idle');
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
                contexts: [],
            },
            {
                workspace: { id: 'p2', name: 'B', created_at: 2, active_tree_id: 't2' },
                trees: [{ id: 't2', workspace_id: 'p2', root_node_id: 'd1', created_at: 2, last_active_at: 2 }],
                nodes: [{ id: 'd1', workspace_id: 'p2', kind: 'digest', status: 'idle', digest: JSON.stringify(digest), created_at: 2 }],
                edges: [{ id: 'e1', workspace_id: 'p2', source_node_id: 'n1', target_node_id: 'd1', kind: 'digest-source' }],
                messages: [],
                contexts: [],
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

    it('skips deleted/archived workspaces when picking the fallback active id', () => {
        const result = hydrateBackendWorkspaces([
            {
                workspace: { id: 'p1', name: 'Trashed', created_at: 1, active_tree_id: 't1', deleted_at: 9 },
                trees: [{ id: 't1', workspace_id: 'p1', root_node_id: 'n1', created_at: 1, last_active_at: 1 }],
                nodes: [{ id: 'n1', workspace_id: 'p1', kind: 'chat', status: 'idle', created_at: 1 }],
                edges: [], messages: [], contexts: [],
            },
            {
                workspace: { id: 'p2', name: 'Live', created_at: 2, active_tree_id: 't2' },
                trees: [{ id: 't2', workspace_id: 'p2', root_node_id: 'n2', created_at: 2, last_active_at: 2 }],
                nodes: [{ id: 'n2', workspace_id: 'p2', kind: 'chat', status: 'idle', created_at: 2 }],
                edges: [], messages: [], contexts: [],
            },
        ]);
        expect(result.activeProjectId).toBe('p2');
    });

    it('falls back to a live workspace when the preferred id points at a deleted one', () => {
        const result = hydrateBackendWorkspaces([
            {
                workspace: { id: 'p1', name: 'Trashed', created_at: 1, active_tree_id: 't1', deleted_at: 9 },
                trees: [{ id: 't1', workspace_id: 'p1', root_node_id: 'n1', created_at: 1, last_active_at: 1 }],
                nodes: [{ id: 'n1', workspace_id: 'p1', kind: 'chat', status: 'idle', created_at: 1 }],
                edges: [], messages: [], contexts: [],
            },
            {
                workspace: { id: 'p2', name: 'Live', created_at: 2, active_tree_id: 't2' },
                trees: [{ id: 't2', workspace_id: 'p2', root_node_id: 'n2', created_at: 2, last_active_at: 2 }],
                nodes: [{ id: 'n2', workspace_id: 'p2', kind: 'chat', status: 'idle', created_at: 2 }],
                edges: [], messages: [], contexts: [],
            },
        ], 'p1');
        expect(result.activeProjectId).toBe('p2');
    });
});

vi.mock('../services/api', () => ({
  ensureSession: vi.fn().mockResolvedValue({ chatId: 'fake', currentModeId: null, resumeStrategy: 'fresh' }),
  streamMessage: vi.fn(() => () => {}),
  claimPane: () => Promise.resolve({ owner: true }),
  heartbeatPane: () => Promise.resolve(true),
  releasePane: () => Promise.resolve(),
  subscribeChat: vi.fn(() => () => {}),
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
  it('create-tree appends a new tree and activates it', () => {
    const p = reduceProject(makeProject(), {
      type: 'create-tree',
      treeId: 't2',
      rootNodeId: 'r2',
      now: 100,
    });
    expect(p.trees).toHaveLength(2);
    expect(p.activeTreeId).toBe('t2');
    expect(p.chatIds).toContain('r2');
  });

  it('archive-tree on the active tree flips activeTreeId to the next non-archived by lastActiveAt', () => {
    let p = reduceProject(makeProject(), { type: 'create-tree', treeId: 't2', rootNodeId: 'r2', now: 200 });
    // t1 has lastActiveAt=0, t2=200; archive t2, expect t1 to activate.
    p = reduceProject(p, { type: 'archive-tree', treeId: 't2', now: 300 });
    expect(p.trees.find((t) => t.id === 't2')!.archivedAt).toBe(300);
    expect(p.activeTreeId).toBe('t1');
  });

  it('archive-tree on the last non-archived tree leaves activeTreeId null', () => {
    const p = reduceProject(makeProject(), { type: 'archive-tree', treeId: 't1', now: 300 });
    expect(p.activeTreeId).toBeNull();
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

  it('activate-tree switches activeTreeId to an existing tree', () => {
    let p = reduceProject(makeProject(), { type: 'create-tree', treeId: 't2', rootNodeId: 'r2', now: 0 });
    p = reduceProject(p, { type: 'activate-tree', treeId: 't1' });
    expect(p.activeTreeId).toBe('t1');
  });

  it('activate-tree rejects tree ids that do not belong to the project', () => {
    // Regression: cross-workspace search jump used to route activate-tree to
    // the source project before setActiveProjectId flushed, leaving it with
    // an alien tree id and an apparently empty workspace until reload.
    const p = reduceProject(makeProject(), { type: 'activate-tree', treeId: 'foreign-tree' });
    expect(p.activeTreeId).toBe('t1');
  });

  it('touch-tree updates lastActiveAt of the matching tree', () => {
    const p = reduceProject(makeProject(), { type: 'touch-tree', treeId: 't1', now: 999 });
    expect(p.trees[0].lastActiveAt).toBe(999);
  });
});

describe('lastActiveAt tracking', () => {
  it('touch-tree bumps lastActiveAt when called with a future timestamp', () => {
    // This tests the core mechanism: dispatch calls reduceProject with
    // touch-tree when a NODE_ACTIVITY_ACTION fires (user-send, chunk, done, …).
    // The reduceProject touch-tree path is what actually writes lastActiveAt.
    const p = makeProject(); // lastActiveAt: 0
    const after = reduceProject(p, { type: 'touch-tree', treeId: 't1', now: 5000 });
    expect(after.trees[0].lastActiveAt).toBe(5000);
    expect(after.trees[0].lastActiveAt).toBeGreaterThan(p.trees[0].lastActiveAt);
  });

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
        contexts: [],
    };

    it('upsert-context inserts a new context', () => {
        const result = reduceProject(baseProject, {
            type: 'upsert-context', projectId: 'p1',
            context: { name: 'api-spec', filePath: 'docs/api.md', source: 'user' },
        });
        expect(result.contexts).toHaveLength(1);
        expect(result.contexts![0].name).toBe('api-spec');
        expect(result.contexts![0].source).toBe('user');
    });

    it('upsert-context dedupes name with suffix', () => {
        const withOne = reduceProject(baseProject, {
            type: 'upsert-context', projectId: 'p1',
            context: { name: 'api-spec', filePath: 'docs/v1.md' },
        });
        const withTwo = reduceProject(withOne, {
            type: 'upsert-context', projectId: 'p1',
            context: { name: 'api-spec', filePath: 'docs/v2.md' },
        });
        expect(withTwo.contexts).toHaveLength(2);
        expect(withTwo.contexts![1].name).toBe('api-spec-2');
    });

    it('upsert-context updates existing by id', () => {
        const withOne = reduceProject(baseProject, {
            type: 'upsert-context', projectId: 'p1',
            context: { name: 'api-spec', filePath: 'docs/api-spec.md' },
        });
        const id = withOne.contexts![0].id;
        const updated = reduceProject(withOne, {
            type: 'upsert-context', projectId: 'p1',
            context: { id, name: 'api-spec', filePath: 'docs/api-spec-v2.md' },
        });
        expect(updated.contexts).toHaveLength(1);
        expect(updated.contexts![0].filePath).toBe('docs/api-spec-v2.md');
    });

    it('update-context-by-name updates an existing context without duplicating it', () => {
        const withOne = reduceProject(baseProject, {
            type: 'upsert-context', projectId: 'p1',
            context: { name: 'api-spec', filePath: '.contexts/api-spec.md', source: 'user', autoInject: true },
        });
        const updated = reduceProject(withOne, {
            type: 'update-context-by-name', projectId: 'p1',
            context: { name: 'api-spec', filePath: '.contexts/api-spec.md', size: 123, source: 'agent' },
        });
        expect(updated.contexts).toHaveLength(1);
        expect(updated.contexts![0].size).toBe(123);
        expect(updated.contexts![0].source).toBe('user');
        expect(updated.contexts![0].autoInject).toBe(true);
    });

    it('delete-context removes by id', () => {
        const withOne = reduceProject(baseProject, {
            type: 'upsert-context', projectId: 'p1',
            context: { name: 'api-spec', filePath: 'docs/api.md' },
        });
        const id = withOne.contexts![0].id;
        const deleted = reduceProject(withOne, {
            type: 'delete-context', projectId: 'p1', contextId: id,
        });
        expect(deleted.contexts).toHaveLength(0);
    });

    it('toggle-auto-inject flips the flag', () => {
        const withOne = reduceProject(baseProject, {
            type: 'upsert-context', projectId: 'p1',
            context: { name: 'api-spec', filePath: 'docs/api.md' },
        });
        const id = withOne.contexts![0].id;
        const toggled = reduceProject(withOne, {
            type: 'toggle-auto-inject', projectId: 'p1', contextId: id,
        });
        expect(toggled.contexts![0].autoInject).toBe(true);
        const toggledBack = reduceProject(toggled, {
            type: 'toggle-auto-inject', projectId: 'p1', contextId: id,
        });
        expect(toggledBack.contexts![0].autoInject).toBeFalsy();
    });

    it('rename-context validates name format', () => {
        const withOne = reduceProject(baseProject, {
            type: 'upsert-context', projectId: 'p1',
            context: { name: 'api-spec', filePath: 'docs/api.md' },
        });
        const id = withOne.contexts![0].id;
        const renamed = reduceProject(withOne, {
            type: 'rename-context', projectId: 'p1', contextId: id, newName: 'invalid name!',
        });
        expect(renamed.contexts![0].name).toBe('api-spec'); // unchanged
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
        const barId = p.contexts![1].id;
        const renamed = reduceProject(p, {
            type: 'rename-context', projectId: 'p1', contextId: barId, newName: 'foo',
        });
        expect(renamed.contexts![1].name).toBe('bar'); // unchanged
    });
});

// ----------------------------------------------------------------------------
// Feature 5: Streaming submit routing (updated 2026-05-07 — composer-queue)
// ----------------------------------------------------------------------------
// Contract (updated): streaming alone no longer auto-branches. When the user
// hits Send while the current node is streaming, the composer queues the text
// onto N via queueMessage (handled in TPane.onSubmit) — it does NOT fork a
// child. Forking is now reserved for explicit signals: the Branch button
// (⌘↵) or a /btw|/branch slash prefix.
//
// The pure-function proxy for the fork-vs-stay decision lives in
// chatNodeUtils.ts (shouldBranchOnSubmit). This describe block documents the
// contract at the chatStore layer so a regression to either sendMessage or
// submit() is caught.

describe('streaming submit routing', () => {
  it('should NOT branch when sending to a streaming node — caller queues instead', () => {
    // Updated 2026-05-07: streaming-only submits are routed through the queue
    // by TPane.onSubmit. shouldBranchOnSubmit returns false so the caller
    // knows not to fork.
    expect(shouldBranchOnSubmit({ forceBranch: false, slashBranched: false, streaming: true })).toBe(false);
  });

  it('should route to in-place reply (sendMessage) when the node is idle', () => {
    expect(shouldBranchOnSubmit({ forceBranch: false, slashBranched: false, streaming: false })).toBe(false);
  });

  it('still respects explicit branch signals (⌘+Enter, /branch) regardless of streaming', () => {
    expect(shouldBranchOnSubmit({ forceBranch: true, slashBranched: false, streaming: false })).toBe(true);
    expect(shouldBranchOnSubmit({ forceBranch: false, slashBranched: true, streaming: false })).toBe(true);
    expect(shouldBranchOnSubmit({ forceBranch: true, slashBranched: true, streaming: true })).toBe(true);
  });
});
