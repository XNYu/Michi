import { beforeEach, describe, expect, it } from 'vitest';
import {
  invalidateTurnPageReceipt, parseTurnPageInvalidation, parseTurnPageReceipt, resetTurnPageReceiptInvalidationForTests, taskBoardPageId, taskWriteLine,
} from './turnPageReceipt';
import { subscribePageChanges, type PageEventIdentity } from '../state/pages/pageEvents';

const receipt = {
  kind: 'michiPageWrite', resourceKind: 'database', resourceId: 'db-1',
  originatingPageIds: ['page-a', 'page-b'], title: 'Roadmap', appliedCount: 2,
  proposedCount: 1, affectedTargetIds: ['row-1'],
};

function pageTool(write: Record<string, unknown>, title = 'edit_page') {
  return { title, status: 'completed', output: JSON.stringify({ michiPageWrite: write }) };
}

function invalidation(write: Record<string, unknown> = {}, connectionId = 'local', title = 'edit_page') {
  const parsed = parseTurnPageInvalidation(pageTool({
    ...receipt, resourceKind: 'page', resourceId: 'page-1', ...write,
  }, title), connectionId);
  expect(parsed).not.toBeNull();
  return parsed!;
}

function capturePageChanges(run: () => void, identity: PageEventIdentity = { backendConnectionId: 'local' }) {
  const seen: PageEventIdentity[] = [];
  const stop = subscribePageChanges(identity, (changed) => seen.push(changed));
  try { run(); } finally { stop(); }
  return seen;
}

const turnIdentity = {
  backendConnectionId: 'local', workspaceId: 'ws-chat', nodeId: 'node-1', turnId: 'turn-1',
};

beforeEach(() => resetTurnPageReceiptInvalidationForTests());

