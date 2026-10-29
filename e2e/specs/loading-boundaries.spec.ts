import { expect, test } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';
import { createSpacesHomeMock } from '../fixtures/spacesHomeFixtures';
import { COMPOSER_EDITOR, openArea, openSettings } from '../fixtures/shell';

const workspace = {
  workspace: { id: 'loading-ws', name: 'Loading workspace', created_at: 1, active_tree_id: 'loading-tree' },
  trees: [{ id: 'loading-tree', workspace_id: 'loading-ws', root_node_id: 'loading-node', name: 'Loading conversation', created_at: 1, last_active_at: 1 }],
  nodes: [{ id: 'loading-node', tree_id: 'loading-tree', workspace_id: 'loading-ws', kind: 'chat', title: 'Loading conversation', created_at: 1, message_count: 0, status: 'idle' }],
  edges: [], messages: [], artifacts: [],
};

test('cold shell and Appearance do not request optional rendering engines', async ({ page }, info) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const optional: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.resourceType() === 'script' && /MentionEditor|LegacyHighlightedCode|shiki|mermaid|elk[._-]|katex|editor-tiptap|markdown-code|markdown-streamdown/.test(request.url())) optional.push(request.url());
  });
  await installMockApi(page, { workspaces: [workspace], custom: async route => {
    if (new URL(route.request().url()).pathname === '/api/workspaces/all') await pending;
    return false;
  } });
  await page.addInitScript(() => localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, reduceMotion: true })));
  try {
    await page.goto('/');
    await expect(page.locator('.terminal-topbar')).toBeVisible();
    await page.keyboard.press('Control+,');
    await expect(page.getByRole('dialog', { name: 'Settings' }).getByText('Palette', { exact: true })).toBeVisible();
    expect(optional).toEqual([]);
    expect(errors).toEqual([]);
    await info.attach('cold-shell-resources', { contentType: 'application/json', body: JSON.stringify(await page.evaluate(() => ({
      at: performance.now(),
      scripts: performance.getEntriesByType('resource').filter(entry => (entry as PerformanceResourceTiming).initiatorType === 'script').map(entry => ({ name: new URL(entry.name).pathname, bytes: (entry as PerformanceResourceTiming).decodedBodySize })),
    })), null, 2) });
  } finally { release(); }
});

test('editor, highlighted code, math and diagrams still load on demand', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const text = 'Loaded on demand.\n\n```javascript\nconst answer = 42;\n```\n\n$$x^2 + y^2 = z^2$$\n\n```mermaid\ngraph LR\n  A[Start] --> B[Ready]\n```';
  const spaces = createSpacesHomeMock({ homeBlocks: [{ id: 'diagram', rev: 1, type: 'mermaid', code: 'graph LR\n  A[Start] --> B[Ready]' }] });
  await installMockApi(page, { custom: spaces.handle, streamEvents: [
    { event: 'chunk', data: { text } },
    { event: 'done', data: { stopReason: 'end_turn' } },
  ] });
  await bootWithWorkspace(page, 'Optional renderers');
  await page.locator(COMPOSER_EDITOR).first().fill('Show rich content');
  await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect(page.locator('.michi-code-token').first()).toBeVisible();
  await expect(page.locator('.katex').first()).toBeVisible();
  await openArea(page, 'spaces');
  await expect(page.locator('.desk-mermaid svg')).toBeAttached();
  expect(errors).toEqual([]);
});

test('Map stays usable while its optional layout engine is stalled', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route(/elk[._-].*\.js(?:\?.*)?$/, async route => {
    requested = true;
    await pending;
    await route.continue();
  });
  await installMockApi(page, { workspaces: [workspace] });
  await page.addInitScript(() => localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, reduceMotion: true })));
  try {
    await page.goto('/');
    await page.locator('.terminal-sidebar [data-sidebar-row="loading-node"]').click();
    await page.keyboard.press('ControlOrMeta+m');
    await expect(page.locator('[data-map-node="loading-node"]').first()).toBeVisible();
    await expect.poll(() => requested).toBe(true);
    await openSettings(page, 'Appearance');
    await expect(page.getByRole('dialog', { name: 'Settings' }).getByText('Palette', { exact: true })).toBeVisible();
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('leaving a stalled Map module keeps navigation responsive and reuses the completed import', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  let released = false;
  await page.route(/\/(?:src\/components\/terminal\/pages\/Map\.tsx|assets\/Map-[^/]+\.js)(?:\?.*)?$/, async route => {
    requests++;
    await pending;
    await route.continue();
    released = true;
  });
  await installMockApi(page, { workspaces: [workspace] });
  await page.addInitScript(() => localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, reduceMotion: true })));
  try {
    await page.goto('/');
    await page.locator('.terminal-sidebar [data-sidebar-row="loading-node"]').click();
    await page.keyboard.press('ControlOrMeta+m');
    await expect.poll(() => requests).toBe(1);
    await openSettings(page, 'Appearance');
    await expect(page.getByRole('dialog', { name: 'Settings' }).getByText('Palette', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('michi:nav-page', { detail: { page: 'home' } })));
    await expect(page.locator('.home-page')).toBeVisible();
    release();
    await expect.poll(() => released).toBe(true);
    await expect(page.locator('.home-page')).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('michi:nav-page', { detail: { page: 'map' } })));
    await expect(page.locator('[data-map-node="loading-node"]').first()).toBeVisible();
    expect(requests).toBe(1);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});
