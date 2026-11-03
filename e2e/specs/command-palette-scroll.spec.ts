import { expect, test } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';

// The palette's rows are grouped in several menu lists inside one scrolling
// container. A wheel over any group must scroll that container.
test.use({ viewport: { width: 1280, height: 560 } });

test('the command palette scrolls with the mouse wheel', async ({ page }) => {
  await installMockApi(page);
  await bootWithWorkspace(page, 'Palette scroll');
  // Clicking waits for the closing workspace dialog to release its overlay.
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const list = page.locator('[data-menu="palette"]');
  await expect(list).toBeVisible();
  const overflow = await list.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(overflow).toBeGreaterThan(40);

  await list.evaluate((el) => { el.scrollTop = 0; });
  // Over a row of the first group, then over the next group's rows.
  const box = (await list.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await page.mouse.wheel(0, 120);
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 20);
  await page.mouse.wheel(0, 2000);
  await expect.poll(() => list.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(1);
});
