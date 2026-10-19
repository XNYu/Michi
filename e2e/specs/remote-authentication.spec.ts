import { expect, test } from '@playwright/test';
import { REMOTE_CREDENTIALS, remoteSignInLabel } from 'michi-shared';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';

const connection = { id: 'remote-auth', name: 'Test remote', transport: 'ssh', sshHost: 'test-host', remotePort: 4444, hasToken: true, createdAt: 1, updatedAt: 1 };
const localWorkspace = { workspace: { id: 'local-ws', name: 'Local project', created_at: 1 }, nodes: [], trees: [], edges: [], messages: [], artifacts: [] };
function nativeAuthentication() {
  const state = { creates: [] as { id: string; target: unknown }[], destroyed: [] as string[], data: null as null | ((id: string, value: string) => void), exit: null as null | ((id: string, code: number) => void) };
  Object.assign(window, { nativeAuth: state, electron: {
    remoteAuthCreate: async (id: string, target: unknown) => { state.creates.push({ id, target }); setTimeout(() => state.data?.(id, 'Test sign-in\r\nPress Enter to finish test sign-in:\r\n'), 50); return { data: '', exited: false }; },
    terminalWrite: (id: string, data: string) => { if (data.includes('\r')) state.exit?.(id, 0); },
    terminalResize: () => {}, terminalDestroy: (id: string) => state.destroyed.push(id),
    onTerminalData: (callback: typeof state.data) => { state.data = callback; return () => { state.data = null; }; },
    onTerminalExit: (callback: typeof state.exit) => { state.exit = callback; return () => { state.exit = null; }; },
  } });
}

test('expired SSH authentication opens the native sign-in terminal and retries connection after sign-in', async ({ page }, testInfo) => {
  await page.addInitScript(nativeAuthentication);
  let attempts = 0;
  await installMockApi(page, { custom: async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/backend-connections') { await route.fulfill({ json: { connections: [] } }); return true; }
    if (path === '/api/backend-connections/connect-ssh') {
      attempts++;
      const result = attempts === 1
        ? { type: 'error', code: 'ssh_auth', message: 'SSH authentication needs attention.', diagnostic: { id: 'expired', host: 'test-host', startedAt: 'now', stage: 'ssh', code: 'ssh_auth', log: 'SSH certificate expired', truncated: false, authentication: { scope: 'local', host: 'test-host' } } }
        : { type: 'result', result: { kind: 'connected', connection, home: '/home/u', runtimes: ['codex'], runtimeWarnings: [] } };
      await route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify(result) + '\n' }); return true;
    }
    return false;
  } });
  await bootWithWorkspace(page);
  await page.getByText('Settings', { exact: true }).last().click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('button', { name: 'Connections', exact: true }).click();
  await settings.getByRole('button', { name: 'Connect remote', exact: true }).click();
  await settings.getByLabel(/\S+ SSH host$/).fill('test-host');
  await settings.getByRole('button', { name: 'Connect', exact: true }).click();
  const auth = page.getByRole('dialog', { name: remoteSignInLabel() });
  await expect(auth).toBeVisible();
  await expect(auth.getByText(REMOTE_CREDENTIALS.localAction, { exact: false })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).nativeAuth.creates.length)).toBe(1);
  await auth.locator('.xterm-helper-textarea').press('Enter');
  await expect.poll(() => attempts).toBe(2);
  await expect(auth.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('sign-in-terminal.png') });
  await auth.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(auth).toBeHidden();
  await expect(settings.getByText('Connected to Test remote', { exact: true })).toBeVisible();
});

test('gateway recovery restores a saved remote workspace without restarting the renderer', async ({ page }) => {
  let checks = 0, online = false;
  await installMockApi(page, { workspaces: [localWorkspace], custom: async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/backend-connections') { await route.fulfill({ json: { connections: [connection] } }); return true; }
    if (path === '/api/backend-connections/recovery') {
      checks++;
      if (checks > 1) online = true;
      await route.fulfill({ json: { recoveries: [{ connectionId: connection.id, phase: online ? 'ready' : 'starting', message: online ? 'Remote Michi is ready.' : 'Starting remote Michi…' }] } }); return true;
    }
    if (path.endsWith('/proxy/workspaces/all')) {
      await route.fulfill(online ? { json: { workspaces: [{ ...localWorkspace, workspace: { id: 'remote-ws', name: 'Recovered remotely', cwd: '/home/u', created_at: 2 } }] } }
        : { status: 502, json: { error: 'Starting remote Michi…' } }); return true;
    }
    return false;
  } });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Local project', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('complementary').getByText('Recovered remotely', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Remote connection issues' })).toHaveCount(0);
});

test('remote sign-in prompt can be cancelled, reopened and completed without sending a chat message', async ({ page }) => {
  await page.addInitScript(nativeAuthentication);
  let fixed = false, sends = 0, recoveries = 0;
  await installMockApi(page, { workspaces: [localWorkspace], custom: async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/backend-connections') { await route.fulfill({ json: { connections: [connection] } }); return true; }
    if (path === '/api/backend-connections/recovery') {
      await route.fulfill({ json: { recoveries: [{ connectionId: connection.id, phase: fixed ? 'ready' : 'error', message: 'Remote sign-in expired', authentication: fixed ? undefined : { scope: 'remote', host: 'test-host' } }] } }); return true;
    }
    if (path.endsWith('/recover')) { fixed = true; recoveries++; await route.fulfill({ status: 202, json: { phase: 'starting' } }); return true; }
    if (path.endsWith('/proxy/workspaces/all')) { await route.fulfill({ json: { workspaces: [] } }); return true; }
    if (path.endsWith('/message')) sends++;
    return false;
  } });
  await page.goto('/');
  const auth = page.getByRole('dialog', { name: remoteSignInLabel() });
  await expect(auth.getByText(/credentials on test-host need attention/i)).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).nativeAuth.creates.length)).toBe(1);
  await auth.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(auth).toBeHidden();
  await page.getByRole('button', { name: remoteSignInLabel(), exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).nativeAuth.creates.length)).toBe(2);
  await auth.locator('.xterm-helper-textarea').press('Enter');
  await expect(auth.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  expect(recoveries).toBe(1); expect(sends).toBe(0);
});
