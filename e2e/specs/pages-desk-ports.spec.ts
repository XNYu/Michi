import { expect, test, type Page } from '@playwright/test';
import type { PageBlock, PageDto } from 'michi-shared';
import { installMockApi } from '../fixtures/mockApi';
import { createPagesMockController } from '../fixtures/pagesFixtures';
import { openArea } from '../fixtures/shell';

const PAGE_ID = 'ports-page';
const WORKSPACE_ID = 'ws-ports';
const title = 'Pages integration';

async function openDocument(page: Page) {
  await openArea(page, 'spaces');
  const sidebar = page.locator('.spaces-side');
  const row = sidebar.getByRole('button', { name: title, exact: true });
  if (!(await row.isVisible())) await sidebar.getByRole('button', { name: 'Expand Ports review', exact: true }).click();
  await row.click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
}

async function setup(page: Page, blocks: PageBlock[]) {
  const mock = createPagesMockController();
  const document: PageDto = { id: PAGE_ID, workspaceId: WORKSPACE_ID, parentId: null, position: 0, title, color: null,
    updatedAt: 1, updatedBy: 'user', pendingProposals: 0, helperNodeId: null, revision: 1, viewVersion: 1, blocks };
  mock.pages.set(PAGE_ID, document);
  const errors: string[] = [];
  const external: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/api\/desk|:4317\//.test(request.url())) external.push(request.url()); });
  await page.addInitScript(() => {
    localStorage.setItem('michi:prefs', JSON.stringify({ onboardingCompletedAt: 1, terminalPalette: 'bone' }));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:metaChat:window:v1', JSON.stringify({ form: 'float', minimized: true, rect: null, dockRatio: 50 }));
  });
  await installMockApi(page, { workspaces: [{
    workspace: { id: WORKSPACE_ID, name: 'Ports review', created_at: 1, active_tree_id: 'source-tree' },
    trees: [{ id: 'source-tree', workspace_id: WORKSPACE_ID, root_node_id: 'source-a', name: 'Sources', created_at: 1 }],
    nodes: [
      { id: 'source-a', workspace_id: WORKSPACE_ID, tree_id: 'source-tree', kind: 'chat', title: 'Alpha evidence', status: 'idle', created_at: 1 },
      { id: 'source-b', workspace_id: WORKSPACE_ID, tree_id: 'source-tree', kind: 'chat', title: 'Beta evidence', status: 'idle', created_at: 1 },
    ], messages: [], edges: [], contexts: [], artifacts: [],
  }], custom: mock.handle });
  await page.goto('/');
  await expect(page.locator('.home-page')).toBeVisible();
  await openDocument(page);
  return { mock, errors, external };
}

