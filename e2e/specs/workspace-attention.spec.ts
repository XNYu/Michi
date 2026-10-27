import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { installMockApi, sseBody, type SseEvent } from '../fixtures/mockApi';

const evidenceDir = '/tmp/michi-improvements-2026-10-24';

declare global {
  interface Window {
    attentionStream?: ReadableStreamDefaultController<Uint8Array>;
  }
}

async function bootAttentionWorkspace(page: Page, fileContent?: string) {
  const prefs = {
    onboardingCompletedAt: 1, sidebarCollapsed: false, showThoughts: true,
    agentBlockStyle: 'card', defaultPaneWidth: 560, paneWidthMode: 'fixed',
    sidebarExpanded: { workspaces: { 'attention-ws': true }, threads: { 'attention-tree': true }, branches: {} },
  };
  const workspace = {
    workspace: { id: 'attention-ws', name: 'Attention regression workspace', active_tree_id: 'attention-tree', created_at: 1 },
    trees: [{ id: 'attention-tree', workspace_id: 'attention-ws', root_node_id: 'attention-root', name: 'Background task', created_at: 1, last_active_at: 1 }],
    nodes: ['attention-root', 'attention-draft'].map((id, index) => ({
      id, kind: 'chat', acp_session_id: id, runtime_id: 'mock', workspace_id: 'attention-ws', tree_id: 'attention-tree',
      title: index === 0 ? 'Background task' : 'Draft conversation', status: 'idle', created_at: index + 1,
    })),
    edges: [{ source_node_id: 'attention-root', target_node_id: 'attention-draft', kind: 'branch', created_at: 2 }],
    messages: [], artifacts: [],
  };
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installMockApi(page, { workspaces: [workspace], custom: async route => {
    if (fileContent && /^\/api\/artifacts\/[^/]+\/read$/.test(new URL(route.request().url()).pathname)) {
      await route.fulfill({ json: { content: fileContent, path: 'reading.md', basename: 'reading.md', extension: 'md', size: fileContent.length, modifiedAt: 1 } }); return true;
    }
    if (route.request().method() === 'GET' && new URL(route.request().url()).pathname.endsWith('/prefs')) {
      await route.fulfill({ json: { prefs } }); return true;
    }
    return false;
  } });
  // Keep one mock foreground turn open so browser assertions can interleave
  // user input with independently arriving provider events, without a backend.
  await page.addInitScript(prefs => {
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:prefs', JSON.stringify(prefs));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'attention-ws::attention-tree': ['attention-root', 'attention-draft'] }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'attention-ws::attention-tree': 'attention-root' }));
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
      if (init?.method === 'POST' && /\/chats\/[^/]+\/message$/.test(url.pathname)) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { window.attentionStream = controller; },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      return originalFetch(input, init);
    };
  }, prefs);
  await page.goto('/');
  await page.locator('.terminal-sidebar [data-sidebar-row="attention-root"]').click();
  const taskPane = page.locator('.terminal-pane[data-node-id="attention-root"]');
  const draftPane = page.locator('.terminal-pane[data-node-id="attention-draft"]');
  await expect(taskPane).toBeVisible();
  await page.locator('.terminal-sidebar [data-sidebar-row="attention-draft"]').click();
  await expect(draftPane).toBeVisible();
  await taskPane.locator('[contenteditable="true"]').fill('Work on the background task');
  await taskPane.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!window.attentionStream)).toBe(true);
  return { taskPane, draftPane };
}

async function emit(page: Page, events: SseEvent[]) {
  await page.evaluate(body => window.attentionStream!.enqueue(new TextEncoder().encode(body)), sseBody(events));
}

