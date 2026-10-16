import { expect, test } from '@playwright/test';
import { bootWithWorkspace, sseBody } from '../fixtures/mockApi';
import { installComposerModels } from '../fixtures/composerModels';

test('selects Google Gemini 4 Argon with its three effort levels and saves Home defaults', async ({ page }, testInfo) => {
  const { status, ensures } = await installComposerModels(page);
  const providers = [{ id: 'google', label: 'Google AI', keyLabel: 'Gemini API key', envVars: ['GEMINI_API_KEY'], defaultModel: 'gemini-4-argon', supportsReasoning: true, hasKey: true }];
  Object.assign(status, { runtime: 'pi', label: 'Pi', provider: 'google', model: 'gemini-4-argon', reasoning: 'medium', providers,
    capabilities: { ...status.capabilities, providerModels: true, apiKeys: true } });
  for (const endpoint of ['models', 'runtime-catalog']) {
    await page.route(`**/api/agent/${endpoint}*`, async (route) => {
      await route.fulfill({ json: { models: [
        { id: 'gemini-4-argon', label: 'Gemini 4 Argon', supportsReasoning: true, supportedReasoningLevels: ['low', 'medium', 'high'], defaultReasoning: 'medium', contextWindow: 1_048_576 },
        { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview' },
      ], providers, capabilities: status.capabilities, sanitizedModel: null } });
    });
  }
  await bootWithWorkspace(page, 'Argon binding');
  const trigger = page.getByRole('button', { name: /^Model settings:/ });
  await trigger.click();
  const picker = page.getByRole('dialog', { name: 'Model settings' });
  await expect(trigger).toContainText('Gemini 4 Argon');
  await expect(picker.getByRole('button', { name: /Select provider: Google AI/ })).toBeVisible();
  await picker.getByRole('button', { name: /Select model:/ }).click();
  await picker.getByRole('menuitemradio', { name: /^Gemini 4 Argon/ }).click();
  const effort = picker.getByRole('slider', { name: 'Thinking effort' });
  await expect(effort).toHaveAttribute('max', '2');
  await expect(picker.locator('.composer-picker-effort-stops span')).toHaveCount(3);
  await expect(picker.locator('.composer-picker-effort-extents')).toHaveText('LowHigh');
  await expect(picker.getByText('Minimal', { exact: true })).toHaveCount(0);
  await expect(picker.getByText('Max', { exact: true })).toHaveCount(0);
  await effort.focus();
  await effort.press('Home');
  await expect(trigger).toContainText('Low');
  await effort.press('End');
  await expect(trigger).toContainText('High');
  await expect(effort).toHaveValue('2');
  await picker.screenshot({ path: testInfo.outputPath('argon-adaptive-effort.png') });
  await effort.press('ArrowLeft');
  await expect(trigger).toContainText('Medium');
  await page.keyboard.press('Escape');
  await page.locator('[contenteditable="true"]').first().fill('Use Gemini Argon');
  await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect.poll(() => ensures.length).toBe(1);
  // Home sends with the saved backend defaults; explicit pane overrides are
  // covered by the existing tests below.
  expect(status).toMatchObject({ runtime: 'pi', provider: 'google', model: 'gemini-4-argon', reasoning: 'medium' });
});

test('shows the Claude catalog label before opening the picker in Home and a new pane', async ({ page }) => {
  const { status, ensures, patches } = await installComposerModels(page);
  status.runtime = 'claude';
  status.label = 'Claude';
  status.model = 'global.anthropic.claude-opus-5-5[1m]';
  const catalogRequests: string[] = [];
  for (const endpoint of ['models', 'runtime-catalog']) {
    await page.route(`**/api/agent/${endpoint}*`, async (route) => {
      catalogRequests.push(endpoint);
      await route.fulfill({ json: { models: [{ id: status.model, label: 'Opus (1M context)' }],
        providers: [], capabilities: status.capabilities, sanitizedModel: null } });
    });
  }
  await page.route('**/api/chats/*/message', async (route) => {
    await route.fulfill({ contentType: 'text/event-stream', body: sseBody([
      { event: 'context_usage', data: { contextUsagePercentage: 45 } },
      { event: 'chunk', data: { text: 'Claude reply.' } },
      { event: 'context_usage', data: { contextUsagePercentage: 8 } },
      { event: 'usage_summary', data: { contextUsagePercentage: 8 } },
      { event: 'done', data: { stopReason: 'end_turn' } },
    ]) });
  });
  await bootWithWorkspace(page, 'Claude composer labels');
  const trigger = page.getByRole('button', { name: /^Model settings:/ });
  await expect(trigger).toContainText('Opus (1M context)');
  await expect(page.getByRole('dialog', { name: 'Model settings' })).toHaveCount(0);
  await expect.poll(() => catalogRequests.length).toBeGreaterThan(0);
  await page.locator('[contenteditable="true"]').first().fill('Check the Claude pane label');
  await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect(page.getByText('Claude reply.').first()).toBeVisible();
  await expect(trigger).toContainText('Opus (1M context)');
  await expect(page.getByRole('meter')).toHaveAttribute('aria-valuenow', '8');
  await trigger.click();
  await expect(page.getByRole('dialog', { name: 'Model settings' })).toBeVisible();
  await page.keyboard.press('Escape');
  await trigger.click();
  await expect(page.getByRole('dialog', { name: 'Model settings' })).toBeVisible();
  await page.keyboard.press('Escape');
  // The store separately fetches /models once at startup to sanitize saved IDs.
  // Home, the new pane and repeated picker opens share one runtime catalog request.
  expect(catalogRequests.filter((endpoint) => endpoint === 'runtime-catalog')).toEqual(['runtime-catalog']);
  await page.locator('[contenteditable="true"]').first().fill('Continue with the same model');
  await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect.poll(() => ensures.length).toBe(2);
  expect(ensures[1]).toMatchObject({ runtimeId: 'claude', modelId: 'global.anthropic.claude-opus-5-5[1m]' });
  expect(patches).toEqual([]);
});

test('saves model and effort as Home defaults and preserves the draft', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { ensures, patches, status } = await installComposerModels(page);
  await bootWithWorkspace(page, 'Composer interaction checks');
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.fill('Review the Composer interaction');
  const trigger = page.getByRole('button', { name: /^Model settings:/ });
  await trigger.click();
  const picker = page.getByRole('dialog', { name: 'Model settings' });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('button').first()).toHaveAttribute('data-picker-page', 'runtime');
  await expect(picker.getByRole('button').nth(1)).toHaveAttribute('data-picker-page', 'model');
  await expect(picker.getByRole('button').first()).toBeFocused();
  await picker.getByRole('button', { name: /Select model:/ }).click();
  await page.getByRole('menuitemradio', { name: 'GPT-5.3 Codex', exact: true }).click();
  await expect(trigger).toContainText('GPT-5.3 Codex');
  const effort = picker.getByRole('slider', { name: 'Thinking effort' });
  await effort.focus();
  await effort.press('ArrowRight');
  await expect(trigger).toContainText('High');
  await expect(effort).toBeFocused();
  await expect(picker).toBeVisible();
  await expect(editor).toHaveText('Review the Composer interaction');
  await page.screenshot({ path: testInfo.outputPath('composer-model-picker-desktop.png'), fullPage: true });
  await picker.screenshot({ path: testInfo.outputPath('composer-model-picker-detail.png') });
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(picker).toBeHidden();
  await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect.poll(() => ensures.length).toBe(1);
  // Home uses the saved global defaults; pane overrides are exercised below.
  expect(status).toMatchObject({ runtime: 'codex', model: 'gpt-5.3-codex', reasoning: 'high' });
  expect(patches).toEqual([{ model: 'gpt-5.3-codex', expectedRuntime: 'codex' }, { reasoning: 'high', expectedRuntime: 'codex' }]);
  expect(errors).toEqual([]);
});

