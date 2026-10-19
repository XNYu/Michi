import { expect, test } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

const connections = [
  { id: 'build-box', name: 'Build box', transport: 'ssh', sshHost: 'build+', hasToken: true, createdAt: 1, updatedAt: 1 },
  { id: 'direct', name: 'Build server', transport: 'direct', apiUrl: 'https://build.example.com/api', hasToken: true, createdAt: 1, updatedAt: 1 },
];
const workspace = (id: string, name: string, cwd: string) => ({
  workspace: { id, name, cwd, created_at: 1 }, nodes: [], trees: [], edges: [], messages: [], artifacts: [],
});

for (const palette of ['bone', 'gruvbox']) {
  test(`workspace machines and connection workspace lists stay linked in ${palette}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1180, height: 900 });
    await page.addInitScript(palette => localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, terminalPalette: palette })), palette);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await installMockApi(page, { workspaces: [workspace('local-project', 'Local notes', '/Users/example/notes')], custom: async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/backend-connections') { await route.fulfill({ json: { connections } }); return true; }
      if (/\/proxy\/agent\/status$/.test(path)) {
        await route.fulfill({ json: {
          runtime: 'mock', label: 'Mock Runtime', hasRequiredKey: true,
          capabilities: { modes: false, permissions: false, providerModels: false, reasoning: false, apiKeys: false, warmSessions: false },
          availableRuntimes: [{ id: 'mock', label: 'Mock Runtime', available: true }],
        } }); return true;
      }
      if (path === '/api/backend-connections/build-box/proxy/workspaces/all') {
        await route.fulfill({ json: { workspaces: [workspace('remote-api', 'API service', '/home/developer/projects/api'), workspace('remote-research', 'Research', '/home/developer/research')] } }); return true;
      }
      if (path === '/api/backend-connections/build-box/proxy/workspaces') {
        await route.fulfill({ json: { workspaces: [workspace('remote-api', 'API service', '/home/developer/projects/api').workspace, workspace('remote-research', 'Research', '/home/developer/research').workspace] } }); return true;
      }
      if (path === '/api/backend-connections/direct/proxy/workspaces/all') {
        await route.fulfill({ json: { workspaces: [workspace('remote-build', 'Build tools', '/srv/build/tools')] } }); return true;
      }
      if (path === '/api/backend-connections/direct/proxy/workspaces') {
        await route.fulfill({ json: { workspaces: [workspace('remote-build', 'Build tools', '/srv/build/tools').workspace] } }); return true;
      }
      return false;
    } });
    await page.goto('/');
    await expect(page.getByRole('complementary').getByText('API service', { exact: true })).toBeVisible();
    await page.getByText('Workspaces', { exact: true }).last().click();
    const remote = page.getByTestId('workspace-table-row-remote-api');
    await expect(remote.getByText('Remote - Build box', { exact: true })).toBeVisible();
    await expect(page.getByTestId('workspace-table-row-local-project').getByText('Local', { exact: true })).toBeVisible();
    await expect(page.getByTestId('workspace-table-row-remote-build').getByText('Remote - Build server', { exact: true })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Connection', exact: true })).toBeVisible();
    for (const name of ['Threads', 'Nodes', '14 days']) await expect(page.getByRole('columnheader', { name, exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`workspaces-${palette}.png`) });
    const filter = page.getByRole('searchbox', { name: 'Filter workspaces' });
    await filter.fill('build+');
    await expect(page.getByTestId(/^workspace-table-row-/)).toHaveCount(2);
    await filter.fill('');
    await remote.getByRole('button', { name: 'API service', exact: true }).click();
    await expect(page.locator('header').getByText('Remote · Build box', { exact: true })).toBeVisible();
    await page.getByText('Settings', { exact: true }).last().click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('button', { name: 'Connections', exact: true }).click();
    const list = settings.getByRole('list', { name: 'Workspaces on Build box' });
    await expect(list.getByRole('button', { name: 'API service', exact: true })).toBeVisible();
    await expect(list.getByRole('button', { name: 'Research', exact: true })).toBeVisible();
    await expect(list.getByText('/home/developer/projects/api', { exact: true })).toBeVisible();
    await expect(list.getByText('Build tools', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`connections-${palette}.png`) });
    await page.setViewportSize({ width: 540, height: 850 });
    await expect.poll(() => settings.locator('.terminal-settings-content').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await list.getByRole('button', { name: 'Research', exact: true }).click();
    await expect(settings).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Research', exact: true })).toBeVisible();
    await expect(page.locator('header').getByText('Remote · Build box', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}
