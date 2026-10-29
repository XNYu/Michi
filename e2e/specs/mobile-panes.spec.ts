import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { openThreadFromSidebar } from '../fixtures/shell';
import { openSettings } from '../fixtures/shell';

async function boot(page: Page, enterThread = true, fullRuntime = false) {
  await installMockApi(page, { custom: async route => {
    if (!fullRuntime || !new URL(route.request().url()).pathname.endsWith('/agent/status')) return false;
    await route.fulfill({ json: { runtime: 'kiro', label: 'Kiro', hasRequiredKey: true,
      capabilities: { modes: true, permissions: true, models: true, spawnBranches: true },
      availableRuntimes: [{ id: 'kiro', label: 'Kiro', available: true }] } });
    return true;
  } });
  await page.addInitScript((fullRuntime) => {
    localStorage.clear(); sessionStorage.clear();
    const ids = ['root', 'branch', 'nested', 'other'];
    const titles = ['Root note', 'Alternative plan', 'Implementation details', 'Separate tree'];
    const nodes = Object.fromEntries(ids.map((id, i) => [id, {
      nodeId: id, title: titles[i], kind: 'chat', chatId: null, projectId: 'phone', status: 'idle', followUps: [], messagesLoaded: true,
      ...(fullRuntime ? { currentModeId: 'michi', contextUsagePercentage: 5 } : {}),
      paneWidth: i === 0 ? 240 : 900,
      messages: [{ id: id + '-q', role: 'user', text: titles[i], toolCalls: [], createdAt: 1 },
        { id: id + '-a', role: 'assistant', text: Array(30).fill('A quiet workspace keeps each conversation and its reading position.').join('\n\n'), toolCalls: [], createdAt: 2 }],
    }]));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:state', JSON.stringify({ version: 6, activeProjectId: 'phone', nodes, projects: [{
      id: 'phone', name: 'Mobile workspace', createdAt: 1, chatIds: ids, activeTreeId: 'tree',
      trees: [{ id: 'tree', rootNodeId: 'root', name: titles[0], createdAt: 1, lastActiveAt: 2 }, { id: 'other-tree', rootNodeId: 'other', name: titles[3], createdAt: 1, lastActiveAt: 1 }],
      edges: [{ source: 'root', target: 'branch' }, { source: 'branch', target: 'nested' }, { source: 'root', target: 'other', kind: 'link' }],
    }] }));
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarView: 'structure', sidebarCollapsed: true,
      sidebarExpanded: { workspaces: { phone: true }, threads: {}, branches: {} }, paneWidthMode: 'half', reduceMotion: true }));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'phone::tree': ['root', 'branch'] }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'phone::tree': 'root' }));
  }, fullRuntime);
  await page.goto('/');
  if (enterThread) {
    await openThreadFromSidebar(page, 'Root note');
    await expect(page.locator('.terminal-dashboard')).toBeVisible();
  } else await expect(page.locator('.home-page')).toBeVisible();
}

