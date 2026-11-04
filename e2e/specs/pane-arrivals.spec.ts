import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { openThreadFromSidebar } from '../fixtures/shell';

const PANE = (id: string) => `.terminal-dashboard > [data-node-id="${id}"]`;
const NEW_PANE = '.terminal-dashboard > [data-node-id]:not([data-node-id="root"]):not([data-node-id="side"])';

async function boot(page: Page, { open = ['root', 'side'], reduceMotion = false } = {}) {
  await installMockApi(page);
  await page.addInitScript(({ open, reduceMotion }) => {
    localStorage.clear(); sessionStorage.clear();
    const ids = ['root', 'side'];
    const titles = ['Migration plan', 'Rollback'];
    const nodes = Object.fromEntries(ids.map((id, i) => [id, {
      nodeId: id, title: titles[i], kind: 'chat', chatId: null, projectId: 'desk', status: 'idle', followUps: [], messagesLoaded: true,
      messages: [{ id: id + '-q', role: 'user', text: titles[i], toolCalls: [], createdAt: 1 },
        { id: id + '-a', role: 'assistant', text: 'A quiet workspace keeps each conversation and its reading position.', toolCalls: [], createdAt: 2 }],
    }]));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:state', JSON.stringify({ version: 6, activeProjectId: 'desk', nodes, projects: [{
      id: 'desk', name: 'Desk', createdAt: 1, chatIds: ids, activeTreeId: 'tree',
      trees: [{ id: 'tree', rootNodeId: 'root', name: titles[0], createdAt: 1, lastActiveAt: 2 }],
      edges: [{ source: 'root', target: 'side' }],
    }] }));
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarView: 'structure', sidebarCollapsed: true,
      sidebarExpanded: { workspaces: { desk: true }, threads: {}, branches: {} }, paneWidthMode: 'half', reduceMotion }));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'desk::tree': open }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'desk::tree': 'root' }));
  }, { open, reduceMotion });
  await page.goto('/');
  await openThreadFromSidebar(page, 'Migration plan');
  await expect(page.locator(PANE('root'))).toBeVisible();
}

async function branchInBackground(page: Page) {
  const composer = page.locator(PANE('root')).getByRole('textbox', { name: 'Message' });
  await composer.click();
  await composer.fill('A tangent');
  await page.locator(PANE('root')).getByRole('button', { name: /^Branch/ }).click();
  await expect(page.locator(NEW_PANE)).toHaveCount(1);
}

const onScreenShare = (page: Page) => page.evaluate((selector) => {
  const strip = document.querySelector('.terminal-dashboard')!.getBoundingClientRect();
  const pane = document.querySelector(selector)!.getBoundingClientRect();
  return Math.max(0, Math.min(pane.right, strip.right) - Math.max(pane.left, strip.left)) / pane.width;
}, NEW_PANE);

test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1480, height: 1000 }); });

test('a branch that opens off screen leaves a tab on the right edge that takes you there', async ({ page }, info) => {
  await boot(page);
  await branchInBackground(page);
  expect(await onScreenShare(page)).toBe(0);
  const tab = page.getByRole('group', { name: 'New branches' }).getByRole('button');
  await expect(tab).toHaveCount(1);
  await expect(page.getByRole('group', { name: 'New branches' })).toContainText('New branch');
  await expect.poll(async () => {
    const box = (await tab.boundingBox())!;
    const strip = (await page.locator('.terminal-dashboard').boundingBox())!;
    return Math.round(box.x + box.width - (strip.x + strip.width));
  }).toBe(0);
  await page.screenshot({ path: info.outputPath('pane-arrival-tab.png') });
  // The reading pane is left where it was.
  await expect(page.locator(PANE('root'))).toBeInViewport();

  await tab.click();
  await expect.poll(() => onScreenShare(page)).toBeGreaterThan(0.99);
  await expect(tab).toHaveCount(0);
});

test('scrolling the branch into view dismisses its tab', async ({ page }) => {
  await boot(page);
  await branchInBackground(page);
  const tab = page.getByRole('group', { name: 'New branches' }).getByRole('button');
  await expect(tab).toHaveCount(1);
  await page.locator('.terminal-dashboard').evaluate(strip => { strip.scrollLeft = strip.scrollWidth; });
  await expect(tab).toHaveCount(0);
  await expect(page.locator(PANE('root'))).not.toBeInViewport({ ratio: 0.6 });
});

test('a branch that opens in view gets no tab', async ({ page }) => {
  await boot(page, { open: ['root'] });
  await branchInBackground(page);
  await expect.poll(() => onScreenShare(page)).toBeGreaterThan(0.99);
  await expect(page.getByRole('group', { name: 'New branches' }).getByRole('button')).toHaveCount(0);
});

test('reduced motion still shows the tab', async ({ page }) => {
  await boot(page, { reduceMotion: true });
  await branchInBackground(page);
  await expect(page.getByRole('group', { name: 'New branches' }).getByRole('button')).toHaveCount(1);
});