describe('parseTurnPageReceipt', () => {
  it('normalizes MCP/Codex names and nested JSON text wrappers with backend identities', () => {
    const parsed = parseTurnPageReceipt({
      title: 'michi_tools____edit_database', status: 'completed',
      output: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ result: { michiPageWrite: receipt } }) }] }),
    }, 'remote-one');
    expect(parsed).toMatchObject({
      tool: 'edit_database', resourceKind: 'database',
      resourceId: 'remote:remote-one:db-1', originatingPageIds: ['remote:remote-one:page-a', 'remote:remote-one:page-b'],
      affectedTargetIds: ['row-1'], appliedCount: 2, proposedCount: 1,
    });
  });

  it('keeps block and row target IDs opaque for remote receipts and recognizes database view writes', () => {
    const pageReceipt = parseTurnPageReceipt({
      title: 'mcp__michi-tools__edit_page', status: 'completed',
      output: JSON.stringify({ michiPageWrite: { ...receipt, resourceKind: 'page', resourceId: 'page-1', affectedTargetIds: ['block-1'] } }),
    }, 'remote-one');
    expect(pageReceipt).toMatchObject({
      resourceId: 'remote:remote-one:page-1',
      affectedTargetIds: ['block-1'],
    });

    const viewReceipt = parseTurnPageReceipt({
      title: 'mcp__michi-tools__configure_database_view', status: 'completed',
      output: JSON.stringify({ michiPageWrite: { ...receipt, resourceId: 'db-1', affectedTargetIds: ['row-1'] } }),
    }, 'remote-one');
    expect(viewReceipt).toMatchObject({
      tool: 'configure_database_view',
      resourceId: 'remote:remote-one:db-1',
      originatingPageIds: ['remote:remote-one:page-a', 'remote:remote-one:page-b'],
      affectedTargetIds: ['row-1'],
    });
  });

  it('accepts direct JSON output, and ignores failed/interrupted calls', () => {
    const tool = { title: 'mcp__michi-tools__create_page', status: 'completed', output: JSON.stringify({ michiPageWrite: { ...receipt, resourceKind: 'page', resourceId: 'p1', created: true } }) };
    expect(parseTurnPageReceipt(tool, 'local')?.created).toBe(true);
    expect(parseTurnPageReceipt({ ...tool, status: 'failed' }, 'local')).toBeNull();
    expect(parseTurnPageReceipt({ ...tool, status: 'interrupted' }, 'local')).toBeNull();
  });

  it('preserves persisted revision, view version, and commit status for chat cards', () => {
    const parsed = parseTurnPageReceipt(pageTool({
      ...receipt, resourceKind: 'page', resourceId: 'page-1', revision: 4, viewVersion: 7, commitStatus: 'partial',
    }), 'remote-one');
    expect(parsed).toMatchObject({
      resourceKind: 'page', resourceId: 'remote:remote-one:page-1', revision: 4, viewVersion: 7, commitStatus: 'partial',
    });
  });

  it('ignores tools without a valid michiPageWrite envelope', () => {
    expect(parseTurnPageReceipt({ title: 'edit_page', status: 'completed', output: '{"ok":true}' }, 'local')).toBeNull();
  });

  it("reads the Meta agent's receipt from Kiro's MCP envelope: workspace, batch and change records", () => {
    const write = {
      result: {
        resource: { kind: 'page', id: 'page-home' }, revision: 4, rejected: [],
        applied: [{ id: 'chg-1', seq: 12, batchId: 'batch-1', after: { kind: 'block', exists: true, block: { type: 'markdown', text: '#### 进展\n\n- one' } } }],
        proposed: [{ id: 'chg-2', seq: 13, batchId: 'batch-1', after: { kind: 'block', exists: true, block: { type: 'callout', title: '我写的', text: 'x' } } }],
      },
      michiPageWrite: {
        kind: 'michiPageWrite', resourceKind: 'page', resourceId: 'page-home', title: 'rabbitholes', workspaceId: 'ws-rabbitholes',
        appliedCount: 1, proposedCount: 1, affectedTargetIds: ['block-1', 'block-2'], batchId: 'batch-1', originatingPageId: 'page-home',
      },
    };
    const parsed = parseTurnPageReceipt({
      title: 'Running: @michi/edit_page', status: 'completed',
      output: JSON.stringify({ items: [{ Json: { content: [{ type: 'text', text: JSON.stringify(write) }] } }] }),
    }, 'local');
    expect(parsed).toMatchObject({
      tool: 'edit_page', resourceId: 'page-home', workspaceId: 'ws-rabbitholes', batchId: 'batch-1',
      changes: [
        { id: 'chg-1', seq: 12, proposed: false, label: '进展' },
        { id: 'chg-2', seq: 13, proposed: true, label: '我写的' },
      ],
    });
    expect(parseTurnPageReceipt({ title: 'edit_page', status: 'completed', output: JSON.stringify(write) }, 'remote-one')?.workspaceId)
      .toBe('remote:remote-one:ws-rabbitholes');
  });

  it("refreshes the page in the receipt's own workspace, not the chat's", () => {
    const parsed = parseTurnPageReceipt({
      title: 'edit_page', status: 'completed',
      output: JSON.stringify({ michiPageWrite: { ...receipt, resourceKind: 'page', resourceId: 'page-1', workspaceId: 'ws-real' } }),
    }, 'local')!;
    const seen = capturePageChanges(() => {
      invalidateTurnPageReceipt(parsed, { backendConnectionId: 'local', workspaceId: 'ws-hidden-assistant' }, 'tool-1');
      invalidateTurnPageReceipt(parsed, { backendConnectionId: 'local', workspaceId: 'ws-hidden-assistant' }, 'tool-1');
    });
    expect(seen).toEqual([{ backendConnectionId: 'local', workspaceId: 'ws-real', pageId: 'page-1' }]);
  });
});

