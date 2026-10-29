import type { PageChangeDto } from 'michi-shared';
import { expect, test, type Page } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';
import { createPagesMockController } from '../fixtures/pagesFixtures';
import { openArea } from '../fixtures/shell';

const apiDiagnostics = new WeakMap<object, string[]>();
const externalDeskRequests = new WeakMap<object, string[]>();

test.beforeEach(({ page }) => {
  const failures: string[] = [];
  apiDiagnostics.set(page, failures);
  const external: string[] = [];
  externalDeskRequests.set(page, external);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/desk') || url.port === '4317') external.push(request.url());
  });
  page.on('response', (response) => {
    if (/\/api\//.test(response.url()) && response.status() >= 400) {
      failures.push(`${response.request().method()} ${response.url()} -> ${response.status()}`);
    }
  });
  page.on('requestfailed', (request) => {
    const errorText = request.failure()?.errorText ?? 'unknown';
    if (/\/api\//.test(request.url()) && errorText !== 'net::ERR_ABORTED') failures.push(`${request.method()} ${request.url()} failed: ${errorText}`);
  });
});

test.afterEach(async ({ page }, testInfo) => {
  expect(externalDeskRequests.get(page), 'native Pages must never contact the external Desk service').toEqual([]);
  if (testInfo.status !== testInfo.expectedStatus) {
    console.log('Pages API failures:', apiDiagnostics.get(page)?.join('\n') || '(none)');
  }
});

async function closeNewWorkspaceDialog(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'New workspace' });
  if (await dialog.count()) await dialog.getByRole('button', { name: 'Close' }).click();
}

/**
 * Spaces always opens on its Home; Spaces live in the sidebar under their
 * workspace. The assistant window floats over the page's right side, so put
 * it away first.
 */
