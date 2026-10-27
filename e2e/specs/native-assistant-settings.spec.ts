import { expect, test } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';
import { openSettings } from '../fixtures/shell';

test('native Assistant settings save without an external Desk service', async ({ page }, testInfo) => {
  const external: string[] = [];
  const writes: unknown[] = [];
  const info = {
    nodeId: 'assistant-node', workspaceId: 'assistant-workspace', treeId: 'assistant-tree',
    settings: { runtimeId: 'claude', modelId: null, reasoning: null }, supportedRuntimes: ['claude', 'kiro'],
  };
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/desk') || url.port === '4317') external.push(request.url());
  });
  await installMockApi(page, { custom: async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/assistant/settings') {
      const patch = route.request().postDataJSON();
      writes.push(patch);
      Object.assign(info.settings, patch);
      await route.fulfill({ json: info });
      return true;
    }
    if (path === '/api/assistant') {
      await route.fulfill({ json: info });
      return true;
    }
    return false;
  } });
  await bootWithWorkspace(page, 'Native settings');
  const settings = await openSettings(page, 'Assistant');
  await expect(settings.getByRole('combobox', { name: 'Assistant runtime' })).toHaveValue('claude');
  await expect(settings.getByRole('button', { name: 'Start new' })).toBeVisible();
  await settings.getByRole('combobox', { name: 'Assistant runtime' }).selectOption('kiro');
  await expect.poll(() => writes).toEqual([{ runtimeId: 'kiro', modelId: null, reasoning: null }]);
  await expect(settings.getByRole('combobox', { name: 'Assistant runtime' })).toHaveValue('kiro');
  expect(external).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('native-assistant-settings.png'), fullPage: true });
});
