import { expect, test, type Browser, type CDPSession, type Locator, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { openThreadFromSidebar } from '../fixtures/shell';

// On a phone the page is an application shell: it never scrolls or bounces as
// a whole. Only the transcript, the sidebar's list and Settings' content
// scroll, so the composer, the top bar and the drawer's tabs and bottom rows
// stay where they are. iOS's rubber-band is not emulated by Chromium; the
// root's overscroll-behavior is what stops it there.

async function phone(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  return context.newPage();
}

async function boot(page: Page) {
  await installMockApi(page);
  await page.addInitScript(() => {
    localStorage.clear(); sessionStorage.clear();
    const answer = Array(30).fill('A quiet workspace keeps each conversation and its reading position.').join('\n\n');
    const ids = Array.from({ length: 24 }, (_, i) => (i === 0 ? 'root' : `thread-${i}`));
    const nodes = Object.fromEntries(ids.map((id, i) => [id, {
      nodeId: id, title: i === 0 ? 'Root note' : `Thread ${i}`, kind: 'chat', chatId: null, projectId: 'phone', status: 'idle', followUps: [], messagesLoaded: true,
      messages: i === 0 ? [{ id: 'q', role: 'user', text: 'Root note', toolCalls: [], createdAt: 1 }, { id: 'a', role: 'assistant', text: answer, toolCalls: [], createdAt: 2 }] : [],
    }]));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:state', JSON.stringify({ version: 6, activeProjectId: 'phone', nodes, projects: [{
      id: 'phone', name: 'Mobile workspace', createdAt: 1, chatIds: ids, activeTreeId: 'tree-0',
      trees: ids.map((id, i) => ({ id: `tree-${i}`, rootNodeId: id, name: i === 0 ? 'Root note' : `Thread ${i}`, createdAt: 1, lastActiveAt: 100 - i })),
      edges: [],
    }] }));
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarView: 'structure', sidebarCollapsed: true, sidebarThreadLimit: 30,
      sidebarExpanded: { workspaces: { phone: true }, threads: {}, branches: {} }, reduceMotion: true }));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'phone::tree-0': ['root'] }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'phone::tree-0': 'root' }));
  });
  await page.goto('/');
}

/**
 * A finger drag of `dy` px starting on `target` (negative = finger moves up,
 * which scrolls content down), as raw touch events.
 */
async function drag(cdp: CDPSession, target: Locator, dy: number) {
  const box = (await target.boundingBox())!;
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  const steps = 15;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.round(y + (dy * i) / steps) }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function top(locator: Locator) {
  return (await locator.boundingBox())!.y;
}

async function bottom(locator: Locator) {
  const box = (await locator.boundingBox())!;
  return box.y + box.height;
}

async function pageScroll(page: Page) {
  return page.evaluate(() => {
    const root = document.scrollingElement!;
    window.scrollTo(0, 500);
    const moved = window.scrollY;
    window.scrollTo(0, 0);
    return { range: root.scrollHeight - root.clientHeight, moved };
  });
}

test('the page never scrolls or bounces; dragging the composer moves nothing and the transcript scrolls beneath it', async ({ browser, baseURL }) => {
  const page = await phone(browser, baseURL);
  await boot(page);
  await openThreadFromSidebar(page, 'Root note');
  const pane = page.locator('.terminal-pane[data-node-id="root"]');
  const composer = pane.locator('.terminal-composer');
  const transcript = pane.locator('.term-scrollbar').first();
  await expect(composer).toBeVisible();
  await expect.poll(() => transcript.evaluate(el => el.scrollHeight > el.clientHeight + 200)).toBe(true);

  expect(await page.evaluate(() => [document.documentElement, document.body].map(el => getComputedStyle(el).overscrollBehaviorY))).toEqual(['none', 'none']);
  expect(await pageScroll(page)).toEqual({ range: 0, moved: 0 });

  const cdp = await page.context().newCDPSession(page);
  // The composer grows upward when engaged, so its bottom edge is the anchor.
  const composerBottom = await bottom(composer);
  const topbarTop = await top(page.locator('.terminal-topbar'));
  const before = await transcript.evaluate(el => el.scrollTop);

  await drag(cdp, composer, -300);
  await drag(cdp, composer, 300);
  expect(await bottom(composer)).toBe(composerBottom);
  // A tap can expand or collapse the composer, which moves the pinned
  // transcript by that height change; a 300px drag would move it by 300.
  expect(Math.abs(await transcript.evaluate(el => el.scrollTop) - before)).toBeLessThan(40);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // The transcript opens at its end; dragging down scrolls it back up.
  await drag(cdp, transcript, 300);
  await expect.poll(() => transcript.evaluate(el => el.scrollTop)).toBeLessThan(before - 100);
  expect(await bottom(composer)).toBe(composerBottom);
  expect(await top(page.locator('.terminal-topbar'))).toBe(topbarTop);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('the sidebar is not one scrolling page: its list scrolls between the fixed area tabs and bottom rows', async ({ browser, baseURL }) => {
  const page = await phone(browser, baseURL);
  await boot(page);
  await page.locator('.home-page').waitFor();
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  const sidebar = page.locator('.terminal-sidebar');
  const tabs = sidebar.getByRole('navigation', { name: 'Areas' });
  const home = sidebar.getByText('Home', { exact: true });
  const list = sidebar.locator('.term-scrollbar').first();
  await expect(sidebar.getByText('Thread 23', { exact: true })).toBeAttached();
  await expect.poll(() => list.evaluate(el => el.scrollHeight > el.clientHeight + 200)).toBe(true);

  const cdp = await page.context().newCDPSession(page);
  const tabsTop = await top(tabs);
  const homeTop = await top(home);

  await drag(cdp, tabs, 300);
  await drag(cdp, home, -300);
  expect([await top(tabs), await top(home)]).toEqual([tabsTop, homeTop]);

  await drag(cdp, list, -300);
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  expect([await top(tabs), await top(home)]).toEqual([tabsTop, homeTop]);
  expect(await pageScroll(page)).toEqual({ range: 0, moved: 0 });
});
