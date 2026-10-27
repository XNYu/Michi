import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallState } from '../../../../state/chatTypes';
import { resetPageCardStatesForTests } from '../../../../state/metaChat/pageCardStates';
import { MetaChatCards, type MetaChatCardsContext } from './MetaChatCards';

const api = vi.hoisted(() => ({
  revertPageBatch: vi.fn(),
  redoPageBatch: vi.fn(),
  changePageChange: vi.fn(),
  deletePage: vi.fn(),
  restorePage: vi.fn(),
  fetchPage: vi.fn(),
  listPageChanges: vi.fn(),
  fetchPageBatchState: vi.fn(),
}));
vi.mock('../../../../services/api/pages', async () => {
  const actual = await vi.importActual<typeof import('../../../../services/api/pages')>('../../../../services/api/pages');
  return { ...actual, ...api };
});
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const openSpacesPage = vi.hoisted(() => vi.fn());
vi.mock('../../../../state/metaChat/spacesPages', () => ({ openSpacesPage }));
const rulesApi = vi.hoisted(() => ({ fetchLayoutRules: vi.fn(), deleteLayoutRule: vi.fn(), addLayoutRule: vi.fn() }));
vi.mock('../../../../services/api/spacesHome', () => rulesApi);
vi.mock('../../assistant/AssistantLinks', () => ({
  AssistantLinkChip: ({ link, children }: { link: { id: string }; children: React.ReactNode }) => <button type="button" data-node={link.id}>{children}</button>,
}));

const context: MetaChatCardsContext = { backendConnectionId: 'local', workspaceId: 'ws-assistant', currentPageId: 'pg-home', runtimeLabel: (id) => (id === 'kiro' ? 'Kiro' : id) };
const block = (id: string, seq: number, title: string) => ({ id, seq, batchId: 'batch-1', after: { kind: 'block', exists: true, block: { type: 'callout', title, text: 'x' } } });
const kiro = (value: unknown) => JSON.stringify({ items: [{ Json: { content: [{ type: 'text', text: JSON.stringify(value) }] } }] });
function editTool(id: string, opts: { applied?: unknown[]; proposed?: unknown[]; purpose?: string; pageId?: string; workspaceId?: string } = {}): ToolCallState {
  const applied = opts.applied ?? [];
  const proposed = opts.proposed ?? [];
  return {
    id, title: 'Running: @michi/edit_page', status: 'completed', kind: 'other',
    inputJson: JSON.stringify({ pageId: 'pg-r', ...(opts.purpose ? { __tool_use_purpose: opts.purpose } : {}) }),
    output: kiro({
      result: { resource: { kind: 'page', id: 'pg-r' }, applied, proposed, rejected: [] },
      michiPageWrite: {
        kind: 'michiPageWrite', resourceKind: 'page', resourceId: opts.pageId ?? 'pg-r', title: 'rabbitholes', workspaceId: opts.workspaceId ?? 'ws-r',
        appliedCount: applied.length, proposedCount: proposed.length, affectedTargetIds: ['b-progress'], batchId: 'batch-1',
      },
    }),
  } as ToolCallState;
}

const taskRow = (id: string, task: string, existed: boolean) => ({
  id, seq: 4, batchId: 'batch-t', op: 'row',
  before: existed ? { kind: 'row', exists: true, row: { id: `row-${id}`, values: { status: 'todo', task } } } : { kind: 'row', exists: false, id: `row-${id}`, location: null },
  after: { kind: 'row', exists: true, row: { id: `row-${id}`, values: { status: 'doing', task } } },
});
function tasksTool(id: string, applied: unknown[], tasks: { added: number; updated: number; removed: number }, pages: string[] = [], workspaceId = 'ws-r'): ToolCallState {
  return {
    id, title: 'Running: @michi/edit_database', status: 'completed', kind: 'other', inputJson: JSON.stringify({ databaseId: 'db-t' }),
    output: kiro({
      result: { resource: { kind: 'database', id: 'db-t' }, applied, proposed: [], rejected: [] },
      michiPageWrite: {
        kind: 'michiPageWrite', resourceKind: 'database', resourceId: 'db-t', title: 'Tasks', workspaceId, originatingPageIds: pages,
        appliedCount: applied.length, proposedCount: 0, affectedTargetIds: [], batchId: 'batch-t', tasks,
      },
    }),
  } as ToolCallState;
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  openSpacesPage.mockReset();
  toast.mockReset();
  api.listPageChanges.mockResolvedValue({ changes: [], nextAfter: 0, nextBefore: null, hasMore: false });
});
afterEach(() => {
  cleanup();
  resetPageCardStatesForTests();
});