async function openSpaces(page: Page) {
  await openArea(page, 'spaces');
  await expect(page.locator('main.spaces-home').getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
  const assistant = page.getByRole('region', { name: 'Assistant', exact: true });
  const pill = page.getByRole('button', { name: /^Ask assistant/ });
  await assistant.or(pill).first().waitFor();
  if (await assistant.isVisible()) await assistant.getByRole('button', { name: 'Minimize', exact: true }).click();
  await expect(pill).toBeVisible();
}

async function newSpace(page: Page) {
  await page.locator('.spaces-side').getByRole('button', { name: 'New page', exact: true }).click();
  return page.locator('.spaces-modal');
}

async function openSpaceFromSidebar(page: Page, workspaceName: string, title: string) {
  const sidebar = page.locator('.spaces-side');
  const row = sidebar.getByRole('button', { name: title, exact: true });
  const expand = sidebar.getByRole('button', { name: `Expand ${workspaceName}`, exact: true });
  await row.or(expand).first().waitFor();
  if (!(await row.isVisible())) await expand.click();
  await row.click();
}

test('create a release Space, add a nested page, edit Risks and resolve its protected proposal', async ({ page }) => {
  const mock = createPagesMockController();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await installMockApi(page, { custom: mock.handle });
  await bootWithWorkspace(page, 'Pages E2E');
  await closeNewWorkspaceDialog(page);

  await openSpaces(page);
  const create = await newSpace(page);
  await create.getByLabel('Name').fill('Launch plan');
  await create.getByLabel('Starting point').selectOption('release');
  await create.getByRole('button', { name: 'Create page' }).click();

  const space = page.locator('main.space-doc');
  await expect(space.locator('.michi-doc-title-row').getByRole('heading', { name: 'Launch plan', exact: true })).toBeVisible();
  await expect(space.getByText('Release checklist', { exact: true }).first()).toBeVisible();

  await space.getByRole('button', { name: 'Page actions' }).click();
  await page.getByRole('menuitem', { name: 'Add a page inside' }).click();
  const newPage = page.getByRole('dialog', { name: 'New page', exact: true });
  await newPage.getByLabel('Name').fill('Design notes');
  await newPage.getByRole('button', { name: 'Create page', exact: true }).click();
  await expect(space.locator('.michi-doc-title-row').getByRole('heading', { name: 'Design notes', exact: true })).toBeVisible();
  // The new page sits under its Space in the sidebar.
  await page.locator('.spaces-side').getByRole('button', { name: 'Expand Pages E2E', exact: true }).click();
  await expect(page.locator('.spaces-side').getByRole('button', { name: 'Design notes', exact: true })).toBeVisible();

  // Return to the parent and open its actual page surface beside the chat pane.
  await openSpaceFromSidebar(page, 'Pages E2E', 'Launch plan');
  await expect(space.getByRole('heading', { name: 'Risks', exact: true })).toBeVisible();
  const risks = space.getByRole('group', { name: 'Confirm the launch date.' });
  const risksId = await risks.getAttribute('data-block-id');
  await risks.hover();
  await risks.getByRole('button', { name: 'Edit' }).click();
  const editor = risks.getByRole('textbox', { name: 'Edit Confirm the launch date.' });
  await editor.fill('Confirm the launch date by Friday.');
  await risks.getByRole('button', { name: 'Save' }).click();
  // The change is exposed next to its target block. History is collapsed by
  // default, and the helper also mirrors unseen activity, so use the adjacent
  // target card as the live control surface.
  // This target wrapper persists as the same proposal moves from pending to
  // accepted, reverted, and redone. Avoid filtering it by pending-only copy.
  const suggestion = space.locator('.page-change-targets').first();
  await expect(suggestion).toContainText('You edited this, so it asks first');
  await suggestion.getByRole('button', { name: 'Accept', exact: true }).click();
  // Accepted blocks have no source/Undo footer; history remains in Activity.
  await space.locator(`[data-block-id="${risksId}"]`).hover();
  await expect(space.locator(`[data-block-id="${risksId}"]`).locator('.page-change-targets')).toHaveCount(0);
  await space.getByRole('button', { name: 'Page actions' }).click();
  await page.getByRole('menuitem', { name: /^Activity/ }).click();
  const activity = space.getByRole('region', { name: 'Activity', exact: true });
  await activity.locator('summary').click();
  await activity.getByRole('button', { name: 'Undo', exact: true }).click();
  await activity.getByRole('button', { name: 'Restore', exact: true }).click();

  await page.getByRole('button', { name: 'Open beside chat' }).click();
  await expect(page.locator('[data-pane-width-mode]')).toBeVisible();
  await expect(page.locator('.pane-entry-surface').filter({ hasText: 'Launch plan' })).toBeVisible();
  expect(mock.writes.map((write) => write.path)).toEqual(expect.arrayContaining([
    expect.stringMatching(/\/workspaces\/[^/]+\/pages$/),
    expect.stringMatching(/\/pages\/page-1\/edits$/),
    expect.stringMatching(/\/page-changes\/change-\d+\/accept$/),
    expect.stringMatching(/\/page-changes\/change-\d+\/revert$/),
    expect.stringMatching(/\/page-changes\/change-\d+\/redo$/),
  ]));
  expect(errors).toEqual([]);
});

test('sidebar page menus create, rename, move and trash nested pages', async ({ page }, testInfo) => {
  const mock = createPagesMockController();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await installMockApi(page, { custom: mock.handle });
  await bootWithWorkspace(page, 'Page menus');
  await closeNewWorkspaceDialog(page);
  await openSpaces(page);
  const create = await newSpace(page);
  await create.getByLabel('Name').fill('Release');
  await create.getByRole('button', { name: 'Create page' }).click();
  const sidebar = page.locator('.spaces-side');
  await sidebar.getByRole('button', { name: 'Expand Page menus', exact: true }).click();
  const openMenu = async (title: string) => {
    await sidebar.getByRole('button', { name: title, exact: true }).hover();
    await sidebar.getByRole('button', { name: `Actions for ${title}`, exact: true }).click();
  };
  const addPage = async (parent: string, title: string) => {
    await openMenu(parent);
    await page.getByRole('menuitem', { name: 'Add a page inside', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New page', exact: true });
    await dialog.getByLabel('Name').fill(title);
    await dialog.getByRole('button', { name: 'Create page', exact: true }).click();
    await expect(sidebar.getByRole('button', { name: title, exact: true })).toBeVisible();
  };
  await addPage('Release', 'Design notes');
  await addPage('Release', 'Review');
  const heading = page.locator('main.space-doc .michi-doc-title-row h1');
  await expect(heading).toHaveText('Review');
  await openMenu('Design notes');
  await expect(heading).toHaveText('Review');
  await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('sidebar-child-menu.png'), animations: 'disabled' });
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await page.getByRole('dialog', { name: 'Rename page' }).getByLabel('Name').fill('Design decisions');
  await page.screenshot({ path: testInfo.outputPath('sidebar-rename-dialog.png'), animations: 'disabled' });
  await page.getByRole('dialog', { name: 'Rename page' }).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sidebar.getByRole('button', { name: 'Design decisions', exact: true })).toBeVisible();
  await expect(heading).toHaveText('Review');

  await sidebar.getByRole('button', { name: 'Design decisions', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move…', exact: true }).click();
  const move = page.getByRole('dialog', { name: 'Move page', exact: true });
  await move.getByLabel('Move under').selectOption({ label: 'Review' });
  await move.getByRole('button', { name: 'Move', exact: true }).click();
  await expect.poll(() => mock.pages.get('page-2')?.parentId).toBe('page-3');
  await expect(sidebar.locator('[data-page-id="page-2"]')).toHaveCSS('--page-depth', '2');
  await sidebar.getByRole('button', { name: 'Design decisions', exact: true }).click();
  await expect(heading).toHaveText('Design decisions');
  await openMenu('Review');
  await page.getByRole('menuitem', { name: 'Move to trash', exact: true }).click();
  const trash = page.getByRole('dialog', { name: 'Move to trash', exact: true });
  await trash.getByRole('button', { name: 'Cancel' }).click();
  expect(mock.pages.has('page-3')).toBe(true);
  await openMenu('Review');
  await page.getByRole('menuitem', { name: 'Move to trash', exact: true }).click();
  await trash.getByRole('button', { name: 'Move to trash', exact: true }).click();
  await expect(sidebar.getByRole('button', { name: 'Review', exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: 'Design decisions', exact: true })).toHaveCount(0);
  await expect(page.locator('main.space-doc')).toHaveCount(0);
  expect(mock.pages.has('page-1')).toBe(true);
  expect(errors).toEqual([]);
});

test('a failed page read keeps the last saved document visible and offers Retry', async ({ page }) => {
  const mock = createPagesMockController();
  await installMockApi(page, { custom: mock.handle });
  await bootWithWorkspace(page, 'Pages offline E2E');
  await closeNewWorkspaceDialog(page);

  await openSpaces(page);
  const create = await newSpace(page);
  await create.getByLabel('Name').fill('Cached notes');
  await create.getByLabel('Starting point').selectOption('release');
  await create.getByRole('button', { name: 'Create page' }).click();
  const space = page.locator('main.space-doc');
  await expect(space.locator('.michi-doc-title-row').getByRole('heading', { name: 'Cached notes', exact: true })).toBeVisible();
  await expect(space.locator('.michi-doc-meta')).not.toContainText('edits paused');
  await openSpaces(page);
  mock.setPageReadUnavailable('page-1', true);
  const failedRead = page.waitForResponse((response) => response.url().includes('/api/pages/page-1') && response.status() === 503);
  await openSpaceFromSidebar(page, 'Pages offline E2E', 'Cached notes');
  await failedRead;
  await expect(space.getByRole('status').filter({ hasText: 'This page is showing its last saved version. Reconnect and retry before editing.' })).toBeVisible();
  await expect(space.locator('.michi-doc-title-row').getByRole('heading', { name: 'Cached notes', exact: true })).toBeVisible();
  // A stale cached document stays readable, while editable controls are withheld.
  await expect(space.getByRole('group', { name: 'Confirm the launch date.' }).getByRole('button', { name: 'Edit' })).toHaveCount(0);
  expect(mock.writes.some((write) => write.path === '/pages/page-1/edits')).toBe(false);
  mock.setPageReadUnavailable('page-1', false);
  await space.locator('.space-doc__notice[role="alert"]').getByRole('button', { name: 'Retry' }).click();
  await expect(space.locator('.michi-doc-meta')).not.toContainText('edits paused');
});

test('a checklist row edit is shared by its Table and Board views', async ({ page }) => {
  const mock = createPagesMockController();
  await installMockApi(page, { custom: mock.handle });
  await bootWithWorkspace(page, 'Pages database E2E');
  await closeNewWorkspaceDialog(page);

  await openSpaces(page);
  const create = await newSpace(page);
  await create.getByLabel('Name').fill('Release checklist');
  await create.getByLabel('Starting point').selectOption('release');
  await create.getByRole('button', { name: 'Create page' }).click();

  const space = page.locator('main.space-doc');
  const database = page.locator('[data-native-database][data-database-id="database-1"]');
  await expect(database).toBeVisible();
  await database.getByRole('tab', { name: 'Table' }).click();
  const table = database.getByRole('table', { name: 'Table' });
  const row = table.getByRole('row').filter({ hasText: 'Draft launch checklist' });
  await row.getByText('Draft launch checklist', { exact: true }).dblclick();
  // Editing replaces the clicked cell, so resolve the textbox from the page
  // surface rather than from the table's pre-edit accessibility subtree.
  const taskEditor = page.getByRole('textbox', { name: 'Edit Task' });
  await taskEditor.fill('Complete smoke test');
  await taskEditor.press('Enter');
  const editedRow = table.getByRole('row').filter({ hasText: 'Complete smoke test' });
  await expect(editedRow).toContainText('Complete smoke test');
  await database.getByRole('tab', { name: 'Board' }).click();
  await expect(database.getByText('Complete smoke test', { exact: true })).toBeVisible();
  expect(mock.writes.some((write) => write.path === '/databases/database-1/edits'
    && JSON.stringify(write.body).includes('Complete smoke test'))).toBe(true);
  await expect(space.locator('.michi-doc-title-row').getByRole('heading', { name: 'Release checklist', exact: true })).toBeVisible();
});

test('a database revision conflict preserves the edit draft and commits it on retry', async ({ page }) => {
  const mock = createPagesMockController();
  await installMockApi(page, { custom: mock.handle });
  await bootWithWorkspace(page, 'Pages shared database E2E');
  await closeNewWorkspaceDialog(page);

  await openSpaces(page);
  const create = await newSpace(page);
  await create.getByLabel('Name').fill('Shared checklist');
  await create.getByLabel('Starting point').selectOption('release');
  await create.getByRole('button', { name: 'Create page' }).click();

  mock.failNextDatabaseEdit('database-1');
  await expect(page.locator('main.space-doc [data-native-database][data-database-id="database-1"]')).toBeVisible();
  await page.getByRole('button', { name: 'Open beside chat' }).click();
  const pagePane = page.locator('[data-native-page-pane][data-page-id="page-1"]');
  const paneDatabase = pagePane.locator('[data-native-database][data-database-id="database-1"]');
  await expect(paneDatabase).toBeVisible();
  const paneTable = paneDatabase.getByRole('table');
  const draftRow = paneTable.getByRole('row').filter({ hasText: 'Draft launch checklist' });
  await draftRow.getByText('Draft launch checklist', { exact: true }).dblclick();
  const taskEditor = pagePane.getByRole('textbox', { name: 'Edit Task' });
  await taskEditor.fill('Complete smoke test');
  await taskEditor.press('Enter');

  // Another writer changed the row before this edit committed. The 409 must
  // retain the user's draft while both open surfaces refresh to server state.
  await expect(paneDatabase.getByRole('alert')).toContainText('This database just changed, so it was refreshed. Try again.');
  await expect(paneDatabase.getByText('Server edit from another pane', { exact: true })).toBeVisible();
  await paneDatabase.getByRole('button', { name: 'Retry saving draft' }).click();

  // Retrying the preserved draft commits the user's value. Reopening the Space
  // checks that the committed value survives a fresh page/database read.
  await expect(paneDatabase.getByText('Complete smoke test', { exact: true })).toBeVisible();
  const databaseWrites = mock.writes.filter((write) => write.path === '/databases/database-1/edits');
  expect(databaseWrites).toHaveLength(2);
  expect(JSON.stringify(databaseWrites[1].body)).toContain('Complete smoke test');
  await openSpaces(page);
  await openSpaceFromSidebar(page, 'Pages shared database E2E', 'Shared checklist');
  const reopenedDatabase = page.locator('main.space-doc [data-native-database][data-database-id="database-1"]');
  await expect(reopenedDatabase.getByText('Complete smoke test', { exact: true })).toBeVisible();
});

test('remote Space creation stays on the selected backend and uses server IDs in its API path', async ({ page }) => {
  const mock = createPagesMockController();
  const connection = { id: 'pages-remote', name: 'Pages server', transport: 'direct', apiUrl: 'http://127.0.0.1:3001/api', hasToken: true, createdAt: 1, updatedAt: 1 };
  const remoteWorkspace = {
    workspace: { id: 'remote-ws', name: 'Remote research', cwd: '/srv/research', created_at: 2 },
    trees: [], nodes: [], edges: [], messages: [], contexts: [], artifacts: [],
  };
  await page.addInitScript(() => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1 }));
    localStorage.setItem('michi:migrated', '1');
  });
  await installMockApi(page, { workspaces: [{
    workspace: { id: 'local-ws', name: 'Local notes', created_at: 1 },
    trees: [], nodes: [], edges: [], messages: [], contexts: [], artifacts: [],
  }], custom: async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/backend-connections') {
      await route.fulfill({ json: { connections: [connection] } });
      return true;
    }
    if (path === '/api/backend-connections/pages-remote/proxy/workspaces/all'
      || path === '/api/backend-connections/pages-remote/proxy/workspaces') {
      await route.fulfill({ json: { workspaces: [remoteWorkspace] } });
      return true;
    }
    return mock.handle(route);
  } });
  await page.goto('/');
  await closeNewWorkspaceDialog(page);
  await openSpaces(page);
  const create = await newSpace(page);
  const backendSelect = create.getByLabel('Backend');
  await backendSelect.selectOption('pages-remote');
  await expect(backendSelect).toHaveValue('pages-remote');
  const workspaceSelect = create.locator('label').filter({ hasText: /^Workspace/ }).locator('select');
  await expect(workspaceSelect.locator('option[value="remote:pages-remote:remote-ws"]')).toBeAttached();
  await workspaceSelect.selectOption('remote:pages-remote:remote-ws');
  await expect(workspaceSelect).toHaveValue('remote:pages-remote:remote-ws');
  await create.getByLabel('Name').fill('Remote notes');
  await create.getByRole('button', { name: 'Create page' }).click();
  await expect(page.locator('main.space-doc .michi-doc-title-row').getByRole('heading', { name: 'Remote notes', exact: true })).toBeVisible();
  expect(mock.rawPaths).toContain('/api/backend-connections/pages-remote/proxy/workspaces/remote-ws/pages');
  expect(mock.rawPaths).not.toContain('/api/workspaces/remote-ws/pages');
});