test('changes a pane runtime without changing global defaults, then loads that runtime catalog', async ({ page }) => {
  const { ensures, patches, catalogRequests } = await installComposerModels(page, { catalogDelay: 100 });
  await bootWithWorkspace(page);
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.fill('Start a conversation');
  await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect(page.getByText('Hello from mock kiro.').first()).toBeVisible();
  await page.getByRole('button', { name: /^Model settings:/ }).click();
  const picker = page.getByRole('dialog', { name: 'Model settings' });
  await picker.getByRole('button', { name: /Select runtime:/ }).click();
  await page.getByRole('menuitemradio', { name: 'Claude', exact: true }).click();
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('button', { name: /Select runtime: Claude/ })).toBeVisible();
  await expect.poll(() => catalogRequests.includes('claude')).toBe(true);
  await picker.getByRole('button', { name: /Select model:/ }).click();
  await page.getByRole('menuitemradio', { name: 'Claude Sonnet 4.6', exact: true }).click();
  await expect(picker.getByRole('button', { name: 'Select model: Claude Sonnet 4.6' })).toBeVisible();
  await page.keyboard.press('Escape');
  await editor.fill('Continue with the selected runtime');
  await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect.poll(() => ensures.length).toBe(2);
  expect(ensures[1]).toMatchObject({ runtimeId: 'claude', modelId: 'claude-sonnet-4-6' });
  expect(patches).toHaveLength(0);
});

