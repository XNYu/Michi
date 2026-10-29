import { expect, test, type Browser, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { openThreadFromSidebar } from '../fixtures/shell';

const COMPOSER = '.terminal-dashboard .terminal-composer';

async function bootPhone(browser: Browser, baseURL: string | undefined, reduceMotion: boolean) {
  const context = await browser.newContext({ baseURL, viewport: { width: 440, height: 900 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await installMockApi(page, { streamEvents: [
    { event: 'chunk', data: { text: 'Hello from mock kiro.' } },
    { event: 'context_usage', data: { contextUsagePercentage: 30 } },
    { event: 'done', data: { stopReason: 'end_turn' } },
  ], custom: async (route) => {
    if (!new URL(route.request().url()).pathname.endsWith('/agent/status')) return false;
    await route.fulfill({ json: { runtime: 'kiro', label: 'Kiro', hasRequiredKey: true,
      capabilities: { modes: true, permissions: true, models: true, spawnBranches: true },
      availableRuntimes: [{ id: 'kiro', label: 'Kiro', available: true }] } });
    return true;
  } });
  await page.addInitScript((reduceMotion) => {
    localStorage.clear(); sessionStorage.clear();
    const nodes = { root: {
      nodeId: 'root', title: 'Root note', kind: 'chat', chatId: null, projectId: 'phone', status: 'idle', followUps: [], messagesLoaded: true,
      messages: [{ id: 'q', role: 'user', text: 'Root note', toolCalls: [], createdAt: 1 },
        { id: 'a', role: 'assistant', text: Array(12).fill('A quiet workspace keeps each conversation.').join('\n\n'), toolCalls: [], createdAt: 2 }],
    } };
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:state', JSON.stringify({ version: 6, activeProjectId: 'phone', nodes, projects: [{
      id: 'phone', name: 'Mobile workspace', createdAt: 1, chatIds: ['root'], activeTreeId: 'tree',
      trees: [{ id: 'tree', rootNodeId: 'root', name: 'Root note', createdAt: 1, lastActiveAt: 2 }], edges: [],
    }] }));
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: true, reduceMotion }));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'phone::tree': ['root'] }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'phone::tree': 'root' }));
  }, reduceMotion);
  await page.goto('/');
  await openThreadFromSidebar(page, 'Root note');
  await expect(page.locator(COMPOSER)).toHaveAttribute('data-collapsed', 'true');
  await expect(page.locator(`${COMPOSER} [contenteditable="true"]`)).toBeVisible();
  return { context, page };
}

/** Boxes relative to the composer's bottom-left corner, which stays put. */
const layout = (page: Page) => page.locator(COMPOSER).evaluate((root) => {
  const origin = root.getBoundingClientRect();
  const box = (selector: string) => {
    const r = root.querySelector(selector)!.getBoundingClientRect();
    return { left: r.left - origin.left, right: origin.right - r.right, bottom: origin.bottom - r.bottom, top: r.top - origin.top, width: r.width, height: r.height };
  };
  return { attach: box('.composer-attach'), send: box('.t-action-btn:last-of-type'), field: box('[contenteditable="true"]') };
});

const field = (page: Page) => page.locator(`${COMPOSER} [contenteditable="true"]`);
const fieldFocused = (page: Page) => page.locator(COMPOSER).evaluate((root) => root.contains(document.activeElement));

test('opening keeps + and send where they were and rests again after a send', async ({ browser, baseURL }, info) => {
  const { context, page } = await bootPhone(browser, baseURL, true);
  try {
    const rest = await layout(page);
    await page.screenshot({ path: info.outputPath('rest.png') });
    await field(page).tap();
    await expect(page.locator(COMPOSER)).not.toHaveAttribute('data-collapsed', 'true');
    const open = await layout(page);
    await page.screenshot({ path: info.outputPath('open.png') });
    // Same size, and the same distance from the frame's left and bottom edges.
    expect(open.attach.left).toBeCloseTo(rest.attach.left, 0);
    expect(open.attach.bottom).toBeCloseTo(rest.attach.bottom, 0);
    expect(open.attach.width).toBe(rest.attach.width);
    expect(open.attach.height).toBe(rest.attach.height);
    // Send (hidden at rest with nothing to send) sits level with + at the right edge.
    expect(open.send.bottom).toBeCloseTo(open.attach.bottom, 0);
    expect(open.send.right).toBeCloseTo(open.attach.left, 0);
    expect(open.send.height).toBe(open.attach.height);
    // The first line starts at the same depth below the top edge.
    expect(open.field.top).toBeCloseTo(rest.field.top, 0);

    await page.keyboard.type('Keep this short');
    await page.getByRole('button', { name: 'Send (Enter)', exact: true }).tap();
    await expect(page.locator(COMPOSER)).toHaveAttribute('data-collapsed', 'true');
    expect(await fieldFocused(page)).toBe(false);
    // The reply finishing does not reopen it.
    await expect(page.getByText('Hello from mock kiro.').first()).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.locator(COMPOSER)).toHaveAttribute('data-collapsed', 'true');
    expect(await fieldFocused(page)).toBe(false);
    const after = await layout(page);
    expect(after.attach).toEqual(rest.attach);

    // Context usage waits for the open toolbar, beside send, instead of
    // sitting after + at rest.
    const ring = page.locator(`${COMPOSER} .composer-context-ring`);
    await expect(ring).toBeAttached();
    await expect(ring).toBeHidden();
    await field(page).tap();
    await expect(ring).toBeVisible();
    const ringBox = (await ring.boundingBox())!;
    const sendBox = (await page.getByRole('button', { name: 'Send (Enter)', exact: true }).boundingBox())!;
    expect(sendBox.x - (ringBox.x + ringBox.width)).toBeLessThanOrEqual(6);
    expect(Math.abs((ringBox.y + ringBox.height / 2) - (sendBox.y + sendBox.height / 2))).toBeLessThan(1);
  } finally { await context.close(); }
});

test('opening and closing animate the frame unless motion is reduced', async ({ browser, baseURL }, info) => {
  const { context, page } = await bootPhone(browser, baseURL, false);
  try {
    const composer = page.locator(COMPOSER);
    // Slow it down enough to observe.
    await page.evaluate(() => document.documentElement.style.setProperty('--t-enter', '1500ms'));
    await field(page).tap();
    await expect(composer).toHaveAttribute('data-morphing', '');
    await expect(composer.locator('.terminal-composer__morph')).toBeVisible();
    await page.screenshot({ path: info.outputPath('opening.png') });
    await expect(composer).not.toHaveAttribute('data-morphing', '', { timeout: 4000 });
    await expect(composer.locator('.terminal-composer__morph')).toBeHidden();

    await page.locator('.terminal-dashboard').getByText('A quiet workspace keeps each conversation.').first().tap();
    await expect(composer).toHaveAttribute('data-collapsed', 'true');
    await expect(composer).toHaveAttribute('data-morphing', '');
    // The chips that leave fade out as inert copies.
    await expect(composer.locator('.terminal-composer__ghost').first()).toBeAttached();
    await page.screenshot({ path: info.outputPath('closing.png') });
    await expect(composer).not.toHaveAttribute('data-morphing', '', { timeout: 4000 });
    await expect(composer.locator('.terminal-composer__ghost')).toHaveCount(0);

    await page.evaluate(() => { document.documentElement.dataset.reduceMotion = 'on'; });
    await field(page).tap();
    await expect(composer).not.toHaveAttribute('data-collapsed', 'true');
    expect(await composer.getAttribute('data-morphing')).toBeNull();
  } finally { await context.close(); }
});