test('plus opens a focused text editor directly and keeps other block types accessible', async ({ page }, testInfo) => {
  const { mock, errors, external } = await setup(page, [{ id: 'intro', rev: 1, type: 'markdown', text: 'Existing text' }]);
  const block = page.locator('[data-block-id="intro"]').first();
  await block.hover();
  await block.getByRole('button', { name: 'Add block below' }).click();
  const editor = block.getByRole('textbox', { name: 'New text' });
  await expect(editor).toBeFocused();
  await expect(page.getByRole('menu', { name: 'Add below' })).toHaveCount(0);
  await editor.fill('My new paragraph');
  await block.getByRole('button', { name: 'Other blocks' }).click();
  await page.getByRole('menuitem', { name: 'Heading', exact: true }).click();
  await expect(block.getByRole('textbox', { name: 'New heading' })).toHaveValue('My new paragraph');
  await block.getByRole('button', { name: 'Other blocks' }).click();
  await page.getByRole('menuitem', { name: 'Text', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('direct-text-editor.png') });
  await block.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(() => mock.pages.get(PAGE_ID)?.blocks.some(item => item.type === 'markdown' && item.text === 'My new paragraph')).toBe(true);
  await page.reload();
  await openDocument(page);
  await expect(page.getByText('My new paragraph', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test('each markdown item shows only its own Sources', async ({ page }, testInfo) => {
  const a = { nodeId: 'source-a', turnId: 'turn-a', assistantId: 'message-a' };
  const b = { nodeId: 'source-b', turnId: 'turn-b', assistantId: 'message-b' };
  const { errors, external } = await setup(page, [{ id: 'items', rev: 1, type: 'markdown',
    text: '- Alpha finding\n- Beta finding\n- Personal note', sources: [a, b],
    segmentSources: [{ text: '- Alpha finding', sources: [a] }, { text: '- Beta finding', sources: [b] }, { text: '- Personal note', sources: [] }],
  }]);
  await page.locator('[data-native-segment-index="0"]').hover();
  await page.getByRole('button', { name: 'Sources for item 1', exact: true }).click();
  const alpha = page.getByRole('dialog', { name: 'Sources for Alpha finding' });
  await expect(alpha.getByText('Alpha evidence', { exact: true })).toBeVisible();
  await expect(alpha.getByText('Beta evidence', { exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.locator('[data-native-segment-index="1"]').hover();
  await page.getByRole('button', { name: 'Sources for item 2', exact: true }).click();
  const beta = page.getByRole('dialog', { name: 'Sources for Beta finding' });
  await expect(beta.getByText('Beta evidence', { exact: true })).toBeVisible();
  await expect(beta.getByText('Alpha evidence', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sources for item 3', exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('item-sources.png') });
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test('grid inserts through Components, resizes and reorders without losing content, and stacks in a narrow pane', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { mock, errors, external } = await setup(page, [{ id: 'intro', rev: 1, type: 'markdown', text: 'Arrange the page' }]);
  const intro = page.locator('[data-block-id="intro"]').first();
  await intro.hover();
  await intro.getByRole('button', { name: 'Add block below' }).click();
  await intro.getByRole('button', { name: 'Other blocks' }).click();
  await page.getByRole('menuitem', { name: 'Add component', exact: false }).click();
  const catalog = page.getByRole('region', { name: 'Built-in components' });
  await catalog.getByRole('searchbox').fill('Responsive grid');
  await catalog.getByRole('button', { name: 'Add Responsive grid to the page', exact: true }).click();
  const grid = page.locator('.space-doc .michi-doc-grid-container').first();
  await expect(grid).toBeVisible();
  await grid.getByRole('button', { name: 'Arrange layout', exact: true }).click();
  await grid.getByRole('combobox', { name: 'Current work width', exact: true }).selectOption('7');
  const saved = () => mock.pages.get(PAGE_ID)?.blocks.find(item => item.type === 'grid');
  await expect.poll(() => saved()?.regions[0].span).toBe(7);
  const region = grid.locator('[data-region-id="main"]');
  const handle = await region.getByRole('button', { name: 'Drag to resize Current work' }).boundingBox();
  const width = await grid.locator('.michi-doc-grid').evaluate(element => element.getBoundingClientRect().width);
  expect(handle).not.toBeNull();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle!.x + handle!.width / 2 - width / 12, handle!.y + handle!.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => saved()?.regions[0].span).toBe(6);
  await region.getByRole('button', { name: /Move .* later/ }).click();
  await expect.poll(() => saved()?.regions.map(item => item.id)).toEqual(['attention', 'main']);
  await grid.getByRole('button', { name: 'Done arranging' }).click();
  await page.reload();
  await openDocument(page);
  await expect(grid.locator('[data-region-id]').first()).toHaveAttribute('data-region-id', 'attention');
  await expect(grid.getByText('Keep the main details here.')).toBeVisible();
  await expect(grid.getByRole('checkbox', { name: 'Review the next step' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('grid-desktop.png') });
  await page.setViewportSize({ width: 780, height: 900 });
  const areas = await grid.locator('[data-region-id]').evaluateAll(items => items.map(item => { const r = item.getBoundingClientRect(); return { left: r.left, width: r.width, top: r.top, bottom: r.bottom }; }));
  expect(Math.abs(areas[0].left - areas[1].left)).toBeLessThan(2);
  expect(Math.abs(areas[0].width - areas[1].width)).toBeLessThan(2);
  expect(areas[1].top).toBeGreaterThanOrEqual(areas[0].bottom);
  await page.screenshot({ path: testInfo.outputPath('grid-narrow.png') });
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test('layout preferences save and reopen, and retain a draft during a conflicting update', async ({ page }, testInfo) => {
  const { mock, errors, external } = await setup(page, [{ id: 'intro', rev: 1, type: 'markdown', text: 'Write preferences for this page' }]);
  const open = async () => {
    await page.getByRole('button', { name: 'Page actions', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Layout preferences/ }).click();
  };
  await open();
  const dialog = page.getByRole('dialog', { name: 'Layout preferences', exact: true });
  const field = dialog.getByRole('textbox', { name: 'Layout preferences', exact: true });
  await field.fill('Put risks first.\nKeep the summary short.');
  await dialog.getByRole('button', { name: 'Save preferences' }).click();
  await expect.poll(() => mock.preferences.get(PAGE_ID)?.revision).toBe(1);
  await field.fill('My unsaved layout instructions');
  mock.preferences.set(PAGE_ID, { text: 'A newer saved instruction', revision: 2, updatedAt: 2, updatedBy: 'user' });
  await page.evaluate(id => window.dispatchEvent(new CustomEvent('michi:page-changed', { detail: { backendConnectionId: 'local', pageId: id } })), PAGE_ID);
  await expect(dialog.getByText('Preferences changed elsewhere.', { exact: false })).toBeVisible();
  await expect(field).toHaveValue('My unsaved layout instructions');
  await expect(dialog.getByRole('button', { name: 'Save preferences' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Keep my draft' }).click();
  await dialog.getByRole('button', { name: 'Save preferences' }).click();
  await expect.poll(() => mock.preferences.get(PAGE_ID)?.revision).toBe(3);
  await expect(dialog.getByRole('status')).toHaveText('Preferences saved.');
  await page.screenshot({ path: testInfo.outputPath('layout-preferences.png') });
  await page.keyboard.press('Escape');
  await page.reload();
  await openDocument(page);
  await open();
  await expect(field).toHaveValue('My unsaved layout instructions');
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});
