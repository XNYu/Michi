import { describe, expect, it } from 'vitest';
import type { ToolCallState } from '../chatTypes';
import { metaAgentToolLine } from './toolLines';

const names = {
  workspace: (id: string) => ({ 'ws-r': 'rabbitholes' } as Record<string, string>)[id] ?? null,
  page: (id: string) => ({ 'pg-home': 'Home', 'pg-r': 'rabbitholes' } as Record<string, string>)[id] ?? null,
};

const kiro = (value: unknown) => JSON.stringify({ items: [{ Json: { content: [{ type: 'text', text: JSON.stringify(value) }] } }] });
const tool = (title: string, input: unknown, output?: unknown, status = 'completed'): ToolCallState => ({
  id: title, title, status, kind: 'other', inputJson: JSON.stringify(input), ...(output === undefined ? {} : { output: kiro(output) }),
} as ToolCallState);

describe('metaAgentToolLine', () => {
  it('names the page it read and how much it read', () => {
    expect(metaAgentToolLine(tool('Running: @michi/read_page', { pageId: 'pg-home' }, { title: 'Home', blocks: [{}, {}] }), names))
      .toBe('Read Home · 2 blocks');
    expect(metaAgentToolLine(tool('mcp__michi-tools__read_page', { pageId: 'pg-x' }, undefined, 'in_progress'), names))
      .toBe('Read a page');
  });

  it('says what a write changed, and calls a proposal-only write a suggestion', () => {
    const write = (applied: unknown[], proposed: unknown[]) => ({
      result: { resource: { kind: 'page', id: 'pg-r' }, applied, proposed, rejected: [] },
      michiPageWrite: { kind: 'michiPageWrite', resourceKind: 'page', resourceId: 'pg-r', title: 'rabbitholes', workspaceId: 'ws-r', appliedCount: applied.length, proposedCount: proposed.length, affectedTargetIds: ['b1'] },
    });
    const block = (id: string, title: string) => ({ id, seq: 3, after: { kind: 'block', exists: true, block: { type: 'callout', title, text: 'x' } } });
    expect(metaAgentToolLine(tool('Running: @michi/edit_page', { pageId: 'pg-r' }, write([block('c1', '进展')], [])), names))
      .toBe('Write rabbitholes · 进展');
    expect(metaAgentToolLine(tool('edit_page', { pageId: 'pg-r' }, write([], [block('c2', '我写的')])), names))
      .toBe('Suggest rabbitholes · 我写的 · 1 suggestion');
  });

  it('reads workspace names from the arguments and counts conversations', () => {
    expect(metaAgentToolLine(tool('Running: @michi/read_conversation_updates', { workspaceId: 'ws-r' }, { updates: [{}, {}, {}] }), names))
      .toBe('Read new conversations · rabbitholes · 3 conversations');
    expect(metaAgentToolLine(tool('start_conversation', { workspaceId: 'ws-r', text: 'go' }, undefined, 'in_progress'), names))
      .toBe('New conversation · rabbitholes · your settings');
    expect(metaAgentToolLine(tool('search_messages', { query: 'notarize' }, { results: [{}] }), names)).toBe('Search “notarize” · 1 match');
  });

  it('says a page write waits for the first run', () => {
    const held = (title: string, input: unknown) => ({ id: title, title, status: 'failed', kind: 'other', inputJson: JSON.stringify(input),
      output: kiro("HELD: the Meta agent's first-time generation is still writing (2 of 5 workspace homes written, then the Spaces Home).") } as ToolCallState);
    expect(metaAgentToolLine(held('Running: @michi/edit_page', { pageId: 'pg-r' }), names)).toBe('Write rabbitholes · held until the first run finishes');
    expect(metaAgentToolLine(held('create_page', { title: '性能', workspaceId: 'ws-r' }), names)).toBe('Create 性能 · held until the first run finishes');
    expect(metaAgentToolLine(held('read_page', { pageId: 'pg-r' }), names)).toBe('Read rabbitholes');
  });

  it('says what a layout rule call read or wrote, and that a write waits for the first run', () => {
    const answer = { page: { id: 'pg-home', title: 'Home' }, layoutRules: [{ id: 'r1', text: 'Stalled: only the last 3 days' }] };
    expect(metaAgentToolLine(tool('Running: @michi/layout_rules', { action: 'add', pageId: 'pg-home', text: 'x', section: 'stalled', maxAgeDays: 3 }, { ...answer, added: answer.layoutRules[0] }), names))
      .toBe('Write Home · 1 layout rule');
    expect(metaAgentToolLine(tool('mcp__michi-tools__layout_rules', { action: 'list', pageId: 'pg-new' }, answer), names)).toBe('Read Home · 1 layout rule');
    expect(metaAgentToolLine(tool('layout_rules', { action: 'remove', pageId: 'pg-r', ruleId: 'r1' }, { ...answer, layoutRules: [] }), names))
      .toBe('Write rabbitholes · layout rule removed');
    expect(metaAgentToolLine(tool('layout_rules', { action: 'list', pageId: 'pg-x' }, undefined, 'in_progress'), names)).toBe('Read a page');
    const held = { id: 'h', title: 'layout_rules', status: 'failed', kind: 'other', inputJson: JSON.stringify({ action: 'add', pageId: 'pg-home' }),
      output: kiro("HELD: the Meta agent's first-time generation is still writing (2 of 5 workspace homes written, then the Spaces Home).") } as ToolCallState;
    expect(metaAgentToolLine(held, names)).toBe('Write Home · held until the first run finishes');
  });

  it('names the task tools and counts what a task write did', () => {
    expect(metaAgentToolLine(tool('Running: @michi/open_task_database', { workspaceId: 'ws-r' }, { kind: 'taskDatabase', created: true, databaseId: 'db-t' }), names))
      .toBe('Create the task database · rabbitholes');
    expect(metaAgentToolLine(tool('open_task_database', { workspaceId: 'ws-r' }, { kind: 'taskDatabase', created: false, databaseId: 'db-t' }), names))
      .toBe('Open the task database · rabbitholes');
    expect(metaAgentToolLine(tool('mcp__michi-tools__list_tasks', { workspaceIds: ['ws-r', 'ws-x'], needsYou: true }, { items: [{}, {}, {}], nextCursor: null, skippedWorkspaces: [] }), names))
      .toBe('List tasks · 2 workspaces · waiting on you · 3 tasks');
    expect(metaAgentToolLine(tool('list_tasks', { workspaceIds: ['ws-r'], statuses: ['todo', 'doing'], query: 'release' }, undefined, 'in_progress'), names))
      .toBe('List tasks · rabbitholes · To do, In progress · “release”');
    const write = {
      result: { resource: { kind: 'database', id: 'db-t' }, applied: [], proposed: [], rejected: [] },
      michiPageWrite: { kind: 'michiPageWrite', resourceKind: 'database', resourceId: 'db-t', title: 'Tasks', workspaceId: 'ws-r', appliedCount: 3, proposedCount: 1, affectedTargetIds: [], tasks: { added: 2, updated: 1, removed: 0 } },
    };
    expect(metaAgentToolLine(tool('edit_database', { databaseId: 'db-t' }, write), names)).toBe('Write Tasks · 2 new, 1 updated · 1 suggestion');
    const held = { id: 'h', title: 'open_task_database', status: 'failed', kind: 'other', inputJson: JSON.stringify({ workspaceId: 'ws-r' }),
      output: kiro("HELD: the Meta agent's first-time generation is still writing (2 of 5 workspace homes written, then the Spaces Home).") } as ToolCallState;
    expect(metaAgentToolLine(held, names)).toBe('Open the task database · rabbitholes · held until the first run finishes');
  });

  it('leaves tools it does not know to the generic row', () => {
    expect(metaAgentToolLine(tool('Bash', { command: 'ls' }), names)).toBeNull();
  });
});
