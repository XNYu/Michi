import { expect, test } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

test('the Home agent pick survives a reload and applies to the next thread', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const ensureSessionBodies: Array<Record<string, unknown>> = [];
  const workspace = { workspace: { id: 'agent-pick-ws', name: 'Agent pick', created_at: 1 },
    trees: [], nodes: [], messages: [], edges: [], artifacts: [] };
  await installMockApi(page, { workspaces: [workspace], custom: async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^.*\/api/, '');
    if (path === '/agent/status') {
      await route.fulfill({ json: {
        runtime: 'kiro', label: 'Kiro', hasRequiredKey: true,
        capabilities: { modes: true, models: false, reasoning: false, providerModels: false },
        availableRuntimes: [{ id: 'kiro', label: 'Kiro', available: true }],
      } });
      return true;
    }
    if (path.endsWith('/modes')) {
      await route.fulfill({ json: {
        availableModes: [{ id: 'vibe', name: 'Default' }, { id: 'plan', name: 'Plan' }], defaultModeId: 'vibe',
      } });
      return true;
    }
    // Record the request, then let the shared mock answer it.
    if (request.method() === 'POST' && /^\/nodes\/[^/]+\/ensure-session$/.test(path)) {
      ensureSessionBodies.push(request.postDataJSON() as Record<string, unknown>);
    }
    return false;
  } });
  await page.addInitScript(() => {
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1 }));
  });

  await page.goto('/');
  const agentChip = page.locator('[title^="Switch agent"]').first();
  await expect(agentChip).toHaveAttribute('title', 'Switch agent — Default');
  await agentChip.click();
  await page.getByRole('menuitem', { name: 'Plan', exact: true }).click();
  await expect(agentChip).toHaveAttribute('title', 'Switch agent — Plan');

  await page.reload();
  await expect(page.locator('[title^="Switch agent"]').first()).toHaveAttribute('title', 'Switch agent — Plan');

  await page.locator('[contenteditable="true"]').first().fill('Plan the release');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect.poll(() => ensureSessionBodies.at(-1)?.modeId).toBe('plan');
});