describe('MetaChatCards', () => {
  it('shows an Updated card that undoes the batch, then restores the batch', async () => {
    api.revertPageBatch.mockResolvedValue({ reverted: ['c1'], conflicts: [] });
    api.redoPageBatch.mockResolvedValue({ redone: ['c1'], conflicts: [] });
    render(<MetaChatCards tools={[editTool('t1', { applied: [block('c1', 7, '进展')], purpose: '进展收成 3 条' })]} context={context} />);
    const card = document.querySelector<HTMLElement>('[data-page-card]')!;
    expect(card.textContent).toContain('Updated rabbitholes · 进展收成 3 条');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })); });
    expect(api.revertPageBatch).toHaveBeenCalledWith('batch-1', { backendConnectionId: 'local', workspaceId: 'ws-r' });
    expect(card.className).toContain('is-undone');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Restore' })); });
    expect(api.redoPageBatch).toHaveBeenCalledWith('batch-1', { backendConnectionId: 'local', workspaceId: 'ws-r' });
    expect(api.changePageChange).not.toHaveBeenCalled();
    expect(card.className).not.toContain('is-undone');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  it('stays on Undo when an undo hit conflicts, as it reads after a reload', async () => {
    api.revertPageBatch.mockResolvedValue({ reverted: [], conflicts: [{ changeId: 'c1', message: 'edited since' }] });
    render(<MetaChatCards tools={[editTool('t-conflict', { applied: [block('c1', 7, 'x')] })]} context={context} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })); });
    expect(toast).toHaveBeenCalledWith("Some changes couldn't be undone: they were edited since.");
    expect(document.querySelector<HTMLElement>('[data-page-card]')!.className).not.toContain('is-undone');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  it('reads an earlier undo back from the page history', async () => {
    api.listPageChanges.mockResolvedValue({ changes: [{ id: 'c1', seq: 7, applicationState: 'reverted', proposalState: null }], nextAfter: 7, nextBefore: null, hasMore: false });
    render(<MetaChatCards tools={[editTool('t2', { applied: [block('c1', 7, '进展')] })]} context={context} />);
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeTruthy();
    expect(api.listPageChanges).toHaveBeenCalledWith('pg-r', expect.objectContaining({ workspaceId: 'ws-r', afterSeq: 6 }));
  });

  it('opens the written page at its block with View', () => {
    render(<MetaChatCards tools={[editTool('t3', { applied: [block('c1', 7, '进展')] })]} context={context} />);
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(openSpacesPage).toHaveBeenCalledWith({ pageId: 'pg-r', workspaceId: 'ws-r', backendConnectionId: 'local', blockId: 'b-progress', currentPageId: 'pg-home' });
  });

  it('shows a proposal-only write as a Suggestion card with no Undo', () => {
    render(<MetaChatCards tools={[editTool('t4', { proposed: [block('c2', 8, '我写的')] })]} context={context} />);
    const card = document.querySelector<HTMLElement>('[data-page-card="suggestion"]')!;
    expect(card.textContent).toContain('Suggestion rabbitholes · “我写的” 1 suggestion');
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(screen.getByRole('button', { name: 'View' })).toBeTruthy();
  });

  it('undoes a new page by deleting it', async () => {
    api.fetchPage.mockResolvedValue({ id: 'pg-new' });
    api.deletePage.mockResolvedValue({});
    const created = {
      id: 't5', title: 'create_page', status: 'completed', kind: 'other', inputJson: '{}',
      output: JSON.stringify({ michiPageWrite: { kind: 'michiPageWrite', resourceKind: 'page', resourceId: 'pg-new', title: '性能', created: true, workspaceId: 'ws-r', appliedCount: 0, proposedCount: 0, affectedTargetIds: ['b1'] } }),
    } as ToolCallState;
    render(<MetaChatCards tools={[created]} context={context} />);
    expect(document.querySelector('[data-page-card="created"]')!.textContent).toContain('New page 性能');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })); });
    expect(api.deletePage).toHaveBeenCalledWith('pg-new', { backendConnectionId: 'local', workspaceId: 'ws-r' });
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy();
  });

  it('shows a page created and then filled in one reply as one New page card with what it holds', async () => {
    api.fetchPage.mockResolvedValue({ id: 'pg-r' });
    api.deletePage.mockResolvedValue({});
    const created = {
      id: 't-create', title: 'Running: @michi/create_page', status: 'completed', kind: 'other', inputJson: '{}',
      output: kiro({ kind: 'createdPage', michiPageWrite: { kind: 'michiPageWrite', resourceKind: 'page', resourceId: 'pg-r', title: '性能', created: true, workspaceId: 'ws-r', appliedCount: 0, proposedCount: 0, affectedTargetIds: [] } }),
    } as ToolCallState;
    const filled = editTool('t-fill', { applied: [block('c1', 3, '还没修的'), block('c2', 4, '下一步')] });
    const elsewhere = { ...editTool('t-other', { applied: [block('c3', 9, '进展')] }), output: editTool('x', { applied: [block('c3', 9, '进展')] }).output!.replace(/pg-r/g, 'pg-other') } as ToolCallState;
    render(<MetaChatCards tools={[created, filled, elsewhere]} context={context} />);
    const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-page-card]'));
    expect(cards.map((card) => card.getAttribute('data-page-card'))).toEqual(['created', 'applied']);
    expect(cards[0]!.textContent).toContain('New page 性能 · 还没修的, 下一步');
    expect(cards[0]!.textContent).not.toContain('empty');
    await act(async () => { fireEvent.click(within(cards[0]!).getByRole('button', { name: 'Undo' })); });
    expect(api.deletePage).toHaveBeenCalledWith('pg-r', { backendConnectionId: 'local', workspaceId: 'ws-r' });
    expect(api.revertPageBatch).not.toHaveBeenCalled();
  });

  it('keeps a suggestion on a page created in the same reply as its own card', () => {
    const created = {
      id: 't-create2', title: 'create_page', status: 'completed', kind: 'other', inputJson: '{}',
      output: JSON.stringify({ michiPageWrite: { kind: 'michiPageWrite', resourceKind: 'page', resourceId: 'pg-r', title: '性能', created: true, workspaceId: 'ws-r', appliedCount: 0, proposedCount: 0, affectedTargetIds: [] } }),
    } as ToolCallState;
    render(<MetaChatCards tools={[created, editTool('t-prop', { proposed: [block('c4', 5, '我写的')] })]} context={context} />);
    expect(Array.from(document.querySelectorAll('[data-page-card]')).map((card) => card.getAttribute('data-page-card'))).toEqual(['created', 'suggestion']);
    expect(document.querySelector('[data-page-card="created"]')!.textContent).toContain('New page 性能 · empty');
  });

  it('shows the conversation start_conversation opened, with its runtime and workspace', () => {
    const started = {
      id: 't6', title: 'Running: @michi/start_conversation', status: 'completed', kind: 'other',
      output: kiro({ status: 'started', conversation: { kind: 'michiConversationStart', nodeId: 'n-new', treeId: 't', workspaceId: 'ws-r', workspaceName: 'rabbitholes', title: '跑完事务回滚用例', runtimeId: 'kiro', modelId: null, startedFromPageId: 'pg-r' } }),
    } as ToolCallState;
    const declined = { ...started, id: 't7', output: kiro({ status: 'declined', next: 'x' }) } as ToolCallState;
    render(<MetaChatCards tools={[started, declined]} context={context} />);
    const card = document.querySelector<HTMLElement>('[data-conversation-card="started"]')!;
    expect(card.textContent).toContain('New conversation 跑完事务回滚用例Kiro · rabbitholes · running');
    expect(card.querySelector('[data-node="n-new"]')!.textContent).toBe('Open conversation →');
    expect(document.querySelector('[data-conversation-card="declined"]')!.textContent).toContain('you declined');
  });

  it('renders nothing for reads and failed writes', async () => {
    const read = { id: 't8', title: 'read_page', status: 'completed', kind: 'other', output: '{}' } as ToolCallState;
    const { container } = render(<MetaChatCards tools={[read, { ...editTool('t9', { applied: [block('c1', 1, 'x')] }), status: 'failed' }]} context={context} />);
    await waitFor(() => expect(container.innerHTML).toBe(''));
  });

  describe('layout rule card', () => {
    const limit = { section: 'stalled', maxAgeDays: 3 };
    const added = { id: 'rule-1', text: 'Stalled: only the last 3 days', sectionLimit: limit };
    const stored = { ...added, sourceMessage: { nodeId: 'assistant', turnId: 'turn-9', messageId: 'u-9' }, createdBy: 'agent', createdAt: 1 };
    const ruleTool = (id: string, result: unknown): ToolCallState => ({ id, title: 'Running: @michi/layout_rules', status: 'completed', kind: 'other',
      inputJson: JSON.stringify({ action: 'add', pageId: 'pg-home' }), output: kiro(result) } as ToolCallState);
    const saved = ruleTool('r1', { added, next: 'x', page: { id: 'pg-home', title: 'Home' }, layoutRules: [added] });
    beforeEach(() => {
      for (const fn of Object.values(rulesApi)) fn.mockReset();
      rulesApi.fetchLayoutRules.mockResolvedValue([stored]);
      rulesApi.deleteLayoutRule.mockResolvedValue([]);
      rulesApi.addLayoutRule.mockResolvedValue({ ...stored, id: 'rule-2', createdBy: 'user' });
    });

    it('shows a stored rule like a page write, and Undo deletes it, Restore adds it back with its limit', async () => {
      render(<MetaChatCards tools={[saved]} context={context} />);
      const card = document.querySelector<HTMLElement>('[data-rule-card]')!;
      expect(card.textContent).toContain('Updated Home · saved as a layout rule: “Stalled: only the last 3 days”');
      await waitFor(() => expect(rulesApi.fetchLayoutRules).toHaveBeenCalledWith('pg-home', 'local'));
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })); });
      expect(rulesApi.deleteLayoutRule).toHaveBeenCalledWith('pg-home', 'rule-1', 'local');
      expect(card.className).toContain('is-undone');
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Restore' })); });
      expect(rulesApi.addLayoutRule).toHaveBeenCalledWith('pg-home', { text: added.text, sourceMessage: stored.sourceMessage, sectionLimit: limit }, 'local');
      expect(card.className).not.toContain('is-undone');

      // The restored rule has a new id; a second Undo finds it by its text and limit.
      rulesApi.fetchLayoutRules.mockResolvedValue([{ ...stored, id: 'rule-2' }]);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })); });
      expect(rulesApi.deleteLayoutRule).toHaveBeenLastCalledWith('pg-home', 'rule-2', 'local');
    });

    it('reads back a rule deleted since, and opens the page\'s Layout rules list with View', async () => {
      rulesApi.fetchLayoutRules.mockResolvedValue([]);
      render(<MetaChatCards tools={[saved]} context={context} />);
      expect(await screen.findByRole('button', { name: 'Restore' })).toBeTruthy();
      rulesApi.fetchLayoutRules.mockResolvedValue([stored]);
      fireEvent.click(screen.getByRole('button', { name: 'View' }));
      expect(openSpacesPage).toHaveBeenCalledWith({ pageId: 'pg-home', backendConnectionId: 'local', currentPageId: 'pg-home' });
      const list = await screen.findByRole('dialog', { name: 'Layout rules' });
      expect(await within(list).findByText('Stalled: only the last 3 days')).toBeTruthy();
    });

    it('makes no card for listing or removing rules', async () => {
      const listed = ruleTool('r2', { page: { id: 'pg-home', title: 'Home' }, layoutRules: [added] });
      const removed = ruleTool('r3', { removed: 'rule-1', page: { id: 'pg-home', title: 'Home' }, layoutRules: [] });
      const { container } = render(<MetaChatCards tools={[listed, removed]} context={context} />);
      await waitFor(() => expect(container.innerHTML).toBe(''));
    });
  });

  it('says how many tasks a write made, and undoes them as one batch', async () => {
    api.revertPageBatch.mockResolvedValue({ reverted: ['c1', 'c2', 'c3'], conflicts: [] });
    render(<MetaChatCards tools={[tasksTool('t-tasks', [taskRow('c1', 'Ship', false), taskRow('c2', 'Docs', false), taskRow('c3', 'Tests', true)], { added: 2, updated: 1, removed: 0 })]} context={context} />);
    const card = document.querySelector<HTMLElement>('[data-page-card]')!;
    expect(card.querySelector('.meta-chat-card__label')!.textContent).toBe('Created 2 tasks, updated 1');
    expect(screen.queryByRole('button', { name: 'View' })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })); });
    expect(api.revertPageBatch).toHaveBeenCalledWith('batch-t', { backendConnectionId: 'local', workspaceId: 'ws-r' });
    expect(card.className).toContain('is-undone');
  });

  describe('a full task-database receipt, after a reload', () => {
    const tool = (id: string) => tasksTool(id, [taskRow('r1', 'A', false), taskRow('r2', 'B', false)], { added: 2, updated: 0, removed: 0 });

    it('offers Restore when its batch is reverted', async () => {
      api.fetchPageBatchState.mockResolvedValue({ applied: 0, reverted: 2 });
      render(<MetaChatCards tools={[tool('t-db-rev')]} context={context} />);
      expect(await screen.findByRole('button', { name: 'Restore' })).toBeTruthy();
      expect(api.fetchPageBatchState).toHaveBeenCalledWith('batch-t', { backendConnectionId: 'local', workspaceId: 'ws-r' });
    });

    it('keeps Undo when its batch is applied, or only partly reverted after a conflict', async () => {
      api.fetchPageBatchState.mockResolvedValue({ applied: 1, reverted: 1 });
      render(<MetaChatCards tools={[tool('t-db-mixed')]} context={context} />);
      await waitFor(() => expect(api.fetchPageBatchState).toHaveBeenCalled());
      expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
    });
  });

  describe('a receipt recovered from cut-off output, after a reload', () => {
    const cutOff = (id: string) => {
      const full = JSON.parse(editTool(id, { applied: [block('c1', 7, 'x')] }).output as string).items[0].Json.content[0].text as string;
      const { michiPageWrite } = JSON.parse(full);
      const text = JSON.stringify({ michiPageWrite, result: { applied: [block('c1', 7, 'x'.repeat(400))] } });
      return { ...editTool(id), output: JSON.stringify({ items: [{ Json: { content: [{ type: 'text', text }] } }] }).slice(0, 500) };
    };

    it('offers Restore when its batch is reverted', async () => {
      api.fetchPageBatchState.mockResolvedValue({ applied: 0, reverted: 2 });
      render(<MetaChatCards tools={[cutOff('t-cut-reverted')]} context={context} />);
      expect(await screen.findByRole('button', { name: 'Restore' })).toBeTruthy();
      expect(api.fetchPageBatchState).toHaveBeenCalledWith('batch-1', { backendConnectionId: 'local', workspaceId: 'ws-r' });
      expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    });

    it('keeps Undo when its batch is applied', async () => {
      api.fetchPageBatchState.mockResolvedValue({ applied: 2, reverted: 0 });
      render(<MetaChatCards tools={[cutOff('t-cut-applied')]} context={context} />);
      await waitFor(() => expect(api.fetchPageBatchState).toHaveBeenCalled());
      expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
    });
  });

  it('undoes a receipt recovered from cut-off output, and Restore redoes the whole batch', async () => {
    api.revertPageBatch.mockResolvedValue({ reverted: ['c1'], conflicts: [] });
    const full = JSON.parse(editTool('t-cut', { applied: [block('c1', 7, 'x')] }).output as string).items[0].Json.content[0].text as string;
    const { michiPageWrite } = JSON.parse(full);
    // The runtime cuts the output inside the result; the receipt leads, so it survives.
    const text = JSON.stringify({ michiPageWrite, result: { applied: [block('c1', 7, 'x'.repeat(400))] } });
    const tool = { ...editTool('t-cut'), output: JSON.stringify({ items: [{ Json: { content: [{ type: 'text', text }] } }] }).slice(0, 500) };
    expect(() => JSON.parse(tool.output)).toThrow();
    render(<MetaChatCards tools={[tool]} context={context} />);
    const card = document.querySelector<HTMLElement>('[data-page-card]')!;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })); });
    expect(api.revertPageBatch).toHaveBeenCalledWith('batch-1', { backendConnectionId: 'local', workspaceId: 'ws-r' });
    expect(card.className).toContain('is-undone');
    expect(card.textContent).toContain('undone');
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    api.redoPageBatch.mockResolvedValue({ redone: ['c1'], conflicts: [] });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Restore' })); });
    expect(api.redoPageBatch).toHaveBeenCalledWith('batch-1', { backendConnectionId: 'local', workspaceId: 'ws-r' });
    expect(api.changePageChange).not.toHaveBeenCalled();
    expect(card.className).not.toContain('is-undone');
    expect(card.textContent).not.toContain('undone');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  it('opens the page the reply put the task board on, and says it added the board', () => {
    const board = editTool('t-board', { applied: [{ id: 'c9', seq: 9, batchId: 'batch-1', op: 'insert', after: { kind: 'block', exists: true, block: { type: 'task-view' } } }] });
    render(<MetaChatCards tools={[tasksTool('t-tasks', [taskRow('c1', 'Ship', false)], { added: 1, updated: 0, removed: 0 }), board]} context={context} />);
    const cards = [...document.querySelectorAll<HTMLElement>('[data-page-card]')];
    expect(cards.map((card) => card.querySelector('.meta-chat-card__label')!.textContent)).toEqual(['Created 1 task', 'Added a task board to rabbitholes']);
    fireEvent.click(within(cards[0]!).getByRole('button', { name: 'View' }));
    expect(openSpacesPage).toHaveBeenCalledWith({ pageId: 'pg-r', workspaceId: 'ws-r', backendConnectionId: 'local', currentPageId: 'pg-home' });
  });

  it('opens each workspace\'s own board, and offers no View when only another workspace got one', () => {
    const board = editTool('t-board', { pageId: 'pg-a', workspaceId: 'ws-a', applied: [{ id: 'c9', seq: 9, batchId: 'batch-1', op: 'insert', after: { kind: 'block', exists: true, block: { type: 'task-view' } } }] });
    render(<MetaChatCards tools={[
      tasksTool('t-a', [taskRow('c1', 'Ship', false)], { added: 1, updated: 0, removed: 0 }, [], 'ws-a'),
      tasksTool('t-b', [taskRow('c2', 'Docs', false)], { added: 1, updated: 0, removed: 0 }, [], 'ws-b'),
      board,
    ]} context={context} />);
    const cards = [...document.querySelectorAll<HTMLElement>('[data-page-card]')];
    expect(within(cards[1]!).queryByRole('button', { name: 'View' })).toBeNull();
    fireEvent.click(within(cards[0]!).getByRole('button', { name: 'View' }));
    expect(openSpacesPage).toHaveBeenCalledWith(expect.objectContaining({ pageId: 'pg-a', workspaceId: 'ws-a' }));
  });

  it('says what else the board write changed', () => {
    const insert = { id: 'c9', seq: 9, batchId: 'batch-1', op: 'insert', after: { kind: 'block', exists: true, block: { type: 'task-view' } } };
    render(<MetaChatCards tools={[editTool('t1', { applied: [insert, block('c10', 10, 'Note')] }), editTool('t2', { applied: [insert, block('c11', 11, 'A'), block('c12', 12, 'B')] })]} context={context} />);
    const labels = [...document.querySelectorAll('.meta-chat-card__label')].map((el) => el.textContent);
    expect(labels).toEqual(['Added a task board to rabbitholes · and 1 more change', 'Added a task board to rabbitholes · and 2 more changes']);
  });
});