async function assertOnePane(page: Page, id: string) {
  const pane = page.locator(`.terminal-dashboard > [data-node-id="${id}"]`);
  await expect(pane).toBeVisible();
  await expect(page.locator('.terminal-dashboard > [data-node-id]:visible')).toHaveCount(1);
  await expect.poll(async () => {
    const body = (await page.locator('.terminal-dashboard').boundingBox())!;
    const box = (await pane.boundingBox())!;
    return Math.max(Math.abs(box.x - body.x), Math.abs(box.width - body.width));
  }).toBeLessThan(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe((await page.viewportSize())!.width);
}

test('phone uses the top-right indented title list and keeps pane drafts and scroll through switching and resize', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await assertOnePane(page, 'root');
  const root = page.locator('.terminal-dashboard > [data-node-id="root"]');
  await root.getByRole('textbox', { name: 'Message' }).fill('Keep my root draft');
  const scroller = root.locator('.term-scrollbar').first();
  await scroller.evaluate(el => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })); el.scrollTop = 100; });
  const trigger = page.getByRole('button', { name: 'Switch pane' });
  const triggerBox = (await trigger.boundingBox())!;
  expect(triggerBox.width).toBeGreaterThanOrEqual(44);
  expect(triggerBox.x + triggerBox.width).toBeGreaterThan(365);
  await trigger.click();
  const list = page.getByRole('navigation', { name: 'Branches and panes' });
  await expect(list.getByRole('button')).toHaveText(['Root note', 'Alternative plan', 'Implementation details']);
  expect(await list.getByRole('button', { name: 'Implementation details' }).evaluate(el => parseFloat(getComputedStyle(el).paddingLeft))).toBe(44);
  await page.screenshot({ path: info.outputPath('phone-pane-switcher.png'), animations: 'disabled' });
  await list.getByRole('button', { name: 'Alternative plan' }).click();
  await assertOnePane(page, 'branch');
  await page.locator('.terminal-dashboard > [data-node-id="branch"]').getByRole('textbox', { name: 'Message' }).fill('Branch draft');
  await trigger.click(); await list.getByRole('button', { name: 'Root note' }).click();
  await assertOnePane(page, 'root');
  await expect(root.getByRole('textbox', { name: 'Message' })).toHaveText('Keep my root draft');
  expect(await scroller.evaluate(el => el.scrollTop)).toBeCloseTo(100, 0);
  await trigger.click(); await list.getByRole('button', { name: 'Implementation details' }).click();
  await assertOnePane(page, 'nested');
  await expect(page.locator('.terminal-dashboard > [data-node-id]')).toHaveCount(3);
  await page.setViewportSize({ width: 320, height: 568 });
  await assertOnePane(page, 'nested');
  const composer = page.locator('.terminal-dashboard > [data-node-id="nested"] .terminal-composer');
  const composerBounds = (await composer.boundingBox())!;
  for (const control of await composer.locator('.t-action-btn, .t-toolbar-chip').all()) {
    if (!await control.isVisible()) continue;
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(composerBounds.x);
    expect(box.x + box.width).toBeLessThanOrEqual(composerBounds.x + composerBounds.width);
  }
  await page.screenshot({ path: info.outputPath('phone-320.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(trigger).toHaveCount(0);
  await expect.poll(async () => {
    const width = (await root.boundingBox())!.width;
    return Math.abs(width * 2 - (await page.locator('.terminal-dashboard').boundingBox())!.width);
  }).toBeLessThan(2);
  await expect(root.getByRole('textbox', { name: 'Message' })).toHaveText('Keep my root draft');
  await page.setViewportSize({ width: 390, height: 844 });
  await assertOnePane(page, 'nested');
  expect(errors).toEqual([]);
});

test('phone list supports Escape, outside dismissal, and active-tree isolation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await boot(page);
  const trigger = page.getByRole('button', { name: 'Switch pane' });
  await trigger.click(); await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused(); await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click(); await page.locator('.mobile-pane-title').click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await openThreadFromSidebar(page, 'Separate tree');
  await assertOnePane(page, 'other');
  await expect(trigger).toHaveCount(0);
});

for (const width of [320, 390, 430]) test(`${width}px touch screens keep the full runtime toolbar inside the current pane`, async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await boot(page, true, true); await assertOnePane(page, 'root');
    const composer = page.locator('.terminal-dashboard > [data-node-id="root"] .terminal-composer');
    await composer.getByRole('textbox', { name: 'Message' }).fill('A phone question');
    const box = (await composer.boundingBox())!;
    await expect(composer.getByRole('button', { name: 'Send (Enter)', exact: true })).toBeVisible();
    for (const action of await composer.locator('.t-toolbar-chip:visible, button:visible').all()) {
      const control = (await action.boundingBox())!;
      expect(control.x).toBeGreaterThanOrEqual(box.x);
      expect(control.x + control.width).toBeLessThanOrEqual(box.x + box.width);
    }
  } finally { await context.close(); }
});

test('phone transcript uses narrow sides and wider user cards, and desktop keeps its own', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await boot(page);
  const pane = page.locator('.terminal-dashboard > [data-node-id="root"]');
  const transcript = pane.locator('.terminal-pane__transcript');
  const card = pane.locator('.terminal-message-user');
  await expect(transcript).toHaveCSS('padding-left', '14px');
  await expect(transcript).toHaveCSS('padding-right', '14px');
  await expect(card).toHaveCSS('max-width', '80%');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(transcript).toHaveCSS('padding-left', '24px');
  await expect(card).toHaveCSS('max-width', '72%');
});
