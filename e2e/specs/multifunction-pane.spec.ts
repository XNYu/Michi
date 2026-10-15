import { expect, test } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';

test('new pane opens an in-pane chooser and transforms the same slot', async ({ page }) => {
  await installMockApi(page);
  await bootWithWorkspace(page);
  await page.locator('[contenteditable="true"]').first().fill('open workbench');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect(page.locator('.terminal-dashboard')).toBeVisible();

  await page.getByRole('button', { name: 'New pane', exact: true }).click();
  const firstLauncher = page.locator('[data-pane-kind="launcher"]');
  await expect(firstLauncher).toHaveCount(1);
  const firstPaneId = await firstLauncher.getAttribute('data-pane-id');
  await expect(firstLauncher.getByRole('button', { name: 'Review' })).toBeVisible();
  await expect(firstLauncher.getByRole('button', { name: 'Files' })).toBeVisible();
  // The browser opens only from the topbar Browser button, not the chooser.
  await expect(firstLauncher.getByRole('button', { name: 'Browser' })).toHaveCount(0);
  await firstLauncher.getByRole('button', { name: 'Terminal' }).click();
  await expect(page.locator(`[data-pane-id="${firstPaneId}"][data-pane-kind="terminal"]`)).toBeVisible();
  await expect(page.getByText(/Native terminal is available/)).toBeVisible();

  await page.getByRole('button', { name: 'New pane', exact: true }).click();
  const secondLauncher = page.locator('[data-pane-kind="launcher"]');
  const secondPaneId = await secondLauncher.getAttribute('data-pane-id');
  await secondLauncher.getByRole('button', { name: 'Files' }).click();
  await expect(page.locator(`[data-pane-id="${secondPaneId}"][data-pane-kind="files"]`)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Filter files' })).toBeVisible();
  await expect(page.getByText('Select a file from the workspace tree')).toBeVisible();

  await page.getByRole('button', { name: 'New pane', exact: true }).click();
  const sideChatLauncher = page.locator('[data-pane-kind="launcher"]');
  const paneWrappers = page.locator('.terminal-dashboard').locator(':scope > [data-node-id]');
  const paneCountBeforeSideChat = await paneWrappers.count();
  await sideChatLauncher.getByRole('button', { name: 'Side chat' }).click();
  await expect(page.locator('[data-pane-kind="launcher"]')).toHaveCount(0);
  await expect(paneWrappers).toHaveCount(paneCountBeforeSideChat);

  await expect(page.locator('[data-pane-kind="browser"]')).toHaveCount(0);
  await expect(page.locator('[data-pane-kind="terminal"]')).toHaveCount(1);
  await expect(page.locator('[data-pane-kind="files"]')).toHaveCount(1);
});


test('Browser button opens a matching pinned pane with a standard topbar caption', async ({ page }) => {
  await installMockApi(page);
  await bootWithWorkspace(page);
  await page.locator('[contenteditable="true"]').first().fill('browser pane');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  const dock = page.locator('[data-browser-dock]');
  const browser = dock.locator('[data-pane-kind="browser"]');
  await expect(browser).toBeVisible();
  await expect(page.locator('[data-pane-kind="launcher"]')).toHaveCount(0);
  await expect(page.locator('.terminal-dashboard [data-pane-kind="browser"]')).toHaveCount(0);
  const strip = page.locator('.terminal-dashboard');
  await expect.poll(async () => {
    const chat = await strip.locator(':scope > [data-node-id]').first().boundingBox();
    const web = await browser.boundingBox();
    return Math.abs(chat!.width - web!.width);
  }).toBeLessThan(2);
  const caption = page.locator('[data-browser-caption-host]');
  await expect(caption.getByText('Browser', { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const chatCaption = await page.locator('[data-pane-caption-viewport]').boundingBox();
    const webCaption = await caption.boundingBox();
    return Math.abs(chatCaption!.y - webCaption!.y);
  }).toBeLessThan(1);
  await expect.poll(async () => {
    const chat = await strip.boundingBox();
    const web = await browser.boundingBox();
    return Math.abs(chat!.y - web!.y);
  }).toBeLessThan(1);
  await page.screenshot({ path: test.info().outputPath('browser-pane.png') });
  // Reopening focuses the existing pane, without spawning tabs or a chooser.
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  await expect(page.locator('[data-pane-kind="browser"]')).toHaveCount(1);
  await caption.getByText('Browser', { exact: true }).hover();
  await caption.getByRole('button', { name: 'Close Browser' }).click();
  await expect(dock).toHaveCount(0);
  await expect.poll(async () => {
    const pane = await strip.locator(':scope > [data-node-id]').first().boundingBox();
    const available = await strip.boundingBox();
    return Math.abs(pane!.width - available!.width);
  }).toBeLessThan(2);
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  await expect(browser).toBeVisible();
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'New pane', exact: true }).click();
    await page.locator('[data-pane-kind="launcher"]').getByRole('button', { name: 'Terminal' }).click();
  }
  const before = await dock.boundingBox();
  await strip.evaluate(el => { el.scrollLeft = 0; });
  await expect.poll(() => dock.boundingBox()).toEqual(before);
  await strip.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await expect.poll(() => strip.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  await expect.poll(() => dock.boundingBox()).toEqual(before);
  await expect.poll(async () => {
    const body = await strip.boundingBox();
    const header = await page.locator('[data-pane-caption-viewport]').boundingBox();
    return Math.abs(body!.width - header!.width);
  }).toBeLessThan(2);
  await caption.getByText('Browser', { exact: true }).hover();
  await caption.getByRole('button', { name: 'Close Browser' }).click();
  await expect(dock).toHaveCount(0);
});
