import { expect, test, type Browser, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { openArea } from '../fixtures/shell';

// Phone layouts on a touch screen: Scheduled rows, Settings, Explore further
// and the tap targets under messages and in the sidebar.

const questions = [
  'Where in the Michi source is the completion marker in the set_branch_overview result generated?',
  'What could go wrong with frontend parsing if the model outputs that marker?',
  'Do instructions embedded in tool results pose a prompt injection risk?',
];

async function phone(browser: Browser, baseURL: string | undefined, width = 390) {
  const context = await browser.newContext({ baseURL, viewport: { width, height: 844 }, hasTouch: true, isMobile: true });
  return context.newPage();
}

async function boot(page: Page) {
  const prefs = { terminalPalette: 'bone', onboardingCompletedAt: 1, enableFollowUps: true, sidebarCollapsed: true, reduceMotion: true };
  const createdAt = Date.now() - 5 * 60_000;
  const ids = ['root', 'child'];
  const workspace = {
    workspace: { id: 'ws-1', name: 'Branch design', active_tree_id: 'tree', created_at: createdAt },
    trees: [{ id: 'tree', workspace_id: 'ws-1', root_node_id: 'root', name: 'Tool results', created_at: createdAt, last_active_at: createdAt }],
    nodes: ids.map((id, index) => ({
      id, kind: 'chat', acp_session_id: id, runtime_id: 'mock', workspace_id: 'ws-1', tree_id: 'tree',
      title: index === 0 ? 'Tool results and completion markers' : 'Frontend parsing of completion markers',
      status: 'idle', created_at: createdAt + index,
      follow_ups: JSON.stringify(index === 0 ? questions : []),
      follow_ups_source_message_id: index === 0 ? 'root-answer' : undefined,
    })),
    edges: [{ source_node_id: 'root', target_node_id: 'child', kind: 'branch', anchor_message_id: 'root-answer', created_at: createdAt + 3 }],
    messages: ids.flatMap(id => [
      { id: `${id}-question`, node_id: id, role: 'user', seq: 0, content: 'Review the tool result handling.', created_at: createdAt },
      { id: `${id}-answer`, node_id: id, role: 'assistant', seq: 1, content: 'Keep tool output separate from runtime control messages.', created_at: createdAt + 1 },
    ]),
    contexts: [],
  };
  await installMockApi(page, { workspaces: [workspace], custom: async route => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api/, '');
    if (path === '/prefs' && route.request().method() === 'GET') { await route.fulfill({ json: { prefs } }); return true; }
    if (path === '/meta-agent/overview') {
      await route.fulfill({ json: {
        state: 'running', runtime: { runtimeId: 'claude', providerId: null, modelId: null, reasoning: null, followsGlobal: true },
        today: { checks: 0, checksTruncated: false, modelCalls: 0, writes: 0, pendingProposals: 0 },
        cursors: [], recentRuns: [], managedJobIds: [],
      } });
      return true;
    }
    if (path === '/scheduled-jobs') {
      await route.fulfill({ json: {
        jobs: [{
          id: 'job-1', workspaceId: 'ws-1', name: 'Morning digest of overnight changes', prompt: 'Summarize overnight changes',
          schedule: { kind: 'every', everySeconds: 3600 }, enabled: true, autoPaused: false,
          runtimeId: null, providerId: null, modelId: null, reasoning: null, permissionMode: 'trust',
          sessionMode: 'fresh', notify: true, timeoutSeconds: 1800, consecutiveFailures: 0,
          activeRunId: null, lastRunAt: null, nextRunAt: null, lastStatus: null, lastError: null,
          persistentNodeId: null, createdAt: 1, updatedAt: 1,
        }],
        scheduler: { active: true, serviceMode: false, timezone: 'UTC' },
      } });
      return true;
    }
    if (/^\/scheduled-jobs\/[^/]+\/runs$/.test(path)) { await route.fulfill({ json: { runs: [] } }); return true; }
    return false;
  } });
  await page.addInitScript(prefs => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:prefs', JSON.stringify(prefs));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'ws-1::tree': ['root'] }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'ws-1::tree': 'root' }));
  }, prefs);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
}

async function openThread(page: Page) {
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  await page.locator('.terminal-sidebar').getByText('Tool results', { exact: true }).first().click();
  const pane = page.locator('.terminal-pane[data-node-id="root"]');
  await expect(pane.locator('.t-followup-row')).toHaveCount(3);
  return pane;
}

async function size(page: Page, selector: string) {
  const box = await page.locator(selector).filter({ visible: true }).first().boundingBox();
  expect(box, selector).not.toBeNull();
  return box!;
}

