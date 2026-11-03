import { test, expect, type Page } from '@playwright/test';
import { installMockApi, bootWithWorkspace } from '../fixtures/mockApi';
import { openSettings } from '../fixtures/shell';

async function installPiCatalog(page: Page) {
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
              keyUrl: 'https://openrouter.ai/keys',
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
  return openSettings(page, 'Runtime (global)');
}

test('Pi model picker filters the live provider catalog', async ({ page }, testInfo) => {
  await installPiCatalog(page);

  const model = page.getByRole('combobox', { name: 'Model' });
  await expect(model).toContainText('Ox Alpha');
  // The filter is part of the model list, not a second field above it.
  await expect(page.getByRole('searchbox', { name: 'Filter models' })).toHaveCount(0);
  await model.click();

  const filter = page.getByRole('searchbox', { name: 'Filter models' });
  await expect(filter).toBeFocused();
  await filter.fill('ox');
  await expect(filter).toBeFocused();
  await expect(filter).toHaveCSS('outline-style', 'none');
  await expect(filter).toHaveCSS('box-shadow', 'none');

  const options = page.getByRole('listbox', { name: 'Models' }).getByRole('option');
  await expect(options).toHaveCount(1);
  await expect(options).toContainText(['Ox Alpha']);
  await expect(page.getByText('1 of 3 models')).toBeVisible();

  // The list opens under the trigger and inside the window.
  const trigger = (await model.boundingBox())!;
  const list = (await page.getByRole('listbox', { name: 'Models' }).boundingBox())!;
  expect(list.y).toBeGreaterThan(trigger.y + trigger.height - 1);
  expect(list.x + list.width).toBeLessThanOrEqual(page.viewportSize()!.width);

  const screenshotPath = process.env.MODEL_FILTER_SCREENSHOT
    ?? testInfo.outputPath('pi-model-filter.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });

  // Esc closes the list and leaves Settings open.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox', { name: 'Models' })).toHaveCount(0);
  await expect(model).toBeFocused();
  await expect(model).toBeVisible();
});

test('a saved API key is a status the size of the buttons beside it', async ({ page }, testInfo) => {
  const settings = await installPiCatalog(page);

  const status = settings.getByText('Key saved', { exact: true });
  await expect(status).toBeVisible();
  await expect(settings.getByLabel('OpenRouter API key')).toHaveCount(0);
  const boxes = await Promise.all([
    status.boundingBox(),
    ...['Verify', 'Replace…', 'Clear'].map((name) => settings.getByRole('button', { name, exact: true }).boundingBox()),
  ]);
  const [statusBox, ...buttonBoxes] = boxes.map((box) => box!);
  for (const box of buttonBoxes) {
    expect(Math.abs(box.height - statusBox.height)).toBeLessThan(0.5);
    expect(Math.abs((box.y + box.height / 2) - (statusBox.y + statusBox.height / 2))).toBeLessThan(0.5);
  }
  const font = (locator: typeof status) => locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.fontSize, style.lineHeight, style.paddingTop, style.paddingLeft, style.borderTopWidth, style.borderTopLeftRadius];
  });
  expect(await font(status)).toEqual(await font(settings.getByRole('button', { name: 'Verify', exact: true })));
  await page.screenshot({ path: testInfo.outputPath('api-key-saved.png'), fullPage: true });

  await settings.getByRole('button', { name: 'Replace…', exact: true }).click();
  const field = settings.getByLabel('OpenRouter API key');
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute('type', 'password');
  const fieldBox = (await field.boundingBox())!;
  const saveBox = (await settings.getByRole('button', { name: 'Save key', exact: true }).boundingBox())!;
  expect(Math.abs(fieldBox.height - saveBox.height)).toBeLessThan(1);
  await page.screenshot({ path: testInfo.outputPath('api-key-replacing.png'), fullPage: true });
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(settings.getByLabel('OpenRouter API key')).toHaveCount(0);
});
