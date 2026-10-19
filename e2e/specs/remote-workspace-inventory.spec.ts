import { expect, test } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

test('Connections reads live remote membership, clears it on failure, and rereads when reopened', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.addInitScript(() => localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1 })));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const connections = [
    { id: 'desktop', name: 'Build box', transport: 'ssh', sshHost: 'build+', hasToken: true, createdAt: 1, updatedAt: 1 },
    { id: 'build', name: 'Build server', transport: 'direct', apiUrl: 'https://build.example/api', hasToken: true, createdAt: 1, updatedAt: 1 },
  ];
  let inventory = [{ id: 'remote-only', name: 'Created from another device', cwd: '/srv/new' }];
  let offline = false;
  let inventoryReads = 0;
  await installMockApi(page, { workspaces: [{
    workspace: { id: 'local', name: 'Local notes', created_at: 1 },
    nodes: [], trees: [], edges: [], messages: [], artifacts: [],
  }], custom: async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/backend-connections') { await route.fulfill({ json: { connections } }); return true; }
    if (path === '/api/backend-connections/desktop/proxy/workspaces/all') {
      // Hydration deliberately stays stale throughout this test.
      await route.fulfill({ json: { workspaces: [{
        workspace: { id: 'stale-local', name: 'Old hydrated workspace', cwd: '/srv/old', created_at: 1 },
        nodes: [], trees: [], edges: [], messages: [], artifacts: [],
      }] } }); return true;
    }
    if (path === '/api/backend-connections/build/proxy/workspaces/all') {
      await route.fulfill({ json: { workspaces: [] } }); return true;
    }
    if (path === '/api/backend-connections/desktop/proxy/workspaces') {
      inventoryReads++;
      await route.fulfill(offline
        ? { status: 502, json: { error: 'SSH authentication expired. Renew authentication and retry.' } }
        : { json: { workspaces: inventory } });
      return true;
    }
    if (path === '/api/backend-connections/build/proxy/workspaces') {
      await route.fulfill({ json: { workspaces: [] } }); return true;
    }
    return false;
  } });
  await page.goto('/');
  await expect(page.getByRole('complementary').getByText('Old hydrated workspace', { exact: true })).toBeVisible();
  await page.getByRole('complementary').getByText('Settings', { exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('button', { name: 'Connections', exact: true }).click();
  const desktop = settings.getByRole('listitem', { name: 'Build box', exact: true });
  const build = settings.getByRole('listitem', { name: 'Build server', exact: true });
  await expect(desktop.getByText('Created from another device', { exact: true })).toBeVisible();
  await expect(desktop.getByText('Old hydrated workspace', { exact: true })).toHaveCount(0);
  await expect(desktop.getByText('1 workspace', { exact: true })).toBeVisible();
  await expect(build.getByText('0 workspaces', { exact: true })).toBeVisible();

  inventory = [{ id: 'replacement', name: 'Updated remote workspace', cwd: '/srv/current' }];
  await desktop.getByRole('button', { name: 'Refresh workspaces', exact: true }).click();
  await expect(desktop.getByText('Updated remote workspace', { exact: true })).toBeVisible();
  await expect(desktop.getByText('Created from another device', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('remote-workspaces-current.png') });

  offline = true;
  await desktop.getByRole('button', { name: 'Refresh workspaces', exact: true }).click();
  await expect(desktop.getByText('Workspaces unavailable', { exact: true })).toBeVisible();
  await expect(desktop.getByRole('alert')).toContainText('SSH authentication expired');
  await expect(desktop.getByText('Updated remote workspace', { exact: true })).toHaveCount(0);
  await expect(desktop.getByText('0 workspaces', { exact: true })).toHaveCount(0);
  await expect(build.getByText('0 workspaces', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('remote-workspaces-unavailable.png') });

  offline = false;
  inventory = [];
  await desktop.getByRole('button', { name: 'Retry workspaces', exact: true }).click();
  await expect(desktop.getByText('No workspaces on this machine.', { exact: true })).toBeVisible();
  await expect(desktop.getByText('0 workspaces', { exact: true })).toBeVisible();

  // Switching away unmounts Connections: opening it again must read the remote.
  inventory = [{ id: 'newer', name: 'Created while pane was closed', cwd: '/srv/newer' }];
  await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
  const previousReads = inventoryReads;
  await settings.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(desktop.getByText('Created while pane was closed', { exact: true })).toBeVisible();
  expect(inventoryReads).toBeGreaterThan(previousReads);
  // A display refresh must not replace hydrated workspaces or live chat state.
  await expect(page.getByRole('complementary').getByText('Old hydrated workspace', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
