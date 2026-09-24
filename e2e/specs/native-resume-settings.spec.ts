import { test, expect } from '@playwright/test';
import { installMockApi, bootWithWorkspace } from '../fixtures/mockApi';

test('Model settings retain Native Resume independently for each runtime', async ({ page }, testInfo) => {
  let runtime = 'codex';
  const preferences: Record<string, boolean> = {};
  const runtimes = [
    { id: 'codex', label: 'Codex', available: true },
    { id: 'claude', label: 'Claude', available: true },
    { id: 'pi', label: 'Pi', available: true },
  ];
  await installMockApi(page, { custom: async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api/, '');
    if (path === '/agent/status') {
      await route.fulfill({ json: { runtime, label: runtimes.find((item) => item.id === runtime)!.label,
        capabilities: { modes: false, permissions: false, models: false, providerModels: false,
          reasoning: false, apiKeys: false, warmSessions: false, saveContext: false,
          spawnBranches: true, nativeResume: runtime !== 'pi' },
        availableRuntimes: runtimes, nativeResumeByRuntime: preferences, hasRequiredKey: true } });
      return true;
    }
    if (path === '/agent/options') {
      const body = route.request().postDataJSON();
      if (body.runtime) runtime = body.runtime;
      Object.assign(preferences, body.nativeResumeByRuntime);
      await route.fulfill({ json: { ok: true } });
      return true;
    }
    return false;
  } });
  await bootWithWorkspace(page, 'Native Resume Settings');
  await page.getByText('Settings', { exact: true }).last().click();
  await page.getByText('Model', { exact: true }).click();
  const codex = page.getByRole('switch', { name: 'Native Resume for Codex' });
  await expect(codex).toHaveAttribute('aria-checked', 'true');
  await codex.click();
  await expect(codex).toHaveAttribute('aria-checked', 'false');
  const picker = page.locator('select').filter({ has: page.locator('option[value="codex"]') });
  await picker.selectOption('claude');
  const claude = page.getByRole('switch', { name: 'Native Resume for Claude' });
  await expect(claude).toHaveAttribute('aria-checked', 'true');
  await picker.selectOption('codex');
  await expect(codex).toHaveAttribute('aria-checked', 'false');
  await page.reload();
  await page.getByRole('dialog', { name: 'New workspace' }).getByRole('button', { name: 'cancel', exact: true }).click();
  await page.getByText('Settings', { exact: true }).last().click();
  await page.getByText('Model', { exact: true }).click();
  await expect(codex).toHaveAttribute('aria-checked', 'false');
  await page.screenshot({ path: testInfo.outputPath('native-resume-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await codex.scrollIntoViewIfNeeded();
  await expect(codex).toBeVisible();
  const pickerBounds = await picker.boundingBox();
  expect(pickerBounds!.x + pickerBounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('native-resume-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await picker.selectOption('pi');
  await expect(page.getByRole('switch', { name: /Native Resume/ })).toHaveCount(0);
  expect(preferences).toEqual({ codex: false });
});
