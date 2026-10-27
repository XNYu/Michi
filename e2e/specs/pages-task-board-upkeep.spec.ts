import { expect, test, type Locator, type Page } from '@playwright/test';
import type { PageChangeDto, PageDatabase, PageDto } from 'michi-shared';
import { taskDatabaseColumns, taskDatabaseViews } from 'michi-shared';
import { installMockApi } from '../fixtures/mockApi';
import { createPagesMockController, type PagesMockController } from '../fixtures/pagesFixtures';
import { openArea } from '../fixtures/shell';

const WORKSPACE_ID = 'ws-tasks';
const PAGE_ID = 'task-page';
const now = Date.now();

const row = (id: string, values: PageDatabase['rows'][number]['values'], position: number): PageDatabase['rows'][number] =>
  ({ id, values, position, updatedAt: now - 60_000, rev: 1, edited: {}, bodyEditedAt: null });
const tasks = (id: string, workspaceId: string, rows: PageDatabase['rows']): PageDatabase =>
  ({ id, workspaceId, title: 'Tasks', role: 'tasks', revision: 1, updatedAt: now, columns: taskDatabaseColumns(), views: taskDatabaseViews(), rows });

const suggestion: PageChangeDto = {
  id: 'chg-docs', seq: 9, batchId: 'batch-upkeep', target: { kind: 'row', databaseId: 'tasks-seeded', rowId: 'docs', columnIds: ['status'] }, op: 'row',
  before: null, after: null,
  forward: { kind: 'row', op: 'patch', id: 'docs', values: { status: 'waiting' } },
  inverse: { kind: 'row', op: 'patch', id: 'docs', values: { status: 'doing' } },
  baseRev: 1, appliedRev: null, previousHeadId: null,
  source: { kind: 'maintenance', nodeId: 'run', turnId: 'run-turn', assistantId: 'run-a', jobId: 'job', runId: 'run-1',
    evidence: [{ nodeId: `${WORKSPACE_ID}-chat`, turnId: 'turn-1', assistantId: 'answer-1' }] },
  proposalState: 'pending', applicationState: null, createdAt: now - 120_000, resolvedAt: null,
};

/** The board after an update that added a task, changed one and suggested a change to a third; Undo puts back the board before it. */
function seedUpkeep(mock: PagesMockController) {
  mock.databases.set('tasks-seeded', tasks('tasks-seeded', WORKSPACE_ID, [
    row('ship', { task: 'Ship the release', status: 'done' }, 0),
    row('notes', { task: 'Write the release notes', status: 'todo' }, 1),
    row('docs', { task: 'Review the docs', status: 'doing' }, 2),
  ]));
  mock.taskDatabases.set(WORKSPACE_ID, 'tasks-seeded');
  mock.batchSnapshots.set('batch-upkeep', { databaseId: 'tasks-seeded', before: tasks('tasks-seeded', WORKSPACE_ID, [
    row('ship', { task: 'Ship the release', status: 'doing' }, 0),
    row('docs', { task: 'Review the docs', status: 'doing' }, 2),
  ]) });
  mock.taskActivity.set('tasks-seeded', {
    suggestions: [suggestion],
    marks: [{ rowId: 'notes', kind: 'new', at: now - 120_000 }, { rowId: 'ship', kind: 'updated', at: now - 120_000 }],
    latestUpkeep: { batchId: 'batch-upkeep', at: now - 120_000, added: 1, updated: 1, removed: 0, suggested: 1,
      source: { nodeId: `${WORKSPACE_ID}-chat`, turnId: 'turn-1', assistantId: 'answer-1', title: 'Release check' } },
  });
}

async function boot(page: Page, mock: PagesMockController, workspaces: Array<{ id: string; name: string }>) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('michi:prefs', JSON.stringify({ onboardingCompletedAt: 1, terminalPalette: 'bone' }));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:metaChat:window:v1', JSON.stringify({ form: 'float', minimized: true, rect: null, dockRatio: 50 }));
  });
  await installMockApi(page, { workspaces: workspaces.map(({ id, name }) => ({
    workspace: { id, name, created_at: 1, active_tree_id: `${id}-tree` },
    trees: [{ id: `${id}-tree`, workspace_id: id, root_node_id: `${id}-chat`, name: 'Sources', created_at: 1 }],
    nodes: [{ id: `${id}-chat`, workspace_id: id, tree_id: `${id}-tree`, kind: 'chat', title: `${name} kickoff`, status: 'idle', created_at: 1 }],
    messages: [], edges: [], contexts: [], artifacts: [],
  })), custom: mock.handle });
  await page.goto('/');
  await expect(page.locator('.home-page')).toBeVisible();
  await openArea(page, 'spaces');
  return errors;
}

async function openTaskBoard(page: Page) {
  const mock = createPagesMockController();
  const document: PageDto = { id: PAGE_ID, workspaceId: WORKSPACE_ID, parentId: null, position: 0, title: 'Release plan', color: null,
    updatedAt: 1, updatedBy: 'user', pendingProposals: 0, helperNodeId: null, revision: 1, viewVersion: 1, blocks: [{ id: 'board', rev: 1, type: 'task-view' }] };
  mock.pages.set(PAGE_ID, document);
  seedUpkeep(mock);
  const errors = await boot(page, mock, [{ id: WORKSPACE_ID, name: 'Task review' }]);
  const sidebar = page.locator('.spaces-side');
  const pageRow = sidebar.getByRole('button', { name: 'Release plan', exact: true });
  if (!(await pageRow.isVisible())) await sidebar.getByRole('button', { name: 'Expand Task review', exact: true }).click();
  await pageRow.click();
  await expect(page.getByRole('heading', { name: 'Release plan', exact: true })).toBeVisible();
  return { mock, errors };
}