test('block handles persist pointer sorting, cancel drags, and expose native block actions', async ({ page }, testInfo) => {
  const mock = createPagesMockController();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await installMockApi(page, { custom: mock.handle });
  await bootWithWorkspace(page, 'Block controls');
  await closeNewWorkspaceDialog(page);
  await openSpaces(page);
  const create = await newSpace(page);
  await create.getByLabel('Name').fill('Sortable notes');
  await create.getByLabel('Starting point').selectOption('release');
  await create.getByRole('button', { name: 'Create page' }).click();
  const space = page.locator('main.space-doc');
  const blocks = space.locator('[data-native-page] > .michi-doc-block[data-top]');
  await expect(blocks).toHaveCount(8);
  const ids = await blocks.evaluateAll(items => items.map(item => item.getAttribute('data-block-id')));
  const first = space.locator(`[data-block-id="${ids[0]}"]`);
  const second = space.locator(`[data-block-id="${ids[1]}"]`);
  await first.hover();
  const handle = first.getByRole('button', { name: 'Block menu' });
  const origin = (await handle.boundingBox())!;
  const destination = (await second.boundingBox())!;
  await page.mouse.move(origin.x + origin.width / 2, origin.y + origin.height / 2);
  await page.mouse.down();
  await page.mouse.move(destination.x + 20, destination.y + destination.height - 4, { steps: 12 });
  await expect(page.locator('.native-page-drop')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('block-drag.png') });
  await page.mouse.up();
  await expect.poll(() => mock.pages.get('page-1')?.blocks.map(block => block.id)).toEqual([ids[1], ids[0], ...ids.slice(2)]);
  await expect(blocks.first()).toHaveAttribute('data-block-id', ids[1]!);
  await expect(page.getByRole('menu')).toHaveCount(0);
  const moveWrite = mock.writes.find(write => (write.body.ops as Array<{ op: string }> | undefined)?.some(op => op.op === 'move'))!;
  expect(moveWrite.body).toEqual({ revision: 2, ops: [{ op: 'move', id: ids[0], after: ids[1], expectRev: 1 }] });

  // A second drag cancelled with Escape does not persist a second move.
  const writesBefore = mock.writes.length;
  await second.hover();
  const cancelOrigin = (await second.getByRole('button', { name: 'Block menu' }).boundingBox())!;
  await page.mouse.move(cancelOrigin.x + 5, cancelOrigin.y + 5);
  await page.mouse.down();
  await page.mouse.move(cancelOrigin.x + 30, cancelOrigin.y + 130, { steps: 5 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.native-page-drop')).toHaveCount(0);
  expect(mock.writes.length).toBe(writesBefore);

  // The saved order survives leaving and reopening the page.
  await openSpaces(page);
  await openSpaceFromSidebar(page, 'Block controls', 'Sortable notes');
  await expect(blocks.first()).toHaveAttribute('data-block-id', ids[1]!);
  await second.hover();
  await expect(page.locator('.spaces-side__footer [role="status"]')).toHaveCount(0);
  const selectButton = second.getByRole('toolbar').getByRole('button', { name: 'Select', exact: true });
  await selectButton.hover();
  await expect(page.getByRole('tooltip')).toHaveText('Select');
  await page.screenshot({ path: testInfo.outputPath('block-toolbar-tooltip.png') });
  await second.getByRole('button', { name: 'Block menu' }).click();
  const menu = page.getByRole('menu', { name: /^Block menu/ });
  await expect(menu.getByRole('menuitem')).toHaveText(['Select', 'Ask', 'Sources', 'Ignore', 'Archive', 'Copy text']);
  await page.screenshot({ path: testInfo.outputPath('block-menu.png') });
  await menu.getByRole('menuitem', { name: 'Ignore', exact: true }).click();
  await expect.poll(() => Boolean(mock.pages.get('page-1')?.blocks.find(block => block.id === ids[1])?.edit)).toBe(true);
  await expect(second.locator('.page-change-line')).toHaveCount(0);
  await second.getByRole('button', { name: 'Block menu' }).click();
  await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
  await expect(second).toHaveCount(0);
  expect(mock.pages.get('page-1')?.blocks.some(block => block.id === ids[1])).toBe(false);
  expect(errors).toEqual([]);
});


test('database configuration suggestions show field changes and apply only after acceptance', async ({ page }) => {
  const mock = createPagesMockController();
  let suggestion: PageChangeDto | null = null;
  let accepted = false;
  await installMockApi(page, { custom: async (route) => {
    const path = new URL(route.request().url()).pathname;
    const database = mock.databases.get('database-1');
    if (database && /\/pages\/[^/]+\/changes$/.test(path)) {
      if (!suggestion) {
        const after = { ...database, revision: database.revision + 1,
          columns: database.columns.map((column, index) => index === 0 ? { ...column, name: 'Ticket / CR' } : column) };
        suggestion = { id: 'schema-suggestion', seq: 1, batchId: 'schema-batch', target: { kind: 'database', databaseId: database.id }, op: 'schema',
          before: { kind: 'database', exists: true, database: structuredClone(database) }, after: { kind: 'database', exists: true, database: after },
          forward: { kind: 'database', op: 'replace', database: after }, inverse: { kind: 'database', op: 'replace', database: structuredClone(database) },
          baseRev: database.revision, appliedRev: null, previousHeadId: null,
          source: { kind: 'chat', nodeId: 'assistant', turnId: 'turn', assistantId: 'answer' },
          proposalState: 'pending', applicationState: null, createdAt: Date.now(), resolvedAt: null };
      }
      await route.fulfill({ json: { changes: [suggestion], nextAfter: 1, nextBefore: null, hasMore: false } });
      return true;
    }
    if (database && suggestion && path.endsWith('/page-changes/schema-suggestion/accept')) {
      if (suggestion.forward.kind !== 'database') throw new Error('Expected database suggestion');
      mock.databases.set(database.id, { ...database, columns: suggestion.forward.database.columns, revision: database.revision + 1 });
      suggestion = { ...suggestion, proposalState: 'accepted', applicationState: 'applied', appliedRev: database.revision + 1, resolvedAt: Date.now() };
      accepted = true;
      await route.fulfill({ json: suggestion });
      return true;
    }
    return mock.handle(route);
  } });
  await bootWithWorkspace(page, 'Database suggestions');
  await closeNewWorkspaceDialog(page);
  await openSpaces(page);
  const create = await newSpace(page);
  await create.getByLabel('Name').fill('Ticket dashboard');
  await create.getByLabel('Starting point').selectOption('release');
  await create.getByRole('button', { name: 'Create page' }).click();
  const database = page.locator('[data-native-database][data-database-id="database-1"]');
  await database.getByRole('tab', { name: 'Table', exact: true }).click();
  const proposal = page.locator('.page-change-prop').filter({ has: page.getByRole('list', { name: 'Proposed database changes' }) });
  await expect(proposal).toContainText(/Task \(text\).*→ Ticket \/ CR \(text\)/);
  await expect(database.getByRole('columnheader', { name: 'Task', exact: true })).toBeVisible();
  expect(accepted).toBe(false);
  await proposal.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(database.getByRole('columnheader', { name: 'Ticket / CR', exact: true })).toBeVisible();
  await expect(database.getByText('Draft launch checklist', { exact: true })).toBeVisible();
  expect(accepted).toBe(true);
});