test('supports provider search, trigger toggle, and a failed-save retry', async ({ page }) => {
  await installComposerModels(page, { failSave: true });
  await bootWithWorkspace(page);
  const trigger = page.getByRole('button', { name: /^Model settings:/ });
  await trigger.click();
  const picker = page.getByRole('dialog', { name: 'Model settings' });
  await picker.getByRole('button', { name: /Select runtime:/ }).click();
  await page.getByRole('menuitemradio', { name: 'Pi', exact: true }).click();
  await expect(picker.getByRole('alert')).toHaveText('Model settings could not be saved');
  await page.getByRole('menuitemradio', { name: 'Pi', exact: true }).click();
  await expect(picker.getByRole('button', { name: /Select provider:/ })).toBeVisible();
  await picker.getByRole('button', { name: /Select provider:/ }).click();
  await page.getByRole('menuitemradio', { name: 'OpenAI', exact: true }).click();
  await expect(picker.getByRole('button', { name: /Select provider: OpenAI/ })).toBeVisible();
  await picker.getByRole('button', { name: /Select model:/ }).click();
  await page.getByRole('searchbox', { name: 'Search models' }).fill('Model 11');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(trigger).toContainText('Provider Model 11');
  await trigger.click();
  await expect(picker).toBeHidden();
});

