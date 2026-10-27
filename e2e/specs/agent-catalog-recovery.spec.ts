import { expect, test } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { COMPOSER_EDITOR } from '../fixtures/shell';

test('agent discovery recovers through the picker without refreshing the page', async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let available = false;
  const workspace = { workspace: { id: 'recovery-ws', name: 'Agent recovery', created_at: 1 },
    trees: [], nodes: [], messages: [], edges: [], artifacts: [] };
  await installMockApi(page, { workspaces: [workspace], custom: async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api/, '');
    if (path === '/agent/status') {
      await route.fulfill({ json: {
        runtime: 'kiro', label: 'Kiro', hasRequiredKey: true,
        capabilities: { modes: true, models: false, reasoning: false, providerModels: false },
        availableRuntimes: [{ id: 'kiro', label: 'Kiro', available: true }],
      } });
      return true;
    }
    if (path.endsWith('/modes')) {
      await route.fulfill(available
        ? { json: { availableModes: [{ id: 'vibe', name: 'Default' }, { id: 'plan', name: 'Plan' }], defaultModeId: 'vibe' } }
        : { status: 503, json: { error: 'Runtime starting' } });
      return true;
    }
    return false;
  } });
  await page.addInitScript(() => {
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1 }));
  });
  await page.goto('/');
  await expect(page.locator(COMPOSER_EDITOR).first()).toBeVisible();
  const trigger = page.locator('[title^="Switch agent"]').first();
  await trigger.click();
  await expect(page.getByText('Loading agents…', { exact: true })).toBeVisible();
  await page.clock.fastForward(60_000);
  await expect(page.getByText('Agents took too long to load. Please retry.', { exact: true })).toBeVisible();
  available = true;
  await page.getByRole('menuitem', { name: 'Retry loading agents', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Agents', exact: true })).toHaveCount(0);
  await trigger.click();
  await expect(page.getByRole('menuitem', { name: 'Plan', exact: true })).toBeVisible();
  await expect(page.getByText('Loading agents…', { exact: true })).toHaveCount(0);
});

test('a missing Workspace folder stops background retries and shows a repairable error', async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let available = false;
  let modeRequests = 0;
  let warmRequests = 0;
  const error = 'Workspace folder does not exist or is not accessible: /deleted/dashboard. Select an existing folder for this Workspace.';
  const workspace = { workspace: { id: 'missing-folder-ws', name: 'Missing folder', cwd: '/deleted/dashboard', created_at: 1 },
    trees: [], nodes: [], messages: [], edges: [], artifacts: [] };
  await installMockApi(page, { workspaces: [workspace], custom: async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api/, '');
    if (path === '/agent/status') {
      await route.fulfill({ json: {
        runtime: 'kiro', label: 'Kiro', hasRequiredKey: true,
        capabilities: { modes: true, models: false, reasoning: false, providerModels: false, warmSessions: true },
        availableRuntimes: [{ id: 'kiro', label: 'Kiro', available: true }],
      } });
      return true;
    }
    if (path.endsWith('/modes')) {
      modeRequests += 1;
      await route.fulfill(available
        ? { json: { availableModes: [{ id: 'plan', name: 'Plan' }], defaultModeId: 'plan' } }
        : { status: 400, json: { code: 'WORKSPACE_CWD_INVALID', error } });
      return true;
    }
    if (path === '/warm') {
      warmRequests += 1;
      await route.fulfill({ status: 400, json: { code: 'WORKSPACE_CWD_INVALID', error } });
      return true;
    }
    return false;
  } });
  await page.addInitScript(() => {
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1 }));
  });
  await page.goto('/');
  const trigger = page.locator('[title^="Switch agent"]').first();
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.getByText(error, { exact: true })).toBeVisible();
  await expect.poll(() => warmRequests).toBe(1);
  const initialModes = modeRequests;
  // More than either retry window: permanent configuration errors remain
  // visible and do not restart due to background sync or timer updates.
  await page.clock.fastForward(120_000);
  await expect(page.getByText(error, { exact: true })).toBeVisible();
  expect(modeRequests).toBe(initialModes);
  expect(warmRequests).toBe(1);

  available = true;
  await page.getByRole('menuitem', { name: 'Retry loading agents', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Agents', exact: true })).toHaveCount(0);
  await trigger.click();
  await expect(page.getByRole('menuitem', { name: 'Plan', exact: true })).toBeVisible();
  expect(modeRequests).toBe(initialModes + 1);
  await expect(page.getByText(error, { exact: true })).toHaveCount(0);
});