describe('parseTurnPageInvalidation', () => {
  it.each([
    ['page', 'edit_page'],
    ['database', 'edit_database'],
  ])('uses the existing card receipt for %s writes', (resourceKind, title) => {
    const tool = pageTool({ ...receipt, resourceKind, revision: 3, viewVersion: 8, commitStatus: 'committed' }, title);
    expect(parseTurnPageInvalidation(tool, 'remote-one')).toEqual(parseTurnPageReceipt(tool, 'remote-one'));
  });

  it('parses component writes from nested MCP output without turning them into page cards', () => {
    const tool = {
      title: 'Running: @michi/save_page_component', status: 'completed',
      output: JSON.stringify({ items: [{ Json: { content: [{ type: 'text', text: JSON.stringify({
        michiPageWrite: {
          kind: 'michiPageWrite', resourceKind: 'component', resourceId: 'component-1', workspaceId: 'ws-real',
          revision: 9, viewVersion: 12, commitStatus: 'committed',
        },
      }) }] } }] }),
    };
    expect(parseTurnPageInvalidation(tool, 'remote-one')).toMatchObject({
      resourceKind: 'component', resourceId: 'remote:remote-one:component-1', workspaceId: 'remote:remote-one:ws-real',
      revision: 9, viewVersion: 12, commitStatus: 'committed',
    });
    expect(parseTurnPageReceipt(tool, 'remote-one')).toBeNull();
  });

  it.each(['failed', 'interrupted', 'running', undefined])('ignores %s tool calls for every resource kind', (status) => {
    for (const [resourceKind, title] of [['page', 'edit_page'], ['database', 'edit_database'], ['component', 'save_page_component']]) {
      const tool = { ...pageTool({ ...receipt, resourceKind }, title), status };
      expect(parseTurnPageInvalidation(tool, 'local')).toBeNull();
    }
  });

  it('requires a recognized write tool and a resource identity', () => {
    const component = { ...receipt, resourceKind: 'component', resourceId: 'component-1' };
    expect(parseTurnPageInvalidation(pageTool(component, 'read_page_component'), 'local')).toBeNull();
    expect(parseTurnPageInvalidation(pageTool({ ...component, resourceId: '' }, 'save_page_component'), 'local')).toBeNull();
    expect(parseTurnPageInvalidation({ title: 'save_page_component', status: 'completed', output: '{"ok":true}' }, 'local')).toBeNull();
  });
});