test('stays inside a narrow viewport and supports reduced motion', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installComposerModels(page);
  await bootWithWorkspace(page);
  const trigger = page.getByRole('button', { name: /^Model settings:/ });
  await trigger.click();
  const picker = page.getByRole('dialog', { name: 'Model settings' });
  // Catalog hydration can reveal effort and reposition the popover. Compare
  // both rows in one layout snapshot rather than across that transition.
  await expect.poll(() => picker.evaluate((surface) => {
    const runtimeBox = surface.querySelector('[data-picker-page="runtime"]')!.getBoundingClientRect();
    const modelBox = surface.querySelector('[data-picker-page="model"]')!.getBoundingClientRect();
    return runtimeBox.bottom - modelBox.top;
  })).toBeLessThanOrEqual(0);
  const box = await picker.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(8);
  expect(box!.x + box!.width).toBeLessThanOrEqual(382);
  expect(box!.y).toBeGreaterThanOrEqual(8);
  expect(box!.y + box!.height).toBeLessThanOrEqual(836);
  const send = await page.getByRole('button', { name: 'Send (Enter)', exact: true }).boundingBox();
  expect(send!.x + send!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('composer-model-picker-mobile.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});

test('adapts effort to model capabilities and sends a valid pane override', async ({ page }, testInfo) => {
  const { ensures } = await installComposerModels(page);
  await bootWithWorkspace(page, 'Adaptive effort');
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.fill('Start the model capability check');
  await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect(page.getByText('Hello from mock kiro.').first()).toBeVisible();
  const trigger = page.getByRole('button', { name: /^Model settings:/ });
  await trigger.click();
  const picker = page.getByRole('dialog', { name: 'Model settings' });
  const selectModel = async (name: string) => {
    await picker.getByRole('button', { name: /Select model:/ }).click();
    await picker.getByRole('menuitemradio', { name, exact: true }).click();
    await expect(picker.getByRole('button', { name: `Select model: ${name}` })).toBeVisible();
  };
  await selectModel('Extended model');
  const effort = picker.getByRole('slider', { name: 'Thinking effort' });
  await expect(effort).toHaveAttribute('max', '5');
  await effort.press('End');
  await expect(trigger).toContainText('Max');
  await picker.screenshot({ path: testInfo.outputPath('effort-six-levels.png') });
  await selectModel('Limited model');
  await expect(effort).toHaveAttribute('max', '2');
  await expect(effort).toHaveAttribute('aria-valuetext', 'High');
  await expect(trigger).not.toContainText('Max');
  await selectModel('Fixed model');
  await expect(effort).toHaveCount(0);
  await expect(trigger).not.toContainText('High');
  await selectModel('Instant model');
  await expect(effort).toHaveCount(0);
  await expect(picker.getByText('Thinking effort', { exact: true })).toHaveCount(0);
  await expect(trigger).not.toContainText('High');
  await picker.screenshot({ path: testInfo.outputPath('effort-hidden.png') });
  await page.keyboard.press('Escape');
  await editor.fill('Continue without adjustable effort');
  await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect.poll(() => ensures.length).toBe(2);
  expect(ensures[1]).toMatchObject({ modelId: 'instant', reasoning: null });
});

test('hides effort when the selected provider does not support it', async ({ page }) => {
  await installComposerModels(page);
  await bootWithWorkspace(page);
  const trigger = page.getByRole('button', { name: /^Model settings:/ });
  await trigger.click();
  const picker = page.getByRole('dialog', { name: 'Model settings' });
  await picker.getByRole('button', { name: /Select runtime:/ }).click();
  await picker.getByRole('menuitemradio', { name: 'Pi', exact: true }).click();
  await picker.getByRole('button', { name: /Select provider:/ }).click();
  await picker.getByRole('menuitemradio', { name: 'Local', exact: true }).click();
  await expect(picker.getByRole('slider')).toHaveCount(0);
  await expect(trigger).not.toContainText('Medium');
});

test('keeps search and Back reachable while scrolling and filtering Pi models', async ({ page }, testInfo) => {
  await installComposerModels(page);
  await bootWithWorkspace(page);
  await page.getByRole('button', { name: /^Model settings:/ }).click();
  const picker = page.getByRole('dialog', { name: 'Model settings' });
  await picker.getByRole('button', { name: /Select runtime:/ }).click();
  await picker.getByRole('menuitemradio', { name: 'Pi', exact: true }).click();
  await picker.getByRole('button', { name: /Select model:/ }).click();
  const back = picker.getByRole('button', { name: 'Back to model settings' });
  const search = picker.getByRole('searchbox', { name: 'Search models' });
  await expect(search).toBeFocused();
  await expect(search).toHaveCSS('outline-style', 'none');
  await expect(search).toHaveCSS('box-shadow', 'none');
  // Same quiet field as the workspace / agent menus: no box, divider below.
  await expect(search).toHaveCSS('border-top-width', '0px');
  await expect(search).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(search.locator('xpath=..')).toHaveClass(/\bmichi-menu-search\b/);
  const originalBack = await back.boundingBox();
  const originalSearch = await search.boundingBox();
  const originalPicker = await picker.boundingBox();
  await picker.getByRole('menuitemradio').last().scrollIntoViewIfNeeded();
  await expect(picker.getByRole('menuitemradio').last()).toBeInViewport();
  await expect(back).toBeInViewport();
  await expect(search).toBeInViewport();
  expect(await back.boundingBox()).toEqual(originalBack);
  expect(await search.boundingBox()).toEqual(originalSearch);
  await picker.screenshot({ path: testInfo.outputPath('pi-model-search-scrolled.png') });
  await back.click();
  await expect(picker.getByRole('button', { name: /Select model:/ })).toBeFocused();
  await picker.getByRole('button', { name: /Select model:/ }).click();
  for (const query of ['Model 11', 'no matching model']) {
    await search.fill(query);
    await expect(picker.getByRole('menuitemradio')).toHaveCount(query === 'Model 11' ? 1 : 0);
    expect(await back.boundingBox()).toEqual(originalBack);
    expect(await picker.boundingBox()).toEqual(originalPicker);
    await back.click();
    await expect(picker.getByRole('button', { name: /Select model:/ })).toBeFocused();
    await picker.getByRole('button', { name: /Select model:/ }).click();
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();
  }
  await search.press('Escape');
  await expect(picker.getByRole('button', { name: /Select model:/ })).toBeFocused();
});

test('excludes the compact searchable picker from native window dragging', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await installComposerModels(page);
  await bootWithWorkspace(page);
  await page.getByRole('button', { name: /^Model settings:/ }).click();
  const picker = page.getByRole('dialog', { name: 'Model settings' });
  await picker.getByRole('button', { name: /Select runtime:/ }).click();
  await picker.getByRole('menuitemradio', { name: 'Pi', exact: true }).click();
  await picker.getByRole('button', { name: /Select model:/ }).click();
  await expect(picker.getByRole('searchbox')).toBeFocused();
  const back = picker.getByRole('button', { name: 'Back to model settings' });
  const box = (await back.boundingBox())!;
  const topbar = page.locator('.terminal-topbar');
  await expect(picker.locator('.composer-picker-content')).toHaveCSS('max-height', '240px');
  // Browser-injected clicks bypass native hit testing. Guard Electron's
  // no-drag exclusion explicitly, then exercise the visible button by pointer.
  await expect(topbar).toHaveCSS('-webkit-app-region', 'drag');
  await expect(picker).toHaveCSS('-webkit-app-region', 'no-drag');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(back).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await picker.screenshot({ path: testInfo.outputPath('model-picker-back-hover.png') });
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(picker.getByRole('button', { name: /Select model:/ })).toBeFocused();
  await expect(picker.getByRole('searchbox')).toHaveCount(0);
});

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
  test(`shows two-line runtime, provider and model summaries at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await installComposerModels(page);
    await bootWithWorkspace(page);
    await page.getByRole('button', { name: /^Model settings:/ }).click();
    const picker = page.getByRole('dialog', { name: 'Model settings' });
    await picker.getByRole('button', { name: /Select runtime:/ }).click();
    await picker.getByRole('menuitemradio', { name: 'Pi', exact: true }).click();
    const rows = picker.locator('[data-picker-page]');
    await expect(rows).toHaveCount(3);
    expect(await rows.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-picker-page')))).toEqual(['runtime', 'provider', 'model']);
    for (const row of await rows.all()) {
      const caption = await row.locator('.composer-picker-caption').boundingBox();
      const value = await row.locator('.composer-picker-value').boundingBox();
      expect(caption!.y + caption!.height).toBeLessThan(value!.y);
      expect(caption!.x).toBe(value!.x);
    }
    const content = picker.locator('.composer-picker-content');
    expect(await content.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    const box = await picker.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(8);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(box!.y).toBeGreaterThanOrEqual(8);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height - 8);
    await picker.screenshot({ path: testInfo.outputPath(`pi-overview-${viewport.width}.png`) });
    await page.screenshot({ path: testInfo.outputPath(`pi-overview-page-${viewport.width}.png`), fullPage: true });
    await picker.getByRole('button', { name: /Select model:/ }).click();
    const back = picker.getByRole('button', { name: 'Back to model settings' });
    const search = picker.getByRole('searchbox');
    await expect(search).toHaveCSS('outline-style', 'none');
    await expect(search).toHaveCSS('box-shadow', 'none');
    await picker.getByRole('menuitemradio').last().scrollIntoViewIfNeeded();
    await expect(back).toBeInViewport();
    await expect(search).toBeInViewport();
    await search.fill('no match');
    await expect(picker.getByRole('status')).toHaveText('No matching models');
    await picker.screenshot({ path: testInfo.outputPath(`pi-search-empty-${viewport.width}.png`) });
    await back.click();
    await expect(picker.getByRole('button', { name: /Select model:/ })).toBeFocused();
  });
}
