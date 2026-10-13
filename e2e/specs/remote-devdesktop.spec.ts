import { expect, test } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

test('connects a host, installs explicitly, selects a remote folder and creates a workspace', async ({ page }) => {
  const connection = { id: 'remote-c', name: 'build+', transport: 'ssh', sshHost: 'build+', remotePort: 4444, hasToken: true, createdAt: 1, updatedAt: 1 };
  let connected = false;
  const calls: { host: string; install: boolean }[] = [];
  const commands: unknown[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  let navigations = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
  await installMockApi(page, { custom: async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.pathname === '/api/backend-connections') {
      await route.fulfill({ json: { connections: connected ? [connection] : [] } }); return true;
    }
    if (url.pathname === '/api/backend-connections/connect-ssh') {
      const body = request.postDataJSON(); calls.push(body); connected = body.install;
      await route.fulfill({ contentType: 'application/x-ndjson', body: [
        { type: 'progress', stage: 'ssh', message: 'Connecting…' },
        { type: 'result', result: connected ? { kind: 'connected', connection, home: '/home/u', runtimes: ['kiro'] } : { kind: 'install_required', host: 'build+' } },
      ].map(value => JSON.stringify(value)).join('\n') + '\n' }); return true;
    }
    if (url.pathname === '/api/backend-connections/remote-c/directories') {
      const project = url.searchParams.get('path') === '/home/u/project';
      await route.fulfill({ json: project ? { path: '/home/u/project', parent: '/home/u', entries: [] }
        : { path: '/home/u', parent: '/home', entries: [{ name: 'project', path: '/home/u/project' }] } }); return true;
    }
    if (url.pathname === '/api/backend-connections/remote-c/proxy/workspaces/all') {
      await route.fulfill({ json: { workspaces: [] } }); return true;
    }
    if (url.pathname === '/api/backend-connections/remote-c/proxy/agent/status') {
      await route.fulfill({ json: { runtime: 'mock', label: 'Mock Runtime', hasRequiredKey: true,
        capabilities: { apiKeys: false, modes: false, permissions: false, providerModels: false, reasoning: false, warmSessions: false },
        availableRuntimes: [{ id: 'mock', label: 'Mock Runtime', available: true }] } }); return true;
    }
    if (url.pathname === '/api/backend-connections/remote-c/proxy/ready') {
      await route.fulfill({ json: { status: 'ready', error: null } }); return true;
    }
    if (url.pathname.endsWith('/commands') && request.method() === 'POST') {
      commands.push(request.postDataJSON()); await route.fulfill({ json: { ok: true } }); return true;
    }
    return false;
  } });
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: /New workspace/i });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Backend connection').selectOption('__add_remote__');
  await dialog.getByLabel('Remote SSH host').fill('build+');
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Install and connect' })).toBeVisible();
  expect(calls).toEqual([{ host: 'build+', install: false }]);
  await dialog.getByRole('button', { name: 'Install and connect' }).click();
  await dialog.getByRole('button', { name: 'project /' }).click();
  await expect(dialog.getByLabel('Browse remote folder')).toHaveValue('/home/u/project');
  await dialog.getByRole('button', { name: 'Use this folder' }).click();
  await expect(dialog.getByPlaceholder('/home/you/project')).toHaveValue('/home/u/project');
  await dialog.getByRole('button', { name: 'create', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(pageErrors).toEqual([]);
  await expect(page.getByRole('button', { name: 'project', exact: true }).first()).toBeVisible();
  await expect.poll(() => JSON.stringify(commands)).toContain('/home/u/project');
  expect(calls).toEqual([{ host: 'build+', install: false }, { host: 'build+', install: true }]);
  expect(navigations).toBe(1);
  expect(pageErrors).toEqual([]);
});