describe('invalidateTurnPageReceipt', () => {
  it('isolates reused tool call IDs by node and durable turn', () => {
    const parsed = invalidation({ revision: 2 });
    const seen = capturePageChanges(() => {
      invalidateTurnPageReceipt(parsed, turnIdentity, 'tool-1');
      invalidateTurnPageReceipt(parsed, turnIdentity, 'tool-1');
      invalidateTurnPageReceipt(parsed, { ...turnIdentity, nodeId: 'node-2' }, 'tool-1');
      invalidateTurnPageReceipt(parsed, { ...turnIdentity, turnId: 'turn-2' }, 'tool-1');
    });
    expect(seen).toHaveLength(3);
    expect(seen.every((changed) => changed.pageId === 'page-1')).toBe(true);
  });

  it('keeps backend and workspace refresh scopes independent', () => {
    const seenLocal = capturePageChanges(() => {
      invalidateTurnPageReceipt(invalidation({ revision: 2 }), turnIdentity, 'tool-1');
      invalidateTurnPageReceipt(invalidation({ revision: 2, workspaceId: 'ws-other' }), turnIdentity, 'tool-1');
    });
    const seenRemote = capturePageChanges(() => {
      invalidateTurnPageReceipt(invalidation({ revision: 2, workspaceId: 'ws-real' }, 'remote-one'), {
        ...turnIdentity, backendConnectionId: 'remote-one', workspaceId: 'remote:remote-one:ws-chat',
      }, 'tool-1');
    }, { backendConnectionId: 'remote-one' });
    expect(seenLocal.map((changed) => changed.workspaceId)).toEqual(['ws-chat', 'ws-other']);
    expect(seenRemote).toEqual([{
      backendConnectionId: 'remote-one', workspaceId: 'remote:remote-one:ws-real', pageId: 'remote:remote-one:page-1',
    }]);
  });

  it('deduplicates legacy receipts by tool call and resource identity', () => {
    const page = invalidation();
    const otherPage = invalidation({ resourceId: 'page-2' });
    const database = invalidation({ resourceKind: 'database' }, 'local', 'edit_database');
    const seen = capturePageChanges(() => {
      invalidateTurnPageReceipt(page, turnIdentity, 'tool-1');
      invalidateTurnPageReceipt(page, turnIdentity, 'tool-1');
      invalidateTurnPageReceipt(otherPage, turnIdentity, 'tool-1');
      invalidateTurnPageReceipt(database, turnIdentity, 'tool-1');
      invalidateTurnPageReceipt(page, turnIdentity, 'tool-2');
    });
    expect(seen.map((changed) => ({ pageId: changed.pageId, databaseId: changed.databaseId }))).toEqual([
      { pageId: 'page-1', databaseId: undefined },
      { pageId: 'page-2', databaseId: undefined },
      { pageId: undefined, databaseId: 'page-1' },
      { pageId: 'page-1', databaseId: undefined },
    ]);
  });

  it('refreshes newer revisions on the same call and ignores replayed or older revisions on any call', () => {
    const seen = capturePageChanges(() => {
      invalidateTurnPageReceipt(invalidation({ revision: 4 }), turnIdentity, 'tool-1');
      invalidateTurnPageReceipt(invalidation({ revision: 4 }), turnIdentity, 'tool-1');
      invalidateTurnPageReceipt(invalidation({ revision: 4 }), turnIdentity, 'tool-replay');
      invalidateTurnPageReceipt(invalidation({ revision: 5 }), turnIdentity, 'tool-1');
      invalidateTurnPageReceipt(invalidation({ revision: 3 }), turnIdentity, 'tool-delayed');
      invalidateTurnPageReceipt(invalidation({ revision: 5 }), turnIdentity, 'tool-replay');
      invalidateTurnPageReceipt(invalidation({ revision: 6 }), turnIdentity, 'tool-1');
    });
    expect(seen).toHaveLength(3);
  });

  it('refreshes newer page view versions even while the content revision stays unchanged', () => {
    const seen = capturePageChanges(() => {
      for (const viewVersion of [7, 7, 8, 6, 8, 9]) {
        invalidateTurnPageReceipt(invalidation({ revision: 4, viewVersion }), turnIdentity, 'tool-1');
      }
    });
    expect(seen.map((changed) => changed.viewVersion)).toEqual([7, 8, 9]);
  });

  it('uses view versions to order receipts when no content revision is supplied', () => {
    const seen = capturePageChanges(() => {
      for (const viewVersion of [4, 4, 3, 5]) {
        invalidateTurnPageReceipt(invalidation({ viewVersion }), turnIdentity, 'tool-1');
      }
    });
    expect(seen.map((changed) => changed.viewVersion)).toEqual([4, 5]);
  });

  it.each(['committed', 'partial', 'proposed', 'unchanged'])('refreshes persisted %s results', (commitStatus) => {
    const seen = capturePageChanges(() => {
      invalidateTurnPageReceipt(invalidation({ revision: 4, viewVersion: 7, commitStatus }), turnIdentity, 'tool-1');
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ pageId: 'page-1', viewVersion: 7 });
  });

  it.each(['rejected', 'pending', 'uncommitted'])('ignores %s results without swallowing the later committed receipt', (commitStatus) => {
    const seen = capturePageChanges(() => {
      invalidateTurnPageReceipt(invalidation({ revision: 4, viewVersion: 7, commitStatus }), turnIdentity, 'tool-1');
      invalidateTurnPageReceipt(invalidation({ revision: 4, viewVersion: 7, commitStatus: 'committed' }), turnIdentity, 'tool-1');
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ pageId: 'page-1', viewVersion: 7 });
  });

  it('emits component identity in the receipt workspace and refreshes later component revisions', () => {
    const identity = { ...turnIdentity, backendConnectionId: 'remote-one', workspaceId: 'remote:remote-one:ws-chat' };
    const seen = capturePageChanges(() => {
      for (const revision of [2, 2, 3, 1]) {
        const parsed = invalidation({ resourceKind: 'component', resourceId: 'component-1', workspaceId: 'ws-real', revision }, 'remote-one', 'mcp__michi-tools__save_page_component');
        invalidateTurnPageReceipt(parsed, identity, 'tool-1');
      }
    }, { backendConnectionId: 'remote-one', workspaceId: 'remote:remote-one:ws-real', componentId: 'remote:remote-one:component-1' });
    expect(seen).toEqual([
      { backendConnectionId: 'remote-one', workspaceId: 'remote:remote-one:ws-real', componentId: 'remote:remote-one:component-1' },
      { backendConnectionId: 'remote-one', workspaceId: 'remote:remote-one:ws-real', componentId: 'remote:remote-one:component-1' },
    ]);
  });
});

