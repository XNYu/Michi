import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

async function bootNavigation(page: Page, sidebarView: 'activity' | 'structure') {
  await installMockApi(page, { custom: async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/agent-runs') {
      await route.fulfill({ json: { runs: [] } });
      return true;
    }
    if (path === '/api/agent-runs/subscribe') {
      await route.fulfill({ contentType: 'text/event-stream', body: ': keepalive\n\n' });
      return true;
    }
    if (/^\/api\/artifacts\/[^/]+\/read$/.test(path)) {
      await route.fulfill({ json: {
        content: '# Navigation notes', path: 'notes.md', basename: 'notes.md',
        extension: 'md', size: 18, modifiedAt: 1,
      } });
      return true;
    }
    return false;
  } });
  await page.addInitScript(view => {
    const ids = ['root', 'branch', 'other'];
    const nodes = Object.fromEntries(ids.map(nodeId => [nodeId, {
      nodeId, kind: 'chat', chatId: null, projectId: 'navigation-ws',
      title: `${nodeId} conversation`, status: 'idle', followUps: [],
      messages: [{ id: `${nodeId}-message`, role: 'user', text: `${nodeId} content`, toolCalls: [], createdAt: 1 }],
    }]));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:state', JSON.stringify({
      version: 6, activeProjectId: 'navigation-ws', nodes,
      projects: [{
        id: 'navigation-ws', name: 'Navigation workspace', chatIds: ids,
        edges: [{ source: 'root', target: 'branch', kind: 'branch' }],
        trees: [
          { id: 'tree', rootNodeId: 'root', name: 'root conversation', createdAt: 1, lastActiveAt: 1 },
          { id: 'other-tree', rootNodeId: 'other', name: 'other conversation', createdAt: 1, lastActiveAt: 1 },
        ],
        activeTreeId: 'tree', artifacts: [{
          id: 'notes', name: 'navigation-notes', filePath: 'notes.md',
          type: 'doc', source: 'user', createdAt: 1, updatedAt: 1,
        }], createdAt: 1,
      }],
    }));
    localStorage.setItem('michi:v1:prefs', JSON.stringify({
      sidebarView: view, sidebarCollapsed: false, onboardingCompletedAt: 1,
      sidebarExpanded: { workspaces: { 'navigation-ws': true }, threads: { tree: view === 'structure' }, branches: {} },
    }));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'navigation-ws::tree': ['root'] }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'navigation-ws::tree': null }));
  }, sidebarView);
  await page.goto('/');
}

for (const view of ['activity', 'structure'] as const) {
  test(`${view}: sidebar opens threads and branches from home and after management`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await bootNavigation(page, view);
    const sidebar = page.locator('.terminal-sidebar');
    const panes = page.locator('.terminal-dashboard > [data-node-id]');

    await sidebar.getByText('root conversation', { exact: true }).first().click();
    await expect(panes).toHaveCount(1);
    await expect(panes.first()).toHaveAttribute('data-node-id', 'root');
    await sidebar.getByText('branch conversation', { exact: true }).first().click();
    await expect(panes).toHaveCount(2);
    await expect(page.locator('[data-pane-caption-id="branch"]')).toBeVisible();
    await sidebar.getByText('other conversation', { exact: true }).first().click();
    await expect(panes).toHaveCount(1);
    await expect(panes.first()).toHaveAttribute('data-node-id', 'other');

    await sidebar.getByText('Workspaces', { exact: true }).click();
    await page.locator('.terminal-content-col').getByText('Navigation workspace', { exact: true }).first().click();
    await page.locator('.terminal-content-col').getByText('root conversation', { exact: true }).first().click();
    await expect(panes).toHaveCount(2);
    await sidebar.getByText('other conversation', { exact: true }).first().click();
    await expect(panes).toHaveCount(1);
    await expect(panes.first()).toHaveAttribute('data-node-id', 'other');
    await expect.poll(() => panes.first().evaluate(el => el.getAnimations().length)).toBe(0);
    await page.screenshot({ path: info.outputPath(`${view}-navigation.png`) });
    expect(errors).toEqual([]);
  });
}

test('Artifacts opens from home and dashboard, closes, and reopens', async ({ page }, info) => {
  await bootNavigation(page, 'activity');
  const trigger = page.getByRole('button', { name: /Artifacts/ });
  const drawer = page.getByRole('dialog', { name: 'Artifacts', exact: true });
  await trigger.click();
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await page.locator('.terminal-sidebar').getByText('root conversation', { exact: true }).first().click();
  await expect(page.locator('.terminal-dashboard')).toBeVisible();
  await trigger.click();
  await expect(drawer).toBeVisible();
  await drawer.getByText('navigation-notes', { exact: true }).click();
  await drawer.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('.terminal-dashboard > [data-node-id]')).toHaveCount(2);
  await expect(page.locator('.terminal-dashboard').getByRole('heading', { name: 'Navigation notes' })).toBeVisible();
  await trigger.click();
  await expect(drawer).toBeVisible();
  await expect.poll(() => drawer.evaluate(el => el.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0);
  await expect(drawer).toBeInViewport();
  await page.screenshot({ path: info.outputPath('artifacts-open.png') });
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
});
