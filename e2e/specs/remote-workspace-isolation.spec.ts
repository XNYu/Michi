import { expect, test } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

test('remote gap recovery keeps the same-ID Local copy separate and never writes remote data to Local', async ({ page }) => {
  const connection = { id: 'remote-isolation', name: 'Remote machine', transport: 'ssh', sshHost: 'build+', hasToken: true, createdAt: 1, updatedAt: 1 };
  const workspace = { workspace: { id: 'same-ws', name: 'Remote original', cwd: '/srv/project', active_tree_id: 'tree-1', created_at: 1 },
    trees: [{ id: 'tree-1', workspace_id: 'same-ws', root_node_id: 'same-node', created_at: 1, last_active_at: 1 }],
    nodes: [{ id: 'same-node', workspace_id: 'same-ws', tree_id: 'tree-1', title: 'Remote chat', runtime_id: 'mock', acp_session_id: 'same-node', status: 'idle', created_at: 1 }],
    edges: [], messages: [], contexts: [] };
  const writes: { remote: boolean; path: string; body: unknown }[] = [];
  let snapshots = 0;
  let sendGap = false;
  let gapSent = false;
  let offline = false;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1 })));
  await installMockApi(page, { workspaces: [{ ...workspace,
    workspace: { ...workspace.workspace, name: 'Local copy', cwd: '/local/project' },
    nodes: [{ ...workspace.nodes[0], title: 'Local chat' }] }], custom: async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const prefix = '/api/backend-connections/remote-isolation/proxy';
    const remote = path.startsWith(prefix);
    const apiPath = remote ? path.slice(prefix.length) : path.slice('/api'.length);
    if (path === '/api/backend-connections') { await route.fulfill({ json: { connections: [connection] } }); return true; }
    if (remote && offline) { await route.fulfill({ status: 503, json: { error: 'Remote offline' } }); return true; }
    if (remote && apiPath === '/workspaces/all') { await route.fulfill({ json: { workspaces: [workspace] } }); return true; }
    if (remote && apiPath === '/chats/background/subscribe') {
      const body = sendGap && !gapSent
        ? 'event: background_sync_required\ndata: ' + JSON.stringify({ chatId: 'same-node', nodeId: 'same-node', turnId: 'durable-turn', seq: 8 }) + '\n\n'
        : ': keepalive\n\n';
      if (sendGap) gapSent = true;
      await route.fulfill({ contentType: 'text/event-stream', body }); return true;
    }
    if (remote && apiPath === '/workspaces/same-ws') {
      snapshots++;
      await route.fulfill({ json: { ...workspace, workspace: { ...workspace.workspace, name: 'Remote recovered' } } }); return true;
    }
    if (remote && apiPath.endsWith('/messages')) { await route.fulfill({ json: { messages: [] } }); return true; }
    if (apiPath.endsWith('/commands')) {
      writes.push({ remote, path, body: request.postDataJSON() });
      await route.fulfill({ json: { ok: true } }); return true;
    }
    if (remote && apiPath === '/agent/status') { await route.fulfill({ json: { runtime: 'mock', label: 'Mock', hasRequiredKey: true, capabilities: {}, availableRuntimes: [{ id: 'mock', label: 'Mock', available: true }] } }); return true; }
    if (remote && apiPath === '/ready') { await route.fulfill({ json: { status: 'ready' } }); return true; }
    if (remote) { await route.fulfill({ json: { ok: true } }); return true; }
    return false;
  } });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Local copy', exact: true }).first()).toBeVisible();
  const remoteRow = page.getByTestId('workspace-row-remote:remote-isolation:same-ws');
  await remoteRow.getByText('Remote original', { exact: true }).click();
  sendGap = true;
  await expect.poll(() => snapshots).toBeGreaterThan(0);
  await expect(remoteRow.getByText('Remote recovered', { exact: true })).toBeVisible();
  await expect(page.getByTestId('workspace-row-same-ws').getByText('Local copy', { exact: true })).toBeVisible();
  await remoteRow.getByText('Remote chat', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Pin/ }).click();
  const pinsTree = (write: typeof writes[number]) => (write.body as {
    commands: Array<{ type: string; payload: { id?: string; pinned_at?: number | null } }>;
  }).commands.some(command => command.type === 'tree.upsert' && command.payload.id === 'tree-1' && typeof command.payload.pinned_at === 'number');
  await expect.poll(() => writes.some(write => write.remote && pinsTree(write))).toBe(true);
  expect(writes.some(write => !write.remote && pinsTree(write))).toBe(false);
  await remoteRow.getByText('Remote recovered', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Rename/ }).click();
  await remoteRow.getByRole('textbox').fill('Remote edited');
  await remoteRow.getByRole('textbox').press('Enter');
  await expect.poll(() => writes.filter(write => write.remote).map(write => JSON.stringify(write.body)).join('\n')).toContain('Remote edited');
  expect(writes.filter(write => !write.remote).map(write => JSON.stringify(write.body)).join('\n')).not.toContain('/srv/project');
  expect(writes.filter(write => !write.remote).map(write => JSON.stringify(write.body)).join('\n')).not.toContain('Remote edited');
  const remoteWorkspaceWrite = writes.filter(write => write.remote).map(write => JSON.stringify((write.body as { commands: unknown[] }).commands)).join('\n');
  expect(remoteWorkspaceWrite).toContain('same-ws');
  expect(remoteWorkspaceWrite).not.toContain('remote%3A');
  expect(remoteWorkspaceWrite).not.toContain('remote:remote-isolation:');
  expect(await page.evaluate(() => Object.values(localStorage).join('\n'))).not.toContain('/srv/project');

  offline = true;
  await expect(remoteRow).toHaveCount(0);
  await expect(page.getByTestId('workspace-row-same-ws')).toBeVisible();
  const localWritesBeforeReload = writes.filter(write => !write.remote).length;
  await page.reload();
  await expect(page.getByTestId('workspace-row-same-ws')).toBeVisible();
  await expect(remoteRow).toHaveCount(0);
  expect(await page.evaluate(() => Object.values(localStorage).join('\n'))).not.toContain('/srv/project');
  offline = false;
  await expect(remoteRow.getByText('Remote original', { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(writes.filter(write => !write.remote).slice(localWritesBeforeReload).map(write => JSON.stringify(write.body)).join('\n')).not.toContain('/srv/project');
  expect(errors).toEqual([]);
});