const column = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const taskCard = (scope: Page | Locator, text: string) => scope.locator('.michi-card', { hasText: text });

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

test("notes the Meta agent's latest update above the board, marks its cards, and undoes it", async ({ page }) => {
  const { mock, errors } = await openTaskBoard(page);
  const line = page.locator('.michi-task-upkeep');
  await expect(line).toContainText('Meta agent added 1 task, updated 1 and suggested 1 change');
  await expect(line).toContainText('from “Release check”');
  await expect(taskCard(page, 'Write the release notes').locator('[data-mark="new"]')).toHaveText('New');
  await expect(taskCard(page, 'Ship the release').locator('[data-mark="updated"]')).toHaveText('Updated');
  await expect(taskCard(page, 'Review the docs').locator('[data-mark="suggestion"]')).toHaveText('Suggestion');

  await line.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByText("Undid the Meta agent's update")).toBeVisible();
  await expect(taskCard(page, 'Write the release notes')).toHaveCount(0);
  await expect(taskCard(column(page, 'In progress'), 'Ship the release')).toBeVisible();
  await expect(line).toHaveCount(0);
  await expect(page.locator('[data-mark="new"], [data-mark="updated"]')).toHaveCount(0);
  // The suggestion is not part of what Undo puts back: it still waits on its card.
  await expect(taskCard(page, 'Review the docs').locator('[data-mark="suggestion"]')).toHaveText('Suggestion');
  expect(mock.writes.some((write) => write.path === '/page-batches/batch-upkeep/revert')).toBe(true);
  expect(errors).toEqual([]);
});

test("accepts a suggestion from the task's details", async ({ page }) => {
  const { mock, errors } = await openTaskBoard(page);
  await taskCard(page, 'Review the docs').locator('.michi-card__title').click();
  const drawer = page.getByRole('dialog', { name: 'Task' });
  await expect(drawer.getByText('Suggested: Status → Waiting on you')).toBeVisible();
  await drawer.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(taskCard(column(page, 'Waiting on you'), 'Review the docs')).toBeVisible();
  await expect(taskCard(page, 'Review the docs').locator('[data-mark="suggestion"]')).toHaveCount(0);
  expect(mock.writes.some((write) => write.path === '/page-changes/chg-docs/accept')).toBe(true);
  expect(errors).toEqual([]);
});

test("All tasks shows every workspace's tasks, changes one in its own workspace and puts it back", async ({ page }) => {
  const mock = createPagesMockController();
  mock.databases.set('tasks-a', tasks('tasks-a', 'ws-a', [row('t1', { task: 'Ship the release', status: 'todo' }, 0)]));
  mock.databases.set('tasks-b', tasks('tasks-b', 'ws-b', [
    row('t1', { task: 'Plan the launch', status: 'doing' }, 0),
    row('t2', { task: 'Book the venue', status: 'done' }, 1),
  ]));
  mock.taskDatabases.set('ws-a', 'tasks-a');
  mock.taskDatabases.set('ws-b', 'tasks-b');
  mock.workspaceNames.set('ws-a', 'Alpha');
  mock.workspaceNames.set('ws-b', 'Beta');
  const errors = await boot(page, mock, [{ id: 'ws-a', name: 'Alpha' }, { id: 'ws-b', name: 'Beta' }]);

  const entry = page.locator('.spaces-side').getByRole('button', { name: /^All tasks/ });
  await expect(entry.getByLabel('3 tasks')).toBeVisible();
  await entry.click();
  await expect(page.getByRole('heading', { level: 1, name: 'All tasks' })).toBeVisible();
  await expect(page.locator('.terminal-topbar-breadcrumb')).toContainText('All tasks');
  await expect(taskCard(page, 'Ship the release').locator('.michi-card__workspace')).toHaveText('Alpha');
  await expect(taskCard(page, 'Plan the launch').locator('.michi-card__workspace')).toHaveText('Beta');
  await expect(page.getByRole('button', { name: /^New task in/ })).toHaveCount(0);

  await drag(page, taskCard(column(page, 'To do'), 'Ship the release'), column(page, 'Done'));
  await expect(taskCard(column(page, 'Done'), 'Ship the release')).toBeVisible();
  expect(mock.writes.filter((write) => write.path === '/databases/tasks-a/edits').map((write) => write.body.ops))
    .toEqual([[{ op: 'row.update', id: 't1', values: { status: 'done' }, expectRev: 1 }]]);
  expect(mock.writes.some((write) => write.path === '/databases/tasks-b/edits')).toBe(false);

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(taskCard(column(page, 'To do'), 'Ship the release')).toBeVisible();
  expect(mock.writes.some((write) => write.path.startsWith('/page-batches/') && write.path.endsWith('/revert'))).toBe(true);
  expect(errors).toEqual([]);
});
