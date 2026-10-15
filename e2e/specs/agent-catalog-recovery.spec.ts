import { expect, test } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

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
  await expect(page.locator('[contenteditable="true"]').first()).toBeVisible();
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
