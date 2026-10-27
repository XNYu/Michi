import { expect, test, type Locator, type Page } from '@playwright/test';
import type { PageBlock, PageDatabase, PageDto, ThreadCardItem } from 'michi-shared';
import { taskDatabaseColumns, taskDatabaseViews } from 'michi-shared';
import { installMockApi } from '../fixtures/mockApi';
import { createPagesMockController, type PagesMockController } from '../fixtures/pagesFixtures';
import { openArea } from '../fixtures/shell';

const PAGE_ID = 'task-page';
const WORKSPACE_ID = 'ws-tasks';
const title = 'Release plan';
const now = Date.now();

const card = (nodeId: string, name: string, state: ThreadCardItem['state']): ThreadCardItem =>
  ({ nodeId, workspaceId: WORKSPACE_ID, title: name, state, summary: state === 'waiting' ? 'Which name should we use?' : '', at: now - 60_000, messageId: null });
const row = (id: string, values: PageDatabase['rows'][number]['values'], position: number): PageDatabase['rows'][number] =>
  ({ id, values, position, updatedAt: now, rev: 1, edited: {}, bodyEditedAt: null });

function seedTasks(mock: PagesMockController, rows: PageDatabase['rows'], views = taskDatabaseViews()) {
  mock.databases.set('tasks-seeded', { id: 'tasks-seeded', workspaceId: WORKSPACE_ID, title: 'Tasks', role: 'tasks', revision: 1, updatedAt: now,
    columns: taskDatabaseColumns(), views, rows });
  mock.taskDatabases.set(WORKSPACE_ID, 'tasks-seeded');
}

async function setup(page: Page, blocks: PageBlock[], seed?: (mock: PagesMockController) => void) {
  const mock = createPagesMockController();
  const document: PageDto = { id: PAGE_ID, workspaceId: WORKSPACE_ID, parentId: null, position: 0, title, color: null,
    updatedAt: 1, updatedBy: 'user', pendingProposals: 0, helperNodeId: null, revision: 1, viewVersion: 1, blocks };
  mock.pages.set(PAGE_ID, document);
  mock.threadStates.set('source-a', card('source-a', 'Alpha evidence', 'waiting'));
  mock.threadStates.set('source-b', card('source-b', 'Beta evidence', 'done'));
  seed?.(mock);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('michi:prefs', JSON.stringify({ onboardingCompletedAt: 1, terminalPalette: 'bone' }));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:metaChat:window:v1', JSON.stringify({ form: 'float', minimized: true, rect: null, dockRatio: 50 }));
  });
  await installMockApi(page, { workspaces: [{
    workspace: { id: WORKSPACE_ID, name: 'Task review', created_at: 1, active_tree_id: 'source-tree' },
    trees: [{ id: 'source-tree', workspace_id: WORKSPACE_ID, root_node_id: 'source-a', name: 'Sources', created_at: 1 }],
    nodes: [
      { id: 'source-a', workspace_id: WORKSPACE_ID, tree_id: 'source-tree', kind: 'chat', title: 'Alpha evidence', status: 'idle', created_at: 1 },
      { id: 'source-b', workspace_id: WORKSPACE_ID, tree_id: 'source-tree', kind: 'chat', title: 'Beta evidence', status: 'idle', created_at: 1 },
    ], messages: [], edges: [], contexts: [], artifacts: [],
  }], custom: mock.handle });
  await page.goto('/');
  await expect(page.locator('.home-page')).toBeVisible();
  await openArea(page, 'spaces');
  const sidebar = page.locator('.spaces-side');
  const pageRow = sidebar.getByRole('button', { name: title, exact: true });
  if (!(await pageRow.isVisible())) await sidebar.getByRole('button', { name: 'Expand Task review', exact: true }).click();
  await pageRow.click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  return { mock, errors };
}

const column = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const taskCard = (scope: Locator, text: string) => scope.locator('.michi-card', { hasText: text });
const databaseEdits = (mock: PagesMockController) => mock.writes.filter((write) => write.path === '/databases/tasks-seeded/edits').map((write) => write.body.ops);

/** A pointer drag past dnd-kit's 6px start, onto the middle of the target. */
async function drag(page: Page, from: Locator, to: Locator) {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error('Nothing to drag');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + Math.min(b.height / 2, 40), { steps: 12 });
  await page.mouse.up();
}

test('adds a task board from + and a task at the foot of a column', async ({ page }) => {
  const { mock, errors } = await setup(page, [{ id: 'intro', rev: 1, type: 'markdown', text: 'Plan for the release' }]);
  const intro = page.locator('[data-block-id="intro"]').first();
  await intro.hover();
  await intro.getByRole('button', { name: 'Add block below' }).click();
  await intro.getByRole('button', { name: 'Other blocks' }).click();
  await page.getByRole('menuitem', { name: /Task board/ }).click();
  const todo = column(page, 'To do');
  await expect(todo).toBeVisible();
  await expect(page.getByText(/No tasks yet\. Ask the assistant/)).toBeVisible();
  expect(mock.writes.some((write) => write.path === `/workspaces/${WORKSPACE_ID}/task-database`)).toBe(true);
  await todo.hover();
  await todo.getByRole('button', { name: 'New task in To do' }).click();
  await todo.getByRole('textbox', { name: 'New task in To do' }).fill('Pick a schema naming rule');
  await page.keyboard.press('Enter');
  await expect(taskCard(todo, 'Pick a schema naming rule')).toBeVisible();
  await expect(taskCard(todo, 'Pick a schema naming rule')).toContainText('No conversations yet');
  expect(errors).toEqual([]);
});