describe('task receipts', () => {
  it('reads what a task database write did and names its rows by their task', () => {
    const row = (id: string, values: Record<string, unknown>) => ({ id, seq: 5, batchId: 'batch-t', after: { kind: 'row', exists: true, row: { id: `r-${id}`, values } } });
    const output = JSON.stringify({
      result: { resource: { kind: 'database', id: 'db-t' }, applied: [row('c1', { status: 'doing', task: 'Ship the release' })], proposed: [], rejected: [] },
      michiPageWrite: { ...receipt, resourceId: 'db-t', title: 'Tasks', originatingPageIds: [], tasks: { added: 1, updated: 0, removed: 0 } },
    });
    const parsed = parseTurnPageReceipt({ title: 'edit_database', status: 'completed', output }, 'local')!;
    expect(parsed.tasks).toEqual({ added: 1, updated: 0, removed: 0 });
    expect(parsed.changes[0]!.label).toBe('Ship the release');
    expect(parseTurnPageReceipt(pageTool({ ...receipt }, 'edit_database'), 'local')!.tasks).toBeUndefined();
  });

  it('marks a page write that inserts a task board, inside a grid too, and finds the page it went on', () => {
    const change = (id: string, op: string, block: unknown) => ({ id, seq: 2, batchId: 'batch-1', op, after: { kind: 'block', exists: true, block } });
    const output = JSON.stringify({
      result: { resource: { kind: 'page', id: 'pg-1' }, proposed: [], rejected: [], applied: [
        change('c1', 'insert', { id: 'b1', rev: 1, type: 'task-view' }),
        change('c2', 'insert', { id: 'b2', rev: 1, type: 'grid', regions: [{ id: 'main', span: 12, blocks: [{ type: 'task-view', viewId: 'tasks-table' }] }] }),
        change('c3', 'update', { id: 'b3', rev: 2, type: 'task-view', title: 'Release tasks' }),
      ] },
      michiPageWrite: { ...receipt, resourceKind: 'page', resourceId: 'pg-1', title: 'Plan' },
    });
    const parsed = parseTurnPageReceipt({ title: 'edit_page', status: 'completed', output }, 'local')!;
    expect(parsed.changes.map((item) => [item.id, item.label, item.taskBoard ?? false])).toEqual([
      ['c1', 'Task board', true], ['c2', null, true], ['c3', 'Release tasks', false],
    ]);
    const database = parseTurnPageReceipt(pageTool({ ...receipt }, 'edit_database'), 'local')!;
    expect(taskBoardPageId([database, parsed], undefined)).toBe('pg-1');
    expect(taskBoardPageId([database], undefined)).toBeNull();
    expect(taskBoardPageId([database, parsed], 'ws-other')).toBeNull();
    expect(taskBoardPageId([{ ...parsed, workspaceId: 'ws-b' }], 'ws-a')).toBeNull();
    expect(taskBoardPageId([{ ...parsed, workspaceId: 'ws-b' }], 'ws-b')).toBe('pg-1');
  });

  it('says what a write did to the tasks', () => {
    expect(taskWriteLine({ added: 5, updated: 2, removed: 1 })).toBe('Created 5 tasks, updated 2, removed 1');
    expect(taskWriteLine({ added: 1, updated: 0, removed: 0 })).toBe('Created 1 task');
    expect(taskWriteLine({ added: 0, updated: 2, removed: 1 })).toBe('Updated 2 tasks, removed 1');
    expect(taskWriteLine({ added: 0, updated: 0, removed: 1 })).toBe('Removed 1 task');
    expect(taskWriteLine({ added: 0, updated: 0, removed: 0 })).toBeNull();
  });

  it('refreshes the workspace when open_task_database makes its task database', () => {
    const opened = (created: boolean) => ({ title: 'mcp__michi-tools__open_task_database', status: 'completed',
      output: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ kind: 'taskDatabase', created, databaseId: 'db-t', workspaceId: 'ws-real', revision: 1 }) }] }) });
    expect(parseTurnPageInvalidation(opened(false), 'local')).toBeNull();
    const parsed = parseTurnPageInvalidation(opened(true), 'local')!;
    expect(parsed).toEqual({ resourceKind: 'database', resourceId: 'db-t', workspaceId: 'ws-real', revision: 1 });
    const seen = capturePageChanges(() => invalidateTurnPageReceipt(parsed, turnIdentity, 'tool-open'));
    expect(seen).toEqual([{ backendConnectionId: 'local', workspaceId: 'ws-real', databaseId: 'db-t' }]);
  });
});

