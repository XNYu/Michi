import { expect, test } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';
import { openSettings } from '../fixtures/shell';

test('exports a backup and restores only after preview confirmation', async ({ page }) => {
  const archive = { app: 'michi', version: 1, workspaces: [
    { workspace: { id: 'old', name: 'Recovered' }, trees: [], nodes: [], edges: [], messages: [], contexts: [] },
  ] };
  let imports = 0;
  await installMockApi(page, { custom: async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/backup/export') {
      await route.fulfill({ json: archive });
      return true;
    }
    if (url.pathname === '/api/backup/import') {
      expect(url.searchParams.get('mode')).toBe('merge');
      expect(route.request().postDataJSON()).toEqual(archive);
      imports++;
      await route.fulfill({ json: { imported: true, workspaceCount: 1 } });
      return true;
    }
    return false;
  } });
  await bootWithWorkspace(page, 'Backup test');
  const workspaceDialog = page.getByRole('dialog', { name: 'New workspace' });
  if (await workspaceDialog.isVisible()) await workspaceDialog.getByRole('button', { name: 'Close', exact: true }).click();
  const settings = await openSettings(page, 'Data & backup');
  const download = page.waitForEvent('download');
  await settings.getByRole('button', { name: 'Export backup' }).click();
  expect((await download).suggestedFilename()).toMatch(/^michi-backup-.*\.json$/);
  await settings.getByLabel('Backup file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) });
  await expect(settings.getByText('backup.json', { exact: true })).toBeVisible();
  expect(imports).toBe(0);
  await settings.getByRole('button', { name: 'Restore backup', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Reload Michi' })).toBeVisible();
  expect(imports).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  const content = settings.locator('.terminal-settings-content');
  expect(await content.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});
