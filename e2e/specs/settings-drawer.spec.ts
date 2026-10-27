import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';
import { areaButton, leaveSettings, openSettings, selectSettingsSection } from '../fixtures/shell';

const evidence = resolve('.artifacts/settings-drawer');

for (const palette of ['bone', 'monokai']) test(`global Settings stays a drawer in ${palette}`, async ({ page }) => {
  mkdirSync(evidence, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installMockApi(page, { custom: async route => {
    if (new URL(route.request().url()).pathname === '/api/prefs' && route.request().method() === 'GET') {
      await route.fulfill({ json: { prefs: { onboardingCompletedAt: 1, terminalPalette: palette, reduceMotion: true } } });
      return true;
    }
    return false;
  } });
  await bootWithWorkspace(page, 'Settings drawer');
  const newWorkspace = page.getByRole('dialog', { name: 'New workspace' });
  if (await newWorkspace.isVisible()) await newWorkspace.getByRole('button', { name: 'Close', exact: true }).click();
  const originalPage = await page.locator('.terminal-topbar').getAttribute('data-page');
  const originalCrumb = await page.locator('.terminal-topbar-breadcrumb').allTextContents();
  const content = await page.locator('.terminal-content-col').elementHandle();
  await openSettings(page, 'Appearance');
  const drawer = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
  await expect(areaButton(page, 'settings')).toHaveAttribute('aria-expanded', 'true');
  await expect(areaButton(page, 'conversations')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.terminal-topbar')).toHaveAttribute('data-page', originalPage!);
  expect(await page.locator('.terminal-topbar-breadcrumb').allTextContents()).toEqual(originalCrumb);
  const bounds = await drawer.boundingBox();
  expect(bounds!.x + bounds!.width).toBe(1440);
  expect(bounds!.width).toBe(720);
  await page.screenshot({ path: resolve(evidence, `global-settings-${palette}.png`) });

  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(areaButton(page, 'settings')).toBeFocused();
  expect(await content!.evaluate(element => element.isConnected)).toBe(true);
  await page.keyboard.press('Control+,');
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Control+,');
  await expect(drawer).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await openSettings(page, 'Meta agent');
  await expect(drawer.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Open sidebar', exact: true })).toHaveCount(0);
  const narrow = await drawer.boundingBox();
  expect(narrow!.width).toBe(390);
  expect(await drawer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const settingsContent = drawer.locator('.terminal-settings-content');
  expect(await settingsContent.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: resolve(evidence, `global-settings-narrow-${palette}.png`) });
  await selectSettingsSection(page, 'Data & backup');
  await drawer.getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.locator('.terminal-topbar')).toHaveAttribute('data-page', 'trash');
  await openSettings(page, 'Appearance');
  await leaveSettings(page);
  await expect(page.locator('.terminal-topbar')).toHaveAttribute('data-page', 'trash');
  expect(errors).toEqual([]);
});
