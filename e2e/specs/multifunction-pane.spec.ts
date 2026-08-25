import { expect, test } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';

test('new pane launcher opens browser and terminal surfaces with web fallbacks', async ({ page }) => {
  await installMockApi(page);
  await bootWithWorkspace(page);
  await page.locator('[contenteditable="true"]').first().fill('open workbench');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect(page.locator('.terminal-dashboard')).toBeVisible();

  await page.getByRole('button', { name: 'New pane', exact: true }).click();
  await page.getByRole('menuitem', { name: /Browser/ }).click();
  await expect(page.getByRole('textbox', { name: 'Browser address' })).toHaveValue('https://www.google.com/');
  await expect(page.getByText(/Native browser surfaces are available/)).toBeVisible();

  await page.getByRole('button', { name: 'New pane', exact: true }).click();
  await page.getByRole('menuitem', { name: /Terminal/ }).click();
  await expect(page.getByText(/Native terminal is available/)).toBeVisible();

  await expect(page.locator('[data-pane-kind="browser"]')).toHaveCount(1);
  await expect(page.locator('[data-pane-kind="terminal"]')).toHaveCount(1);
});