test('message actions, follow-up toggle and sidebar row buttons are finger-sized', async ({ browser, baseURL }) => {
  const page = await phone(browser, baseURL);
  await boot(page);
  const pane = await openThread(page);
  for (const name of ['copy message', 'retry this turn', 'branch from here']) {
    const box = await pane.getByRole('button', { name, exact: true }).first().boundingBox();
    expect(box!.width, name).toBeGreaterThanOrEqual(40);
    expect(box!.height, name).toBeGreaterThanOrEqual(40);
  }
  const toggle = await size(page, '.t-followups-toggle');
  expect(Math.min(toggle.width, toggle.height)).toBeGreaterThanOrEqual(40);

  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  const sidebar = page.locator('.terminal-sidebar');
  const kebab = await sidebar.getByRole('button', { name: 'Actions for Tool results', exact: true }).boundingBox();
  expect(kebab!.width).toBeGreaterThanOrEqual(32);
  expect(kebab!.height).toBeGreaterThanOrEqual(30);
  for (const name of ['Workspace options', 'New chat in this workspace']) {
    const box = await sidebar.getByRole('button', { name, exact: true }).boundingBox();
    expect(Math.min(box!.width, box!.height), name).toBeGreaterThanOrEqual(32);
  }
  // The trailing caret moved left by the kebab's extra width, so they do not touch.
  const caret = await sidebar.locator('.t-row-hover', { hasText: 'Tool results' }).first()
    .locator('span[aria-hidden]', { hasText: /^[⌄›]$/ }).first().boundingBox();
  if (caret) expect(caret.x + caret.width).toBeLessThanOrEqual(kebab!.x);
});

for (const width of [390, 320]) test(`Explore further keeps Branch on one line at ${width}px`, async ({ browser, baseURL }) => {
  const page = await phone(browser, baseURL, width);
  await boot(page);
  const pane = await openThread(page);
  for (const row of await pane.locator('.t-followup-row').all()) {
    const branch = row.locator('.t-followup-branch');
    const glyph = await branch.locator('.t-followup-branch-glyph').boundingBox();
    const label = branch.locator('.t-followup-branch-label');
    expect(await branch.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    if (await label.isVisible()) {
      const text = await label.boundingBox();
      expect(Math.abs((glyph!.y + glyph!.height / 2) - (text!.y + text!.height / 2))).toBeLessThan(3);
      expect(text!.x).toBeGreaterThan(glyph!.x + glyph!.width);
    }
    await expect(branch).toHaveAccessibleName(/Branch/);
  }
});

test('Scheduled rows keep the title clear of the run, switch and menu buttons', async ({ browser, baseURL }) => {
  const page = await phone(browser, baseURL);
  await boot(page);
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  await openArea(page, 'scheduled');
  await page.getByRole('heading', { level: 1, name: 'Scheduled', exact: true }).waitFor();
  await page.touchscreen.tap(375, 600);
  for (const row of await page.locator('.terminal-scheduled .sched-row').all()) {
    const title = await row.locator('.trash-row-title').boundingBox();
    const actions = await row.locator('.trash-row-actions').boundingBox();
    expect(title!.width).toBeGreaterThan(150);
    expect(title!.x + title!.width).toBeLessThanOrEqual(actions!.x + 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('Settings on a phone opens on its section list, then a full-width section; Back steps up a level', async ({ browser, baseURL }) => {
  const page = await phone(browser, baseURL);
  await boot(page);
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  await openArea(page, 'settings');
  const drawer = page.getByRole('dialog', { name: 'Settings', exact: true });
  const nav = drawer.getByRole('navigation', { name: 'Settings sections' });
  const back = drawer.locator('.ui-overlay-header').getByRole('button', { name: 'Back', exact: true });
  const content = drawer.locator('.terminal-settings-content');

  // First level: only the list, grouped cards with one row per page, each
  // nearly as wide as the screen.
  await expect(nav).toBeVisible();
  await expect(content).toBeHidden();
  const rows = await nav.locator('.settings-phone__row').all();
  expect(rows.length).toBeGreaterThanOrEqual(11);
  for (const row of rows) {
    const box = (await row.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(48);
    expect(box.width).toBeGreaterThanOrEqual(340);
    await expect(row.locator('.settings-phone__chevron')).toBeVisible();
  }
  expect(await drawer.locator('.terminal-settings-sidebar').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('settings-phone-list.png'), animations: 'disabled' });

  // Second level: the section alone at full width.
  await nav.getByRole('button', { name: 'Appearance', exact: true }).click();
  const heading = drawer.getByRole('heading', { level: 1, name: 'Appearance', exact: true });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  await expect(nav).toBeHidden();
  expect((await content.boundingBox())!.width).toBeGreaterThanOrEqual(380);
  expect(await drawer.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('settings-phone-section.png'), animations: 'disabled' });

  // Back returns to the list, focused on the section just left; Back again closes.
  await back.click();
  await expect(nav).toBeVisible();
  await expect(content).toBeHidden();
  await expect(nav.getByRole('button', { name: 'Appearance', exact: true })).toBeFocused();
  await back.click();
  await expect(drawer).toHaveCount(0);

  // Reopening starts on the list again.
  await openArea(page, 'settings');
  await expect(nav).toBeVisible();
  await expect(content).toBeHidden();
});

test('a request for one Settings section opens straight on it on a phone', async ({ browser, baseURL }) => {
  const page = await phone(browser, baseURL);
  await boot(page);
  await page.locator('.terminal-topbar').waitFor();
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('michi:open-settings-section', { detail: { section: 'meta-agent' } }));
    window.dispatchEvent(new CustomEvent('michi:nav-page', { detail: { page: 'settings' } }));
  });
  const drawer = page.getByRole('dialog', { name: 'Settings', exact: true });
  const nav = drawer.getByRole('navigation', { name: 'Settings sections' });
  await expect(drawer.getByRole('heading', { level: 1, name: 'Meta agent', exact: true })).toBeVisible();
  await expect(nav).toBeHidden();
  await drawer.locator('.ui-overlay-header').getByRole('button', { name: 'Back', exact: true }).click();
  await expect(nav).toBeVisible();
});
