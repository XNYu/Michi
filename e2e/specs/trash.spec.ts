import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

const day = 86_400_000;
const previewTitle = 'Compare DeepSeek models';

async function bootTrash(page: Page, palette = 'bone') {
  const now = Date.now();
  const node = (id: string, title: string, age?: number, extra: Record<string, unknown> = {}) => ({
    id, title, kind: 'chat', created_at: now - 40 * day, message_count: 4,
    ...(age === undefined ? {} : { deleted_at: now - age * day, deletion_group_id: `del-${id}` }),
    ...extra,
  });
  const workspace = (id: string, name: string, nodes: ReturnType<typeof node>[], age?: number) => ({
    workspace: { id, name, cwd: `/mock/${name}`, created_at: now - 40 * day,
      active_tree_id: nodes.length ? `${id}-tree` : null,
      ...(age === undefined ? {} : { deleted_at: now - age * day }),
    },
    nodes,
    trees: nodes.length ? [{ id: `${id}-tree`, root_node_id: nodes[0].id, created_at: now, last_active_at: now }] : [],
    edges: [], contexts: [], messages: [],
  });
  const workspaces = [
    workspace('michi-ws', 'michi', [
      node('live', 'Active conversation'),
      node('models', previewTitle, 0.001, { message_count: 2 }),
      node('child', 'Model benchmarks', 0.001, { parent_node_id: 'models', deletion_group_id: 'del-models', message_count: 6 }),
      node('notes', 'Michi implementation notes', 1),
      node('archive', 'Archived conversation', 3, { deletion_group_id: 'arch-hidden' }),
    ]),
    workspace('design-ws', 'designlab', [node('design-root', 'Design notes'), node('review', 'Review streaming architecture', 28)]),
    workspace('empty-ws', 'TestCloud2', [], 8),
    workspace('research-ws', 'Research', [node('research-live', 'Research plan'), node('research-trash', 'Research draft', 2)], 3),
  ];
  const calls = { previews: 0, purges: [] as string[][], empties: [] as string[], workspaces: [] as string[], failPurge: false };
  await installMockApi(page, { workspaces, custom: async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/prefs' && method === 'GET') {
      await route.fulfill({ json: { prefs: { onboardingCompletedAt: 1, terminalPalette: palette, uiFont: 'Geist', trashTTLDays: 30 } } });
      return true;
    }
    if (path === '/api/agent-runs') {
      await route.fulfill({ json: { runs: [] } });
      return true;
    }
    if (path === '/api/agent-runs/subscribe') {
      await route.fulfill({ contentType: 'text/event-stream', body: ': keepalive\n\n' });
      return true;
    }
    if (path.endsWith('/messages') && method === 'GET') {
      await route.fulfill({ json: { messages: [] } });
      return true;
    }
    const match = path.match(/^\/api\/workspaces\/([^/]+)$/);
    if (match && match[1] !== 'all' && method === 'GET') {
      calls.previews++;
      const meta = workspaces.find(item => item.workspace.id === match[1])!;
      await route.fulfill({ json: { ...meta,
        nodes: meta.nodes.map(({ message_count: _count, ...rest }) => rest),
        messages: [{ id: 'question', node_id: 'models', seq: 0, role: 'user', content: 'Compare the models for coding and reasoning.' },
          { id: 'answer', node_id: 'models', seq: 1, role: 'assistant', content: 'Start with a reproducible evaluation of tool use, latency, and code quality.' }],
      } });
      return true;
    }
    if (path.endsWith('/nodes') && method === 'DELETE') {
      calls.purges.push(route.request().postDataJSON().nodeIds);
      await route.fulfill({ status: calls.failPurge ? 503 : 200, json: calls.failPurge ? { error: 'Unavailable' } : { ok: true, purged: 1 } });
      return true;
    }
    if (path.endsWith('/trash/empty')) {
      calls.empties.push(path);
      await route.fulfill({ json: { ok: true, purged: 1 } });
      return true;
    }
    if (match && method === 'DELETE') calls.workspaces.push(match[1]);
    return false;
  } });
  await page.addInitScript(() => localStorage.setItem('michi:migrated', '1'));
  await page.goto('/');
  await expect(page.locator('.t-sidebar-toggle')).toBeVisible();
  const sidebar = page.locator('.terminal-sidebar');
  if (!await sidebar.isVisible()) await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  await sidebar.getByText('Settings', { exact: true }).click();
  const history = page.getByRole('group', { name: 'History', exact: true });
  await expect(history.getByRole('button', { name: 'Trash 5', exact: true })).toBeVisible();
  await history.getByRole('button', { name: 'Trash 5', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Trash', exact: true, level: 1 })).toBeVisible();
  await expect(page.locator('.drawer-shell-panel')).toHaveCount(0);
  await expect(page.locator('.trash-row')).toHaveCount(5);
  await page.mouse.move(0, 0);
  return calls;
}

test('grouped Trash searches, sorts, previews lazy messages, and restores without navigating', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 960 });
  const calls = await bootTrash(page);
  const trash = page.locator('.terminal-trash');
  await expect(trash.getByLabel('5 items')).toBeVisible();
  await expect(trash.locator('[data-trash-key="thread:del-models"] .trash-row-meta')).toContainText('8 messages');
  await expect(trash.getByText('Archived conversation')).toHaveCount(0);
  await expect(trash.locator('.trash-row-date').getByText('2d left')).toBeVisible();
  await page.screenshot({ path: info.outputPath('trash-desktop.png') });

  await trash.getByRole('button', { name: 'michi 2', exact: true }).click();
  const search = trash.getByRole('searchbox');
  await search.fill('DeepSeek');
  await expect(trash.locator('mark')).toHaveText('DeepSeek');
  await expect(trash.getByRole('status')).toHaveText('1 result');
  await search.fill('no matching title');
  await expect(trash.getByRole('heading', { name: 'No matching items' })).toBeVisible();
  await search.fill('');
  await expect(trash.getByRole('button', { name: 'michi 2' })).toHaveAttribute('aria-expanded', 'false');
  await trash.getByRole('button', { name: 'michi 2' }).click();
  await trash.getByRole('combobox').selectOption('oldest');
  await expect(trash.locator('.trash-row').first()).toHaveAttribute('data-trash-key', 'thread:del-review');
  await trash.getByRole('combobox').selectOption('newest');

  const trigger = trash.getByRole('button', { name: `Preview ${previewTitle}` });
  await trigger.click();
  const preview = page.getByRole('dialog', { name: 'Trash preview' });
  await expect(preview.getByText('Start with a reproducible evaluation of tool use, latency, and code quality.')).toBeVisible();
  expect(calls.previews).toBe(1);
  await expect(preview.getByText('Read only', { exact: true })).toBeVisible();
  await expect(preview.locator('[contenteditable]')).toHaveCount(0);
  await expect.poll(() => preview.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length)).toBe(0);
  expect(await preview.evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
  const bounds = (await preview.boundingBox())!;
  const footer = (await preview.locator('footer').boundingBox())!;
  expect(footer.y + footer.height).toBeLessThanOrEqual(bounds.y + bounds.height);
  await page.screenshot({ path: info.outputPath('trash-preview.png') });
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await trash.getByRole('button', { name: `Restore ${previewTitle}`, exact: true }).click();
  await expect(trash.locator('.trash-row')).toHaveCount(4);
  await expect(trash.getByRole('heading', { name: 'Trash', exact: true })).toBeVisible();
  await expect(page.getByText('Thread restored', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Trash confirms destructive actions, preserves failed rows, and empties all workspaces', async ({ page }, info) => {
  const calls = await bootTrash(page);
  const trash = page.locator('.terminal-trash');
  const menuTrigger = trash.getByRole('button', { name: 'More actions for Michi implementation notes' });
  await menuTrigger.click();
  await expect(page.getByRole('menuitem', { name: 'Preview', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: 'Delete permanently?' }).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(menuTrigger).toBeFocused();
  expect(calls.purges).toHaveLength(0);

  calls.failPurge = true;
  await menuTrigger.click();
  await page.getByRole('menuitem', { name: 'Delete permanently...' }).click();
  await page.getByRole('dialog', { name: 'Delete permanently?' }).getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(trash.getByRole('alert')).toContainText('Could not delete this item');
  await expect(trash.getByRole('button', { name: 'Preview Michi implementation notes' })).toBeVisible();
  await expect(menuTrigger).toBeFocused();
  expect(calls.purges).toEqual([['notes']]);

  calls.failPurge = false;
  await menuTrigger.click();
  await page.getByRole('menuitem', { name: 'Delete permanently...' }).click();
  await page.getByRole('dialog', { name: 'Delete permanently?' }).getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(trash.locator('.trash-row')).toHaveCount(4);
  await trash.getByRole('button', { name: 'Empty trash', exact: true }).click();
  await page.getByRole('dialog', { name: 'Empty trash?' }).getByRole('button', { name: 'Empty trash', exact: true }).click();
  await expect(trash.getByRole('heading', { name: 'Trash is empty' })).toBeVisible();
  expect(calls.empties).toHaveLength(3);
  expect(calls.workspaces).toEqual(['empty-ws', 'research-ws']);
  await page.screenshot({ path: info.outputPath('trash-empty.png') });
});

test('Trash respects dark theme and narrow windows with the sidebar open', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await bootTrash(page, 'monokai');
  await expect(page.locator('html')).toHaveAttribute('data-terminal-palette', 'monokai');
  await page.screenshot({ path: info.outputPath('trash-dark.png') });
  await page.setViewportSize({ width: 940, height: 820 });
  await expect(page.locator('.trash-row-date').first()).toBeHidden();
  await expect(page.locator('.trash-mobile-date').first()).toBeVisible();
  expect(await page.locator('.terminal-trash').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('trash-narrow.png') });
});

test.describe('Touch Trash', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('has usable targets and keeps long titles, menus, and previews within the viewport', async ({ page }, info) => {
    await bootTrash(page);
    const trash = page.locator('.terminal-trash');
    expect(await trash.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const restore = trash.getByRole('button', { name: `Restore ${previewTitle}`, exact: true });
    expect((await restore.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(restore).toBeInViewport();
    await expect(page.locator('.terminal-topbar-right')).toBeHidden();
    await page.screenshot({ path: info.outputPath('trash-mobile.png') });
    await trash.getByRole('button', { name: 'More actions for Research' }).click();
    await expect(page.getByRole('menu')).toBeInViewport();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Preview', exact: true }).click();
    const preview = page.getByRole('dialog', { name: 'Trash preview' });
    await expect(preview).toBeInViewport();
    await preview.getByRole('button', { name: 'Research draft', exact: true }).click();
    await expect(preview.getByRole('heading', { name: 'Research draft', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('trash-mobile-preview.png') });
    await preview.getByRole('button', { name: 'Restore thread', exact: true }).click();
    await expect(trash.locator('.trash-row')).toHaveCount(4);
    await expect(page.getByText('Thread restored', { exact: true })).toBeVisible();
  });
});
