import { test, expect } from '@playwright/test';
import { installMockApi, bootWithWorkspace } from '../fixtures/mockApi';
import { COMPOSER_EDITOR } from '../fixtures/shell';

test('conversation file path opens an adjacent image pane using the preview API', async ({ page }) => {
  const reads: string[] = [];
  await installMockApi(page, {
    streamEvents: [
      { event: 'chunk', data: { text: 'Screenshot: `/home/me/shot.png`' } },
      { event: 'done', data: { stopReason: 'end_turn' } },
    ],
    custom: async route => {
      const url = new URL(route.request().url());
      if (/\/artifacts\/[^/]+\/read$/.test(url.pathname)) {
        reads.push(url.searchParams.get('path') ?? '');
        expect(url.searchParams.get('preview')).toBe('1');
        await route.fulfill({ json: { content: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', imageMime: 'image/png', extension: 'png', size: 68, modifiedAt: 1 } });
        return true;
      }
      return false;
    },
  });
  await bootWithWorkspace(page);
  await page.locator(COMPOSER_EDITOR).first().fill('Show the screenshot');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await page.locator('a[data-file-link]').filter({ hasText: '/home/me/shot.png' }).click();
  await expect(page.locator('[data-pane-kind="file"] img')).toBeVisible();
  await expect(page.locator(COMPOSER_EDITOR).first()).toBeVisible();
  expect(reads).toEqual(['/home/me/shot.png']);
});
