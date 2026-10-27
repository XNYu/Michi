import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { areaButton } from '../fixtures/shell';

/**
 * Sidebar polish contracts:
 *  - keyboard focus reveals the row menu instead of leaving it at opacity 0
 *  - workspace actions get a delayed, styled HoverTip instead of native title
 *  - scrollbars are quiet until the pointer enters and linger 2s after leaving
 *  - the collapsed wide sidebar leaves the 48px area rail
 */
async function bootSidebar(page: Page, { reduceMotion = false }: { reduceMotion?: boolean } = {}) {
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
    return false;
  } });
  await page.addInitScript((reduceMotion) => {
    const ids = Array.from({ length: 14 }, (_, i) => `root${i}`);
    const trees = ids.map((nodeId, i) => ({
      id: `tree${i}`,
      rootNodeId: nodeId,
      name: i === 0 ? 'root conversation' : `thread ${i}`,
      createdAt: 1,
      lastActiveAt: 1,
    }));
    const nodes = Object.fromEntries(ids.map(nodeId => [nodeId, {
      nodeId, kind: 'chat', chatId: null, projectId: 'polish-ws',
      title: `${nodeId} conversation`, status: 'idle', followUps: [],
      messages: [{ id: `${nodeId}-message`, role: 'user', text: `${nodeId} content`, toolCalls: [], createdAt: 1 }],
    }]));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:state', JSON.stringify({
      version: 6, activeProjectId: 'polish-ws', nodes,
      projects: [{
        id: 'polish-ws', name: 'Polish workspace', chatIds: ids,
        edges: [], trees,
        activeTreeId: 'tree0', artifacts: [], createdAt: 1,
      }],
    }));
    localStorage.setItem('michi:v1:prefs', JSON.stringify({
      sidebarView: 'structure', sidebarCollapsed: false, onboardingCompletedAt: 1, reduceMotion,
      sidebarExpanded: {
        workspaces: { 'polish-ws': true },
        threads: Object.fromEntries(trees.map(tree => [tree.id, true])),
        branches: {},
      },
    }));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({}));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({}));
  }, reduceMotion);
  await page.goto('/');
  await expect(page.locator('.terminal-sidebar')).toBeVisible();
}

test('sidebar polish: focus reveal, HoverTip, scrollbar linger', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await bootSidebar(page);

  const sidebar = page.locator('.terminal-sidebar');
  const tree = sidebar.locator('.term-scrollbar').first();

  // ── scrollbars start quiet, appear on entry, linger 2s after leaving ──
  await expect(sidebar).toHaveAttribute('data-scrollbars', 'quiet');
  await expect.poll(() => tree.evaluate(el => (
    getComputedStyle(el).getPropertyValue('--term-scrollbar-thumb').trim()
  ))).toBe('transparent');

  await sidebar.hover();
  await expect(sidebar).toHaveAttribute('data-scrollbars', 'visible');
  await expect.poll(() => tree.evaluate(el => (
    getComputedStyle(el).getPropertyValue('--term-scrollbar-thumb').trim()
  ))).not.toBe('transparent');

  await page.mouse.move(4, 4);
  await expect(sidebar).toHaveAttribute('data-scrollbars', 'visible');
  await expect(sidebar).toHaveAttribute('data-scrollbars', 'quiet', { timeout: 3500 });

  // Re-entering cancels the pending hide instead of letting it fire.
  await sidebar.hover();
  await expect(sidebar).toHaveAttribute('data-scrollbars', 'visible');
  await page.waitForTimeout(500);
  await expect(sidebar).toHaveAttribute('data-scrollbars', 'visible');

  // ── keyboard focus reveals the row menu ────────────────────────────────
  const kebab = sidebar.locator('.row-kebab button').first();
  await kebab.focus();
  await expect(kebab).toBeFocused();
  const kebabWrapper = sidebar.locator('.row-kebab').first();
  await expect.poll(() => kebabWrapper.evaluate(el => getComputedStyle(el).opacity)).toBe('1');
  await expect.poll(() => kebab.evaluate(el => getComputedStyle(el).pointerEvents)).toBe('auto');
  await page.screenshot({ path: info.outputPath('sidebar-focus.png'), fullPage: true });
  // Focus tooltips stay until focus leaves; blur before testing hover.
  await kebab.evaluate(el => (el as HTMLElement).blur());
  await expect(page.getByRole('tooltip')).toHaveCount(0);

  // ── workspace action uses the delayed styled tooltip ───────────────────
  const workspaceRow = sidebar.locator('.t-row-hover').filter({ hasText: 'Polish workspace' }).first();
  await workspaceRow.hover();
  const options = workspaceRow.getByRole('button', { name: 'Workspace options' });
  await options.hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeVisible({ timeout: 2000 });
  await expect(tooltip).toContainText('Workspace options');
  // Tooltip must be the styled surface, not a native title.
  await expect(tooltip).toHaveCSS('pointer-events', 'none');
  await page.screenshot({ path: info.outputPath('sidebar-tooltip.png'), fullPage: true });

  await page.mouse.move(4, 4);
  await expect(tooltip).toHaveCount(0);

  await page.screenshot({ path: info.outputPath('sidebar-polish.png'), fullPage: true });
  expect(errors).toEqual([]);
});



test('collapsed sidebar leaves the 48px area rail with every area', async ({ page }, info) => {
  await bootSidebar(page);
  const aside = page.locator('.terminal-sidebar');
  // Open a thread first so the pane caption's clearance past Zone 1 is
  // visible once the sidebar collapses.
  await aside.getByText('root conversation', { exact: true }).first().click();
  await expect(page.locator('.terminal-dashboard')).toBeVisible();
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  // Collapsed, only the sidebar's right border remains beside the rail.
  await expect.poll(() => aside.evaluate(el => el.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
  await expect(aside.locator('.terminal-sidebar-content')).toHaveAttribute('aria-hidden', 'true');

  const rail = page.getByRole('navigation', { name: 'Areas' });
  await expect(rail).toBeVisible();
  await expect(rail).toHaveCSS('width', '48px');
  await expect(areaButton(page, 'conversations')).toHaveAttribute('aria-current', 'page');
  for (const area of ['spaces', 'scheduled', 'settings'] as const) await expect(areaButton(page, area)).toBeVisible();
  await page.mouse.move(640, 420);
  // Let the rail's background transition settle before the still.
  await page.waitForTimeout(200);
  await page.screenshot({ path: info.outputPath('sidebar-rail-pane.png'), fullPage: true });

  await areaButton(page, 'scheduled').hover();
  await expect(page.getByRole('tooltip', { name: 'Scheduled' })).toBeVisible({ timeout: 2000 });
  await page.screenshot({ path: info.outputPath('sidebar-rail-tooltip.png'), fullPage: true });

  await areaButton(page, 'scheduled').click();
  await expect(areaButton(page, 'scheduled')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: 'Open sidebar' })).toBeVisible();
  await areaButton(page, 'conversations').click();
  await expect(page.locator('.terminal-dashboard')).toBeVisible();
});

test('reduce motion turns the app-pref transitions into near-zero', async ({ page }) => {
  await bootSidebar(page, { reduceMotion: true });
  const durations = await page.locator('.terminal-sidebar').evaluate(el => (
    getComputedStyle(el).transitionDuration.split(',').map(value => Number.parseFloat(value))
  ));
  expect(Math.max(...durations)).toBeLessThan(0.001);
});
