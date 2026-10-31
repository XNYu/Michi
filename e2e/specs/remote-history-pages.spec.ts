import { expect, test } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { COMPOSER_EDITOR } from '../fixtures/shell';

test('remote history opens at the recent page, loads older messages, and survives an offline/reconnect cycle', async ({ page }) => {
  const connection = { id: 'paged-remote', name: 'Remote', transport: 'ssh', sshHost: 'build+', hasToken: true, createdAt: 1, updatedAt: 1 };
  const prefix = '/api/backend-connections/paged-remote/proxy';
  const rows = Array.from({ length: 120 }, (_, seq) => ({ id: `m${seq}`, node_id: 'node', role: seq % 2 ? 'assistant' : 'user',
    content: `History item ${seq}`, seq, created_at: seq + 1 }));
  const workspace = { workspace: { id: 'ws', name: 'Remote history', active_tree_id: 'tree', created_at: 1 },
    trees: [{ id: 'tree', workspace_id: 'ws', root_node_id: 'node', created_at: 1, last_active_at: 1 }],
    nodes: [{ id: 'node', workspace_id: 'ws', tree_id: 'tree', title: 'Long conversation', runtime_id: 'mock', acp_session_id: 'node', status: 'idle', message_count: 120, created_at: 1 }],
    edges: [], messages: [], contexts: [] };
  const reads: URL[] = [];
  let offline = false;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1 })));
  await installMockApi(page, { workspaces: [], custom: async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/backend-connections') { await route.fulfill({ json: { connections: [connection] } }); return true; }
    if (!url.pathname.startsWith(prefix)) return false;
    const path = url.pathname.slice(prefix.length);
    if (offline) { await route.fulfill({ status: 503, json: { error: 'Temporarily offline' } }); return true; }
    if (path === '/workspaces/all') { await route.fulfill({ json: { workspaces: [workspace] } }); return true; }
    if (path === '/workspaces/ws/trees/tree/messages') {
      reads.push(url);
      const limit = Number(url.searchParams.get('limit') ?? rows.length);
      const end = Number(url.searchParams.get('beforeSeq') ?? rows.length);
      const messages = rows.slice(Math.max(0, end - limit), end);
      await route.fulfill({ json: { messages, pages: [{ nodeId: 'node', total: rows.length,
        before: end > limit ? { id: messages[0].id, seq: messages[0].seq } : null }] } });
      return true;
    }
    if (path === '/health') { await route.fulfill({ json: { service: 'michi-backend', status: 'healthy' } }); return true; }
    if (path === '/chats/background/subscribe') { await route.fulfill({ contentType: 'text/event-stream', body: ': keepalive\n\n' }); return true; }
    if (path === '/agent/status') { await route.fulfill({ json: { runtime: 'mock', label: 'Mock', hasRequiredKey: true, capabilities: {},
      availableRuntimes: [{ id: 'mock', label: 'Mock', available: true }] } }); return true; }
    if (path === '/ready') { await route.fulfill({ json: { status: 'ready' } }); return true; }
    await route.fulfill({ json: { ok: true } }); return true;
  } });
  await page.goto('/');
  const remote = page.getByTestId('workspace-row-remote:paged-remote:ws');
  await expect(remote).toBeVisible();
  await remote.getByText('Long conversation', { exact: true }).click();
  await expect(page.getByText('History item 119', { exact: true })).toBeVisible();
  expect(reads.every(url => url.searchParams.get('limit') === '50')).toBe(true);
  await expect(page.getByText('History item 0', { exact: true })).toHaveCount(0);
  const older = page.getByRole('button', { name: 'Load older messages', exact: true });
  const transcript = page.locator('.terminal-pane__transcript').first();
  // Real reader input cancels an in-progress restore. Programmatic scrolling
  // alone can race the preceding page's content-visibility settling pass.
  const scrollToHistoryStart = async () => {
    await transcript.hover();
    await page.mouse.wheel(0, -100_000);
    await expect.poll(() => transcript.evaluate(el => el.scrollTop)).toBe(0);
  };
  await scrollToHistoryStart();
  const anchor = page.getByText('History item 70', { exact: true });
  const anchorTop = (await anchor.boundingBox())!.y;
  await older.click();
  await expect(page.getByText('History item 20', { exact: true })).toBeAttached();
  await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - anchorTop)).toBeLessThan(3);
  expect(reads.at(-1)?.searchParams.get('beforeSeq')).toBe('70');
  expect(reads.at(-1)?.searchParams.get('nodeId')).toBe('node');
  await scrollToHistoryStart();
  const secondAnchor = page.getByText('History item 20', { exact: true });
  const secondTop = (await secondAnchor.boundingBox())!.y;
  await older.click();
  await expect(page.getByText('History item 0', { exact: true })).toBeAttached();
  await expect.poll(async () => Math.abs((await secondAnchor.boundingBox())!.y - secondTop)).toBeLessThan(3);
  await expect(older).toHaveCount(0);
  const composer = page.locator(COMPOSER_EDITOR).first();
  await composer.fill('Keep this unsent draft');
  const readsBefore = reads.length;
  offline = true;
  await page.evaluate(async () => {
    const path = '/src/services/api/backendRequest.ts';
    const { backendFetch } = await import(path);
    await backendFetch('/api/backend-connections/paged-remote/proxy/agent/status');
  });
  await expect(remote).toBeVisible();
  await expect(composer).toContainText('Keep this unsent draft');
  await expect(page.getByText('History item 0', { exact: true })).toBeAttached();
  offline = false;
  await expect.poll(() => page.evaluate(async () => {
    const path = '/src/config/backendConnectionState.ts';
    const { backendConnectionUnavailable } = await import(path);
    return backendConnectionUnavailable('paged-remote');
  })).toBe(false);
  await expect(composer).toContainText('Keep this unsent draft');
  await expect(page.getByText('History item 0', { exact: true })).toHaveCount(1);
  expect(reads.length).toBe(readsBefore);
  expect(errors).toEqual([]);
});
