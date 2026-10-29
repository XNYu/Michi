import { expect, test } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';
import { leaveSettings, openSettings } from '../fixtures/shell';

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

  const settings = await openSettings(page);
  await expect(settings).toBeVisible();
  for (const name of ['Appearance', 'Runtime (global)', 'General', 'Meta agent', 'Components', 'Data & backup'] as const) {
    await openSettings(page, name);
    await expect(settings.getByRole('region', { name, exact: true })).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath('settings-desktop.png') });
  await leaveSettings(page);
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

  // Custom Agents is off unless the backend opts in (MICHI_CUSTOM_AGENTS=1):
  // no sidebar entry, no Settings category, and none of its routes are polled.
  await expect(page.locator('.terminal-sidebar').getByText('Agents', { exact: true })).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+,');
  await expect(settings).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByText(/custom agents/i)).toHaveCount(0);
  await expect(settings.getByText(/custom agents/i)).toHaveCount(0);
  await leaveSettings(page);
  expect(requests.filter(path => /^\/api\/(?:auth\/|agents(?:\/|$)|agent-runs(?:\/|$))/.test(path))).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  // Home focuses its composer again, and shortcuts typed into it are text.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+,');
  await expect(settings).toBeVisible();
  await expect(settings).toBeInViewport();
  // Measure at rest: while anything slides in, translated edges are
  // rounded separately (float32), so the width can read 390.00003.
  await expect.poll(() => settings.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
  const bounds = await settings.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath('settings-narrow.png') });
  expect(issues).toEqual([]);
});