test('moves a card by pointer and by keyboard, and puts a move back with Undo', async ({ page }) => {
  const { mock, errors } = await setup(page, [{ id: 'board', rev: 1, type: 'task-view' }],
    (mock) => seedTasks(mock, [row('t1', { task: 'Write the migration', status: 'todo' }, 0)]));
  await expect(taskCard(column(page, 'To do'), 'Write the migration')).toBeVisible();
  await drag(page, taskCard(column(page, 'To do'), 'Write the migration'), column(page, 'Done'));
  await expect(taskCard(column(page, 'Done'), 'Write the migration')).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(taskCard(column(page, 'To do'), 'Write the migration')).toBeVisible();
  expect(mock.writes.some((write) => write.path.endsWith('/revert'))).toBe(true);

  // Space picks it up, → moves it a column on, Space puts it down; a screen reader hears each step.
  await taskCard(column(page, 'To do'), 'Write the migration').focus();
  const announced = page.locator('[id^="DndLiveRegion"]');
  await page.keyboard.press('Space');
  await expect(announced).toContainText('Over “To do”');
  // dnd-kit measures the columns just after the pick-up; an arrow pressed before that finds nowhere to go, so press again while it is still over To do.
  await expect(async () => {
    if ((await announced.textContent())?.includes('To do')) await page.keyboard.press('ArrowRight');
    await expect(announced).toContainText('Over “In progress”', { timeout: 500 });
  }).toPass({ timeout: 5_000 });
  await page.keyboard.press('Space');
  await expect(taskCard(column(page, 'In progress'), 'Write the migration')).toBeVisible();
  await expect(announced).toContainText('Put into “In progress”');
  expect(databaseEdits(mock).at(-1)).toEqual([{ op: 'row.update', id: 't1', values: { status: 'doing' }, expectRev: expect.any(Number) }]);
  expect(errors).toEqual([]);
});

test('puts cards in order inside a column only while the view sets no order', async ({ page }) => {
  const sorted = { id: 'by-name', name: 'By name', type: 'board' as const, position: 3,
    config: { filters: [], match: 'all' as const, sorts: [{ column: 'task', dir: 'asc' as const }], group: 'status' } };
  const { mock } = await setup(page, [{ id: 'board', rev: 1, type: 'task-view' }], (mock) => seedTasks(mock, [
    row('t1', { task: 'First', status: 'todo' }, 0),
    row('t2', { task: 'Second', status: 'todo' }, 1),
  ], [...taskDatabaseViews(), sorted]));
  const todo = column(page, 'To do');
  const titles = todo.locator('.michi-card .michi-card__title');
  await expect(titles).toHaveText(['First', 'Second']);
  await drag(page, taskCard(todo, 'Second'), taskCard(todo, 'First'));
  await expect(titles).toHaveText(['Second', 'First']);
  expect(databaseEdits(mock).at(-1)).toEqual([{ op: 'row.move', id: 't2', after: null }]);

  // A view sorted by name keeps its own order: the card goes back and nothing is saved.
  await page.locator('[data-tasks]').hover();
  await page.getByRole('tab', { name: 'By name' }).click();
  const before = databaseEdits(mock).length;
  await expect(titles).toHaveText(['First', 'Second']);
  await drag(page, taskCard(todo, 'Second'), taskCard(todo, 'First'));
  await expect(titles).toHaveText(['First', 'Second']);
  expect(databaseEdits(mock)).toHaveLength(before);
});

test('adds a board inside a grid region, and links and unlinks a task’s conversations', async ({ page }) => {
  const { mock, errors } = await setup(page, [{ id: 'layout', rev: 1, type: 'grid', regions: [{ id: 'main', span: 12, blocks: [{ type: 'markdown', text: 'Release notes' }] }] }],
    (mock) => seedTasks(mock, [row('t1', { task: 'Pick a schema naming rule', status: 'doing', threads: ['source-a', 'gone'] }, 0)]));
  const section = page.locator('.michi-doc-slot').first();
  await section.hover();
  await section.getByRole('button', { name: 'Add to this section' }).click();
  await page.getByRole('menuitem', { name: /Task board/ }).click();
  const task = taskCard(column(page, 'In progress'), 'Pick a schema naming rule');
  await expect(task).toBeVisible();
  // Its conversation waits on you, so the whole card stands out.
  await expect(task).toHaveAttribute('data-attention', 'true');
  await expect(task.getByRole('button', { name: /Alpha evidence/ })).toBeVisible();

  await task.locator('.michi-card__title').click();
  const drawer = page.getByRole('dialog', { name: 'Task' });
  const links = drawer.getByRole('region', { name: 'Conversations' });
  await expect(links.getByText('This conversation is no longer here')).toBeVisible();
  await links.getByRole('button', { name: 'Unlink' }).click();
  await expect(links.getByText('This conversation is no longer here')).toHaveCount(0);
  await links.getByRole('button', { name: 'Link' }).click();
  await page.getByRole('option', { name: /Beta evidence/ }).click();
  // Leaving the list saves what is ticked.
  await drawer.locator('.michi-db-peek__db').click();
  await expect(links.getByRole('button', { name: /Beta evidence/ })).toBeVisible();
  expect(databaseEdits(mock)).toEqual([
    [{ op: 'row.update', id: 't1', values: { threads: ['source-a'] }, expectRev: 1 }],
    [{ op: 'row.update', id: 't1', values: { threads: ['source-a', 'source-b'] }, expectRev: 2 }],
  ]);
  expect(errors).toEqual([]);
});