describe('task receipts in a cut-off output', () => {
  const write = {
    kind: 'michiPageWrite', resourceKind: 'database', resourceId: 'db-t', title: 'Tasks "all"', workspaceId: 'ws-1',
    appliedCount: 12, proposedCount: 0, affectedTargetIds: ['r1'], batchId: 'batch-big', tasks: { added: 12, updated: 0, removed: 0 }, taskBoard: true,
  };
  const rows = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, seq: i, note: 'x'.repeat(600) }));
  // michiPageWrite leads, like the backend writes it; the rest is what a runtime cuts off.
  const payload = JSON.stringify({ michiPageWrite: write, result: { applied: rows } });
  const cut = (text: string) => text.slice(0, 16384);
  const shapes: Array<[string, (text: string) => string]> = [
    ['plain JSON', (text) => cut(text)],
    ['MCP content', (text) => cut(JSON.stringify({ content: [{ type: 'text', text }] }))],
    ['Kiro items', (text) => cut(JSON.stringify({ items: [{ Json: { content: [{ type: 'text', text }] } }] }))],
    ['Kiro items with a string Json', (text) => cut(JSON.stringify({ items: [{ Json: JSON.stringify({ content: [{ type: 'text', text }] }) }] }))],
  ];

  it.each(shapes)('keeps counts, batch and workspace from %s', (_name, wrap) => {
    const output = wrap(payload);
    expect(output.length).toBe(16384);
    expect(() => JSON.parse(output)).toThrow();
    const parsed = parseTurnPageReceipt({ title: 'edit_database', status: 'completed', output }, 'local')!;
    expect(parsed).toMatchObject({
      resourceId: 'db-t', workspaceId: 'ws-1', title: 'Tasks "all"', appliedCount: 12, batchId: 'batch-big',
      tasks: { added: 12, updated: 0, removed: 0 }, taskBoard: true, changes: [],
    });
  });

  it.each(shapes)('ignores a receipt quoted in page text once an older payload lost its own, in %s', (_name, wrap) => {
    const fake = { ...write, resourceId: 'pg-FAKE', batchId: 'batch-FAKE' };
    const quoting = { id: 'q', seq: 0, after: { kind: 'block', exists: true, block: { type: 'markdown', text: JSON.stringify({ michiPageWrite: fake }) } } };
    // Older layout: result first, receipt last, so the cut removes the real receipt.
    const legacy = JSON.stringify({ result: { applied: [quoting, ...rows] }, michiPageWrite: write });
    const output = wrap(legacy);
    expect(() => JSON.parse(output)).toThrow();
    expect(output).toContain('pg-FAKE');
    expect(parseTurnPageReceipt({ title: 'edit_database', status: 'completed', output }, 'local')).toBeNull();
    // The current layout keeps the real receipt even with a quoted one behind it.
    const current = wrap(JSON.stringify({ michiPageWrite: write, result: { applied: [quoting, ...rows] } }));
    expect(parseTurnPageReceipt({ title: 'edit_database', status: 'completed', output: current }, 'local')).toMatchObject({ resourceId: 'db-t', batchId: 'batch-big', partial: true });
  });

  it('gives up when the receipt itself is cut', () => {
    expect(parseTurnPageReceipt({ title: 'edit_database', status: 'completed', output: payload.slice(0, 120) }, 'local')).toBeNull();
  });
});

describe('a task board added into an existing container', () => {
  it('marks an update whose after shows a task board and whose before did not', () => {
    const update = (id: string, before: unknown) => ({ id, seq: 3, batchId: 'b', op: 'update', before: { kind: 'block', exists: true, block: before }, after: { kind: 'block', exists: true, block: { id: 'g', rev: 3, type: 'grid', regions: [{ id: 'main', span: 12, blocks: [{ type: 'task-view', viewId: 'tasks-table' }] }] } } });
    const output = JSON.stringify({
      result: { resource: { kind: 'page', id: 'pg-1' }, proposed: [], rejected: [], applied: [
        update('c1', { id: 'g', rev: 2, type: 'grid', regions: [{ id: 'main', span: 12, blocks: [] }] }),
        update('c2', { id: 'g', rev: 2, type: 'grid', regions: [{ id: 'main', span: 12, blocks: [{ type: 'task-view', viewId: 'tasks-table' }] }] }),
      ] },
      michiPageWrite: { ...receipt, resourceKind: 'page', resourceId: 'pg-1', title: 'Plan' },
    });
    const parsed = parseTurnPageReceipt({ title: 'edit_page', status: 'completed', output }, 'local')!;
    expect(parsed.changes.map((item) => item.taskBoard ?? false)).toEqual([true, false]);
  });
});
