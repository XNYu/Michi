import { expect, test } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';
import { COMPOSER_EDITOR, leaveSettings, openSettings } from '../fixtures/shell';

test('Connect shows an older remote build and updates it without reloading or changing drafts', async ({ page }, testInfo) => {
  const connection = { id: 'remote-update', name: 'Build box', transport: 'ssh', sshHost: 'build+', remotePort: 4444, hasToken: true, createdAt: 1, updatedAt: 1 };
  const older = { local: { version: '1.0.0', revision: 'bbbbbbb' }, remote: { version: '1.0.0', revision: 'aaaaaaa' }, state: 'older', canUpdate: true };
  let updated = false, updateCalls = 0;
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  await installMockApi(page, { custom: async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/backend-connections') { await route.fulfill({ json: { connections: [connection] } }); return true; }
    if (url.pathname === '/api/backend-connections/remote-update/version') { await route.fulfill({ json: updated ? { ...older, state: 'current', canUpdate: false } : older }); return true; }
    if (url.pathname === '/api/backend-connections/remote-update/update') {
      if (route.request().method() === 'GET') { await route.fulfill({ json: { update: null } }); return true; }
      updateCalls++; await pending; updated = true;
      await route.fulfill({ contentType: 'application/x-ndjson', body: [
        { type: 'progress', stage: 'build', message: 'Building remotely…' },
        { type: 'result', result: { ...older, state: 'current', canUpdate: false } },
      ].map(event => JSON.stringify(event)).join('\n') + '\n' }); return true;
    }
    if (url.pathname.endsWith('/proxy/workspaces/all') || url.pathname.endsWith('/proxy/workspaces')) { await route.fulfill({ json: { workspaces: [] } }); return true; }
    return false;
  } });
  await bootWithWorkspace(page, 'Update check');
  const editor = page.locator(COMPOSER_EDITOR).first(); await editor.fill('Keep this draft');
  const settings = await openSettings(page, 'General');
  const notice = settings.getByLabel('Michi update for Build box');
  await expect(notice.getByText('Remote Michi is older than this app')).toBeVisible();
  await expect(notice.getByText('Remote aaaaaaa · This app bbbbbbb')).toBeVisible();
  await page.setViewportSize({ width: 540, height: 850 });
  await expect.poll(() => settings.locator('.terminal-settings-content').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('remote-update-narrow.png') });
  await notice.getByRole('button', { name: 'Update remote Michi' }).click();
  await expect(notice.getByRole('button', { name: 'Updating…' })).toBeDisabled();
  release();
  await expect(notice.getByText('Remote Michi is up to date.')).toBeVisible();
  await expect(notice.getByRole('button')).toHaveCount(0);
  expect(updateCalls).toBe(1);
  await leaveSettings(page); await expect(settings).toBeHidden();
  await expect(editor).toHaveText('Keep this draft');
});

