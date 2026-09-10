import { expect, test } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';

test('local boot, fonts, drawers and optional pages do not produce console errors', async ({ page }, info) => {
  const issues: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', error => issues.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') issues.push(message.text());
  });
  page.on('response', response => {
    if (response.status() >= 400) issues.push(`${response.status()} ${response.url()}`);
  });
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  await installMockApi(page);
  await bootWithWorkspace(page, 'Console regression');

  // Load every declared family/weight, including choices that are not active.
  const fonts = await page.evaluate(async () => {
    const faces = Array.from(document.fonts);
    return Promise.all(faces.map(async face => {
      await face.load();
      return { family: face.family.replace(/['"]/g, ''), status: face.status };
    }));
  });
  expect(fonts.some(font => font.family === 'Inter')).toBe(true);
  expect(fonts.some(font => font.family === 'IBM Plex Mono')).toBe(true);
  expect(fonts.every(font => font.status === 'loaded')).toBe(true);

  await page.locator('.terminal-sidebar').getByText('Settings', { exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings).toBeVisible();
  for (const name of ['Appearance', 'Model', 'Connections', 'Notifications', 'Shortcuts']) {
    await settings.getByRole('button', { name, exact: true }).click();
    await expect(settings.getByRole('region', { name, exact: true })).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath('settings-desktop.png') });
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);

  const trigger = page.getByRole('button', { name: 'Artifacts', exact: true });
  const artifacts = page.getByRole('dialog', { name: 'Artifacts', exact: true });
  await trigger.click();
  await expect(artifacts).toBeVisible();
  await artifacts.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.drawer-shell-panel')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(artifacts).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(artifacts).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await page.locator('.terminal-sidebar').getByText('Agents', { exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Custom Agents are not enabled' })).toBeVisible();
  expect(requests.filter(path => /^\/api\/(?:auth\/|agents(?:\/|$)|agent-runs(?:\/|$))/.test(path))).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press('ControlOrMeta+,');
  await expect(settings).toBeVisible();
  await expect(settings).toBeInViewport();
  const bounds = await settings.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath('settings-narrow.png') });
  expect(issues).toEqual([]);
});
