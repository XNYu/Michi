import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { installComposerModels } from '../fixtures/composerModels';
import { bootWithWorkspace } from '../fixtures/mockApi';

async function bootComposer(page: Page, palette: 'bone' | 'monokai' = 'bone') {
  const { status } = await installComposerModels(page);
  status.capabilities = { ...status.capabilities, modes: true };
  await page.route(/\/api\/prefs$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({ json: { prefs: { onboardingCompletedAt: 1, terminalPalette: palette } } });
  });
  await bootWithWorkspace(page, 'Composer controls');
  await expect(page.locator('html')).toHaveAttribute('data-terminal-palette', palette);
}

async function finishHover(control: Locator) {
  await control.hover();
  await expect.poll(() => control.evaluate((element) => element.getAnimations()
    .filter((animation) => animation.playState === 'running').length)).toBe(0);
}

async function assertSendUnchanged(composer: Locator) {
  const send = composer.getByRole('button', { name: 'Send (Enter)', exact: true });
  await expect(send).toHaveClass('t-action-btn is-primary');
  await expect(send).toHaveCSS('border-radius', '2px');
  await expect(send).toHaveCSS('border-width', '1px');
  await expect(send).toHaveCSS('width', '30px');
  await expect(send).toHaveCSS('height', '30px');
  await expect(send).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
}

async function assertControls(page: Page, info: TestInfo, stage: string) {
  const composer = page.locator('.terminal-composer').first();
  const model = composer.getByRole('button', { name: /^Model settings:/ });
  await finishHover(model);
  const fill = await model.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(fill).not.toBe('rgba(0, 0, 0, 0)');
  const controls = composer.locator('.t-toolbar-chip, .t-action-btn.is-outline');
  for (const [index, control] of (await controls.all()).entries()) {
    await page.mouse.move(1, 1);
    await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const restingBounds = await control.boundingBox();
    await expect(control).toHaveCSS('border-radius', '4px');
    await expect(control).toHaveCSS('border-width', '0px');
    await expect(control).toHaveCSS('transition-duration', '0.12s, 0.12s, 0.12s');
    await finishHover(control);
    await expect(control).toHaveCSS('background-color', fill);
    await expect(control).toHaveCSS('border-width', '0px');
    await expect(control).toHaveCSS('box-shadow', 'none');
    expect(await control.boundingBox()).toEqual(restingBounds);
    await composer.screenshot({ path: info.outputPath(`${stage}-hover-${index}.png`) });
  }
  await assertSendUnchanged(composer);
  return fill;
}

for (const palette of ['bone', 'monokai'] as const) {
  test(`${palette}: Home and pane controls share the model hover with topbar corners`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await bootComposer(page, palette);
    const composer = page.locator('.terminal-composer').first();
    const editor = composer.locator('[contenteditable="true"]');
    await editor.fill('Review the Composer controls');
    await expect(composer.locator('.t-toolbar-chip')).toHaveCount(5);
    await expect(page.getByRole('button', { name: 'Search', exact: true })).toHaveCSS('border-radius', '4px');
    const fill = await assertControls(page, info, 'home');

    const model = composer.getByRole('button', { name: /^Model settings:/ });
    await model.click();
    await page.mouse.move(1, 1);
    await expect(model).toHaveAttribute('aria-expanded', 'true');
    await expect(model).toHaveCSS('background-color', fill);
    await page.keyboard.press('Escape');
    await expect(model).toBeFocused();
    await expect(model).toHaveCSS('outline-style', 'solid');

    await composer.getByTitle('Mention context or node', { exact: true }).click();
    await expect(editor).toContainText('@');
    await editor.fill('Review the Composer controls');
    await composer.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
    await expect(page.getByText('Hello from mock kiro.').first()).toBeVisible();
    await editor.fill('Continue in a branch');
    await assertControls(page, info, 'pane');
    const branch = composer.getByRole('button', { name: /^Branch/ });
    await finishHover(branch);
    await expect(branch.locator('.t-action-kbd')).toHaveCSS('opacity', '1');
    await expect(branch.locator('.t-action-kbd')).toHaveCSS('border-radius', '2px');
    await page.screenshot({ path: info.outputPath('pane-hover-page.png'), fullPage: true });
  });
}

test('compact controls keep their geometry and respect reduced motion', async ({ page }, info) => {
  await bootComposer(page);
  const composer = page.locator('.terminal-composer').first();
  const editor = composer.locator('[contenteditable="true"]');
  await editor.fill('Start a narrow pane');
  await composer.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect(page.getByText('Hello from mock kiro.').first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await editor.fill('Check compact controls');
  const frame = (await composer.boundingBox())!;
  for (const control of await composer.locator('.t-toolbar-chip, .t-action-btn.is-outline').all()) {
    await finishHover(control);
    await expect(control).toHaveCSS('border-radius', '4px');
    await expect(control).toHaveCSS('border-width', '0px');
    await expect(control).toHaveCSS('transition-duration', '0s');
    const bounds = (await control.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(frame.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(frame.x + frame.width);
  }
  await assertSendUnchanged(composer);
  await page.screenshot({ path: info.outputPath('composer-hover-mobile.png'), fullPage: true });
});

test('disabled model settings stay quiet while stop and queued Send keep their styles', async ({ page }, info) => {
  await bootComposer(page, 'monokai');
  const composer = page.locator('.terminal-composer').first();
  const editor = composer.locator('[contenteditable="true"]');
  await editor.fill('Start the conversation');
  await composer.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect(page.getByText('Hello from mock kiro.').first()).toBeVisible();
  let release = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/api\/chats\/[^/]+\/message$/, async (route) => {
    await pending;
    await route.fallback();
  });
  try {
    await editor.fill('Keep this turn pending');
    await composer.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
    const stop = composer.getByRole('button', { name: 'Stop stream', exact: true });
    await expect(stop).toBeVisible();
    await expect(stop).toHaveClass('t-action-btn is-primary');
    await expect(stop).toHaveCSS('border-radius', '2px');
    const model = composer.getByRole('button', { name: /^Model settings:/ });
    await expect(model).toBeDisabled();
    await finishHover(model);
    await expect(model).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(model).toHaveCSS('border-width', '0px');
    await expect(model).toHaveCSS('opacity', '0.45');
    await editor.fill('Queue the next turn');
    const queue = composer.getByRole('button', { name: /^Send next/ });
    await expect(queue).toHaveClass('t-action-btn is-queue');
    await expect(queue).toHaveCSS('border-radius', '2px');
    await expect(queue).toHaveCSS('border-width', '1px');
    await composer.screenshot({ path: info.outputPath('streaming-controls.png') });
  } finally {
    release();
  }
  await expect(composer.getByRole('button', { name: 'Send (Enter)', exact: true })).toBeVisible();
});