test('closing Settings or switching panes mid-update keeps showing that update instead of offering another', async ({ page }) => {
  const connection = { id: 'remote-update', name: 'Build box', transport: 'ssh', sshHost: 'build+', remotePort: 4444, hasToken: true, createdAt: 1, updatedAt: 1 };
  const older = { local: { version: '1.0.0', revision: 'bbbbbbb' }, remote: { version: '1.0.0', revision: 'aaaaaaa' }, state: 'older', canUpdate: true };
  const current = { ...older, remote: older.local, state: 'current', canUpdate: false };
  // The gateway owns the update: it keeps running after the renderer's stream detaches.
  let phase: 'idle' | 'running' | 'succeeded' = 'idle', updateCalls = 0;
  const job = () => phase === 'idle' ? null : {
    connectionId: connection.id, attemptId: 'attempt', phase, startedAt: '2026-10-23T00:00:00.000Z',
    ...(phase === 'running' ? { stage: 'build', message: 'Building remotely…' } : { stage: 'complete', message: 'Remote Michi is up to date.', result: current }),
  };
  await installMockApi(page, { custom: async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/backend-connections') { await route.fulfill({ json: { connections: [connection] } }); return true; }
    if (url.pathname === '/api/backend-connections/remote-update/version') { await route.fulfill({ json: phase === 'succeeded' ? current : older }); return true; }
    if (url.pathname === '/api/backend-connections/remote-update/update') {
      if (route.request().method() === 'GET') { await route.fulfill({ json: { update: job() } }); return true; }
      // Accept the update but never answer: closing Settings aborts this request.
      updateCalls++; phase = 'running'; return true;
    }
    if (url.pathname.endsWith('/proxy/workspaces/all') || url.pathname.endsWith('/proxy/workspaces')) { await route.fulfill({ json: { workspaces: [] } }); return true; }
    return false;
  } });
  await bootWithWorkspace(page, 'Update reopen');
  const openConnections = () => openSettings(page, 'General');
  let settings = await openConnections();
  let notice = settings.getByLabel('Michi update for Build box');
  await notice.getByRole('button', { name: 'Update remote Michi' }).click();
  await expect(notice.getByRole('button', { name: 'Updating…' })).toBeDisabled();
  await expect.poll(() => updateCalls).toBe(1);

  // Leaving Settings unmounts Connections.
  await leaveSettings(page);
  settings = await openConnections();
  notice = settings.getByLabel('Michi update for Build box');
  await expect(notice.getByRole('button', { name: 'Updating…' })).toBeDisabled();
  await expect(notice.getByText('Building remotely…')).toBeVisible();
  await expect(notice.getByRole('button', { name: 'Update remote Michi' })).toHaveCount(0);
  await expect(notice.getByRole('alert')).toHaveCount(0);

  await openSettings(page, 'Appearance');
  await openSettings(page, 'General');
  await expect(notice.getByRole('button', { name: 'Updating…' })).toBeDisabled();
  await expect(notice.getByRole('button', { name: 'Update remote Michi' })).toHaveCount(0);

  phase = 'succeeded';
  await expect(notice.getByText('Remote Michi is up to date.')).toBeVisible();
  await expect(notice.getByRole('button')).toHaveCount(0);
  expect(updateCalls).toBe(1);
});

test('a newly connected older machine shows its update action in the workspace Connect flow', async ({ page }) => {
  const connection = { id: 'new-remote', name: 'build+', transport: 'ssh', sshHost: 'build+', hasToken: true, createdAt: 1, updatedAt: 1 };
  let connected = false;
  await installMockApi(page, { custom: async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/backend-connections') { await route.fulfill({ json: { connections: connected ? [connection] : [] } }); return true; }
    if (url.pathname === '/api/backend-connections/connect-ssh') {
      connected = true; await route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'result', result: {
        kind: 'connected', connection, home: '/home/u', runtimes: ['codex'],
      } }) + '\n' }); return true;
    }
    if (url.pathname.endsWith('/version')) {
      await route.fulfill({ json: { local: { version: '1.0.0', revision: 'bbbbbbb' }, remote: { version: '1.0.0', revision: 'aaaaaaa' }, state: 'older', canUpdate: true } }); return true;
    }
    if (url.pathname.endsWith('/directories')) { await route.fulfill({ json: { path: '/home/u', parent: '/home', entries: [] } }); return true; }
    if (url.pathname.endsWith('/proxy/workspaces/all') || url.pathname.endsWith('/proxy/workspaces')) { await route.fulfill({ json: { workspaces: [] } }); return true; }
    return false;
  } });
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: /New workspace/i });
  await dialog.getByLabel('Backend connection').selectOption('__add_remote__');
  await dialog.getByLabel(/\S+ SSH host$/).fill('build+');
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Update remote Michi' })).toBeVisible();
  await expect(dialog.getByLabel('Backend connection')).toHaveValue(connection.id);
  await expect(dialog.getByText('Remote aaaaaaa · This app bbbbbbb')).toBeVisible();
});
