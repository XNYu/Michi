import { test, expect } from '@playwright/test';
import { installMockApi, bootWithWorkspace } from '../fixtures/mockApi';

test('Pi model picker filters the live provider catalog', async ({ page }, testInfo) => {
  await installMockApi(page, {
    custom: async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname.replace(/^.*\/api/, '');

      if (path === '/agent/status') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            runtime: 'pi',
            label: 'Pi (multi-provider)',
            capabilities: {
              modes: false,
              permissions: true,
              models: true,
              providerModels: true,
              reasoning: true,
              supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'],
              apiKeys: true,
              warmSessions: false,
              saveContext: true,
              spawnBranches: true,
            },
            availableRuntimes: [{ id: 'pi', label: 'Pi (multi-provider)', available: true }],
            provider: 'openrouter',
            providers: [{
              id: 'openrouter',
              label: 'OpenRouter',
              keyLabel: 'OpenRouter API key',
              envVars: ['OPENROUTER_API_KEY'],
              defaultModel: 'stealth/ox-alpha',
              supportsReasoning: true,
              hasKey: true,
            }],
            model: 'stealth/ox-alpha',
            reasoning: 'high',
            hasRequiredKey: true,
          }),
        });
        return true;
      }

      if (path === '/agent/models') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            models: [
              { id: 'stealth/ox-alpha', label: 'Ox Alpha', description: 'Reasoning model for coding' },
              { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
              { id: 'google/gemini-3-pro', label: 'Gemini 3 Pro' },
            ],
            sanitizedModel: null,
          }),
        });
        return true;
      }

      return false;
    },
  });
  await bootWithWorkspace(page, 'Model Filter Workspace');

  await page.getByText('Settings', { exact: true }).last().click();
  await page.getByText('Model', { exact: true }).click();

  const filter = page.getByRole('searchbox', { name: 'Filter models' });
  await expect(filter).toBeVisible();
  await filter.fill('ox');

  const modelSelect = page.locator('select').filter({ has: page.locator('option[value="stealth/ox-alpha"]') });
  await expect(modelSelect.locator('option')).toHaveCount(1);
  await expect(modelSelect.locator('option')).toHaveText(['Ox Alpha']);
  await expect(page.getByText('1 of 3 models')).toBeVisible();

  const screenshotPath = process.env.MODEL_FILTER_SCREENSHOT
    ?? testInfo.outputPath('pi-model-filter.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
});
