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
  await firstLauncher.getByRole('button', { name: 'Browser' }).click();
  await expect(page.locator(`[data-pane-id="${firstPaneId}"][data-pane-kind="browser"]`)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Browser address' })).toHaveValue('https://www.google.com/');
  await expect(page.getByText(/Native browser surfaces are available/)).toBeVisible();

  await page.getByRole('button', { name: 'New pane', exact: true }).click();
  const secondLauncher = page.locator('[data-pane-kind="launcher"]');
  const secondPaneId = await secondLauncher.getAttribute('data-pane-id');
  await secondLauncher.getByRole('button', { name: 'Terminal' }).click();
  await expect(page.locator(`[data-pane-id="${secondPaneId}"][data-pane-kind="terminal"]`)).toBeVisible();
  await expect(page.getByText(/Native terminal is available/)).toBeVisible();

  await page.getByRole('button', { name: 'New pane', exact: true }).click();
  const thirdLauncher = page.locator('[data-pane-kind="launcher"]');
  const thirdPaneId = await thirdLauncher.getAttribute('data-pane-id');
  await thirdLauncher.getByRole('button', { name: 'Files' }).click();
  await expect(page.locator(`[data-pane-id="${thirdPaneId}"][data-pane-kind="files"]`)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Filter files' })).toBeVisible();
  await expect(page.getByText('Select a file from the workspace tree')).toBeVisible();

  await page.getByRole('button', { name: 'New pane', exact: true }).click();
  const sideChatLauncher = page.locator('[data-pane-kind="launcher"]');
  const paneWrappers = page.locator('.terminal-dashboard').locator(':scope > [data-node-id]');
  const paneCountBeforeSideChat = await paneWrappers.count();
  await sideChatLauncher.getByRole('button', { name: 'Side chat' }).click();
  await expect(page.locator('[data-pane-kind="launcher"]')).toHaveCount(0);
  await expect(paneWrappers).toHaveCount(paneCountBeforeSideChat);

  await expect(page.locator('[data-pane-kind="browser"]')).toHaveCount(1);
  await expect(page.locator('[data-pane-kind="terminal"]')).toHaveCount(1);
  await expect(page.locator('[data-pane-kind="files"]')).toHaveCount(1);
});