async function screenshot(page: Page, name: string) {
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}/${name}.png` });
}

test('approval arriving in another pane preserves the active composer and draft', async ({ page }) => {
  const { taskPane, draftPane } = await bootAttentionWorkspace(page);
  const draft = draftPane.locator('[contenteditable="true"]');
  await draft.fill('Keep writing here');
  await draft.press('End');
  await expect(draft).toBeFocused();
  await emit(page, [{ event: 'permission_request', data: {
    requestId: 401, title: 'Approve mock file write', source: 'michi_policy',
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  } }]);
  await expect(taskPane.getByRole('group', { name: 'Permission request' })).toBeVisible();
  await expect(draft).toBeFocused();
  await page.keyboard.type(' while approval waits');
  await expect(draft).toHaveText('Keep writing here while approval waits');
  await expect(taskPane.getByRole('button', { name: /^Allow Once/ })).toBeVisible();
  await screenshot(page, 'approval-preserves-other-composer');
});

test('expanded live activity stays bounded, preserves reading position, and follows again at the bottom', async ({ page }) => {
  const { taskPane } = await bootAttentionWorkspace(page);
  const reasoning = (from: number, count: number) => Array.from({ length: count }, (_, i) => `Reasoning step ${from + i}: inspect the isolated fixture and preserve user attention.`).join('\n\n');
  await emit(page, [{ event: 'thought', data: { text: reasoning(0, 75) } }]);
  await taskPane.getByText('Thinking…', { exact: true }).click();
  const activity = taskPane.getByRole('region', { name: 'Activity details' });
  await expect(activity).toBeVisible();
  const measure = () => activity.evaluate(el => ({ top: el.scrollTop, height: el.clientHeight, max: el.scrollHeight - el.clientHeight }));
  await expect.poll(async () => (await measure()).max).toBeGreaterThan(500);
  expect((await measure()).height).toBeLessThanOrEqual(480);
  await expect(activity).toHaveAttribute('tabindex', '0');
  // A real wheel event establishes a user reading position away from the tail.
  await activity.hover();
  await page.mouse.wheel(0, -650);
  await expect.poll(async () => { const m = await measure(); return m.max - m.top; }).toBeGreaterThan(100);
  const reading = await measure();
  await emit(page, [{ event: 'thought', data: { text: `\n\n${reasoning(75, 15)}` } }]);
  await expect(activity).toContainText('Reasoning step 89:');
  await expect.poll(async () => Math.abs((await measure()).top - reading.top)).toBeLessThan(2);
  await screenshot(page, 'activity-preserves-reading-position');
  // Return to the bottom using another real wheel interaction, then prove
  // further content is followed instead of merely checking a CSS declaration.
  await activity.hover();
  await page.mouse.wheel(0, 100000);
  await expect.poll(async () => { const m = await measure(); return m.max - m.top; }).toBeLessThan(2);
  const previousMax = (await measure()).max;
  await emit(page, [{ event: 'thought', data: { text: `\n\n${reasoning(90, 15)}` } }]);
  await expect.poll(async () => (await measure()).max).toBeGreaterThan(previousMax);
  await expect.poll(async () => { const m = await measure(); return m.max - m.top; }).toBeLessThan(2);
  await screenshot(page, 'activity-resumes-following');
});


test('file pane restores its reading position after leaving the dashboard and returning', async ({ page }) => {
  const content = Array.from({ length: 100 }, (_, i) => `## Reading section ${i}\n\nThis isolated document contains enough text to scroll and verify the same reading position after navigation.`).join('\n\n');
  const { taskPane } = await bootAttentionWorkspace(page, content);
  await emit(page, [
    { event: 'chunk', data: { text: 'Read [the document](reading.md).' } },
    { event: 'done', data: { stopReason: 'end_turn' } },
  ]);
  await taskPane.getByRole('link', { name: 'the document' }).click();
  const filePane = page.locator('[data-pane-kind="file"]');
  const scroller = filePane.locator('.term-scrollbar');
  await expect(filePane.getByRole('heading', { name: 'Reading section 0', exact: true })).toBeVisible();
  const paneId = await filePane.getAttribute('data-pane-id');
  await scroller.hover();
  await page.mouse.wheel(0, 900);
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(300);
  const before = await scroller.evaluate(el => el.scrollTop);
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(filePane).toHaveCount(0);
  await page.getByRole('button', { name: '‹ back', exact: true }).click();
  await expect(filePane).toHaveAttribute('data-pane-id', paneId!);
  await expect(filePane.getByRole('heading', { name: 'Reading section 0', exact: true })).toHaveCount(1);
  await expect.poll(() => scroller.evaluate((el, before) => Math.abs(el.scrollTop - before), before)).toBeLessThan(2);
  await screenshot(page, 'file-reading-position-restored');
});
