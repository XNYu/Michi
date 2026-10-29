import { test, expect } from '@playwright/test';
import { installMockApi, bootWithWorkspace } from '../fixtures/mockApi';
import { COMPOSER_EDITOR } from '../fixtures/shell';

test('agent file artifacts group images and download arbitrary files without reading them as text', async ({ page }) => {
  let textReads = 0;
  await installMockApi(page, {
    streamEvents: [
      { event: 'artifact_saved', data: { name: 'screenshot', filePath: '.attachments/shot.png', size: 68, contextId: 'ctx-image' } },
      { event: 'artifact_saved', data: { name: 'archive', filePath: 'output.custom', size: 4, contextId: 'ctx-file' } },
      { event: 'chunk', data: { text: 'Saved both files.' } },
      { event: 'done', data: { stopReason: 'end_turn' } },
    ],
    custom: async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/download')) {
        await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: Buffer.from([0, 255, 128, 42]) });
        return true;
      }
      if (url.pathname.endsWith('/shot.png')) {
        await route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64') });
        return true;
      }
      if (/\/artifacts\/[^/]+\/read$/.test(url.pathname)) textReads++;
      return false;
    },
  });
  await bootWithWorkspace(page);
  await page.locator(COMPOSER_EDITOR).first().fill('Save my files');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect(page.getByText('Saved both files.')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+A');
  await expect(page.getByText('screenshot', { exact: true })).toBeVisible();
  await page.getByText('screenshot', { exact: true }).click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('img[src*="shot.png"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByText('archive', { exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('output.custom');
  expect(textReads).toBe(0);
});
