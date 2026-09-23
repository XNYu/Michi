import { expect, test } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

const workspace = {
  workspace: { id: 'boot-ws', name: 'Boot workspace', created_at: 1, active_tree_id: 'tree-a' },
  trees: ['a', 'b'].map((id) => ({
    id: `tree-${id}`, workspace_id: 'boot-ws', root_node_id: id,
    name: `Thread ${id.toUpperCase()}`, created_at: 1, last_active_at: 1,
  })),
  nodes: ['a', 'b'].map((id) => ({
    id, tree_id: `tree-${id}`, workspace_id: 'boot-ws', kind: 'chat',
    title: `Thread ${id.toUpperCase()}`, created_at: 1, message_count: 1,
    last_assistant_at: 2, status: 'idle',
  })),
  edges: [], messages: [], artifacts: [],
};
const messages = (id: string) => [{
  id: `message-${id}`, node_id: id, role: 'user', content: `Conversation ${id.toUpperCase()} is ready`,
  seq: 0, created_at: 1,
}];

for (const width of [1280, 390]) {
  test(`shell works before workspace hydration at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 850 });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const writes: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await installMockApi(page, {
      workspaces: [workspace],
      custom: async (route) => {
        const url = new URL(route.request().url());
        if (route.request().method() !== 'GET' && /^\/api\/(workspaces|nodes|node-ids)/.test(url.pathname)) writes.push(url.pathname);
        if (url.pathname === '/api/workspaces/all') await pending;
        if (url.pathname.endsWith('/trees/tree-a/messages')) {
          await route.fulfill({ json: { messages: messages('a') } });
          return true;
        }
        return false;
      },
    });
    await page.addInitScript(() => localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false })));
    try {
      await page.goto('/');
      await expect(page.locator('.terminal-topbar')).toBeVisible();
      await expect(page.getByRole('status', { name: 'Loading workspaces' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeDisabled();
      await expect(page.getByPlaceholder('Untitled workspace')).toHaveCount(0);
      await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
      await page.keyboard.press('Control+,');
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
      await expect(settings).toBeVisible();
      await settings.getByRole('button', { name: 'Model', exact: true }).click();
      await expect(settings.getByRole('status')).toHaveText('Loading workspaces…');
      await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
      await expect(settings.getByRole('status')).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`shell-first-settings-${width}.png`) });
      await settings.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(settings).toHaveCount(0);
      await expect(page.locator('.drawer-shell-panel')).toHaveCount(0);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('michi:open-new-workspace')));
      await expect(page.getByPlaceholder('Untitled workspace')).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`shell-first-${width}.png`) });
      expect(writes).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      release();
    }
    await expect(page.getByRole('status', { name: 'Loading workspaces' })).toHaveCount(0);
    await expect(page.locator('[contenteditable="true"]').first()).toBeVisible();
    expect(errors).toEqual([]);
  });
}

for (const sidebarView of ['activity', 'structure'] as const) {
  test(`${sidebarView}: hover prefetch does not navigate and is reused when clicked`, async ({ page }, info) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let otherReads = 0;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await installMockApi(page, { workspaces: [workspace], custom: async (route) => {
      const match = new URL(route.request().url()).pathname.match(/\/trees\/tree-([ab])\/messages$/);
      if (!match) return false;
      if (match[1] === 'b') { otherReads += 1; await pending; }
      await route.fulfill({ json: { messages: messages(match[1]) } });
      return true;
    } });
    await page.addInitScript((view) => localStorage.setItem('michi:v1:prefs', JSON.stringify({
      onboardingCompletedAt: 1, sidebarCollapsed: false, sidebarView: view,
      sidebarExpanded: { workspaces: { 'boot-ws': true }, threads: {}, branches: {} },
    })), sidebarView);
    try {
      await page.goto('/');
      const rowA = page.locator('.terminal-sidebar [data-sidebar-row="a"]');
      const rowB = page.locator('.terminal-sidebar [data-sidebar-row="b"]');
      await rowA.click();
      await expect(page.locator('.terminal-dashboard > [data-node-id="a"]')).toBeVisible();
      await rowB.hover();
      await expect.poll(() => otherReads).toBe(1);
      await expect(page.locator('.terminal-dashboard > [data-node-id="a"]')).toBeVisible();
      await expect(page.locator('.terminal-dashboard > [data-node-id="b"]')).toHaveCount(0);
      await rowB.click();
      await expect(page.locator('.terminal-dashboard > [data-node-id="b"]')).toBeVisible();
    } finally {
      release();
    }
    await expect(page.locator('.terminal-dashboard').getByText('Conversation B is ready', { exact: true })).toBeVisible();
    expect(otherReads).toBe(1);
    await page.screenshot({ path: info.outputPath(`${sidebarView}-prefetched.png`) });
    expect(errors).toEqual([]);
  });
}
